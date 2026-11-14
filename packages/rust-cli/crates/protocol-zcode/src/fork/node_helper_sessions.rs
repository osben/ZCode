//! Fork: helper sessions (specs/fork-rust-node-helper.md F3, "Session open and close"). Before the first forwarded
//! session call, and before the first helper tool call of a session, in each helper generation, Rust opens the session
//! in the helper with `helper/session/open`; `helper/session/close` ends it when Rust closes the session.
//!
//! Owner: an open session lives in the [`super::Running`] slot of its generation, so a crash or reclaim forgets it and
//! the next generation opens it again lazily. An open session keeps the helper from idle reclaim.

use std::sync::Arc;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_protocol_core::connection::{CONNECTION_CLOSED, Peer};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use super::{NodeHelper, Slot, unavailable};

const OPEN: &str = "helper/session/open";
const CLOSE: &str = "helper/session/close";

/// The forwarded methods that always name a session: the 16 `mcp/ui*` methods, `mcp/readResource` and
/// `plugins/mentionItems`.
pub(crate) const SESSION_METHODS: &[&str] = &[
    "mcp/uiOpenInstance",
    "mcp/uiValidateInstance",
    "mcp/uiCloseInstance",
    "mcp/uiReadResource",
    "mcp/uiListResources",
    "mcp/uiListResourceTemplates",
    "mcp/uiSubscribeResource",
    "mcp/uiUnsubscribeResource",
    "mcp/uiCallTool",
    "mcp/uiCancelCall",
    "mcp/uiSampling",
    "mcp/uiCancelSampling",
    "mcp/uiRegisterAppTools",
    "mcp/uiUnregisterAppTools",
    "mcp/uiClaimAppToolCall",
    "mcp/uiResolveAppToolCall",
    "mcp/readResource",
    "plugins/mentionItems",
];

/// Session-scoped only with a `sessionId` (the session's frozen catalog); a draft's catalog stays sessionless (F1).
const CATALOG_METHODS: &[&str] = &[
    "plugins/referenceCatalog",
    "plugins/referenceCatalogWithCategory",
];

/// The session a forwarded call runs in, when the method is session-scoped. An empty or missing id of a
/// [`SESSION_METHODS`] method is `Some("")`, refused before forwarding.
pub(crate) fn session_of<'a>(method: &str, params: &'a Value) -> Option<&'a str> {
    let session = params.get("sessionId").and_then(Value::as_str);
    if SESSION_METHODS.contains(&method) {
        return Some(session.unwrap_or_default());
    }
    if CATALOG_METHODS.contains(&method) {
        return session.filter(|session| !session.is_empty());
    }
    None
}

/// What Rust admitted in this process, sent with every session open. It names no workspace: a session opens with its
/// own, never the agent's cwd.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HelperCatalog {
    /// Every plugin Rust admitted (the helper enables only these in the session's reference catalog).
    pub plugin_ids: Vec<String>,
    /// The admitted plugins whose servers are helper-hosted.
    pub helper_plugins: Vec<String>,
    /// The helper-hosted server names (`plugin:<plugin>:<server>`).
    pub servers: Vec<String>,
}

impl HelperCatalog {
    /// Adds one admitted plugin with its helper-hosted servers (none for a plugin whose servers Rust runs).
    pub fn admit(&mut self, plugin_id: &str, helper_servers: Vec<String>) {
        self.plugin_ids.push(plugin_id.to_owned());
        if !helper_servers.is_empty() {
            self.helper_plugins.push(plugin_id.to_owned());
            self.servers.extend(helper_servers);
        }
    }
}

/// One session's open in a generation: concurrent first calls share it; a failed open leaves it unset for a retry.
pub(super) type Opening = Arc<tokio::sync::OnceCell<()>>;

impl NodeHelper {
    /// Sets what Rust admitted, once its plugins are loaded. Session calls before it are unavailable.
    pub fn set_catalog(&self, catalog: HelperCatalog) {
        *self.catalog.lock_unpoisoned() = Some(Arc::new(catalog));
    }

    pub(crate) fn catalog(&self) -> Option<Arc<HelperCatalog>> {
        self.catalog.lock_unpoisoned().clone()
    }

    /// Opens `session` on `generation` unless it is open there.
    pub(super) async fn ensure_session(
        &self,
        generation: u64,
        peer: &Peer,
        session: &str,
    ) -> Result<(), RpcError> {
        let mut cell = None;
        self.with_running(generation, |running| {
            cell = Some(
                running
                    .sessions
                    .entry(session.to_owned())
                    .or_default()
                    .clone(),
            );
        });
        let Some(cell) = cell else {
            return Err(unavailable("the helper exited"));
        };
        let opened_here = std::sync::atomic::AtomicBool::new(false);
        let result = cell
            .get_or_try_init(|| {
                opened_here.store(true, std::sync::atomic::Ordering::Relaxed);
                self.open_session(generation, peer, session)
            })
            .await
            .copied();
        let mut forgotten = false;
        self.with_running(generation, |running| {
            let current = running.sessions.get(session);
            if result.is_err() {
                if current.is_some_and(|known| Arc::ptr_eq(known, &cell)) {
                    running.sessions.remove(session);
                }
            } else if opened_here.load(std::sync::atomic::Ordering::Relaxed) {
                // Closed while this open was in flight, and not opened again since: the helper has a session that
                // nothing would close. A newer entry is a reopen, which a close would end.
                forgotten = current.is_none();
            }
        });
        if forgotten {
            self.send_close(peer, session);
        }
        result
    }

    async fn open_session(
        &self,
        generation: u64,
        peer: &Peer,
        session: &str,
    ) -> Result<(), RpcError> {
        let Some(catalog) = self.catalog() else {
            return Err(unavailable("the helper has no plugin catalog yet"));
        };
        let Some(answers) = self.answers() else {
            return Err(unavailable("the agent does not answer helper requests yet"));
        };
        // The session's own workspace: one agent may serve several (the Host's shared local task runtime).
        let Some(workspace) = answers.session_workspace(session).await else {
            return Err(unavailable("the session's workspace is unknown"));
        };
        let params = json!({
            "sessionId": session,
            "workspace": workspace,
            "pluginIds": catalog.plugin_ids,
            "servers": catalog.servers,
        });
        let deadline = self.timing.timeout_for(OPEN);
        match tokio::time::timeout(deadline, peer.request(OPEN, &params)).await {
            Ok(Ok(_)) => {
                self.heard(generation);
                Ok(())
            }
            Ok(Err(error)) if error.code == CONNECTION_CLOSED && peer.is_closed() => {
                self.link_lost(generation);
                Err(unavailable("the helper connection closed"))
            }
            Ok(Err(error)) => {
                self.heard(generation);
                Err(error)
            }
            Err(_elapsed) => Err(unavailable("the helper did not open the session in time")),
        }
    }

    /// Rust closed `session`. When the running generation opened it, the helper closes it too (fire and forget).
    pub fn session_closed(&self, session: &str) {
        let peer = {
            let mut state = self.state.lock_unpoisoned();
            let Slot::Running(running) = &mut state.slot else {
                return;
            };
            running.panels.forget_session(session);
            match running.sessions.remove(session) {
                Some(opening) => {
                    running.last_used = tokio::time::Instant::now();
                    // An open still in flight closes the session itself once it succeeds (`ensure_session`).
                    opening.initialized().then(|| running.peer.clone())
                }
                None => None,
            }
        };
        if let Some(peer) = peer {
            self.send_close(&peer, session);
        }
    }

    fn send_close(&self, peer: &Peer, session: &str) {
        let peer = peer.clone();
        let params = json!({"sessionId": session});
        drop(self.spawner.spawn("node-helper-session-close", async move {
            peer.notify(CLOSE, &params).await;
        }));
    }
}

/// The session bridge's close listener: a session Rust closes ends its helper session (F3 "Session open and close").
/// The helper may be installed after the server is built, so it is looked up at each close.
pub(crate) fn close_listener(
    context: Arc<crate::context::Context>,
) -> rust_cli_protocol_core::sessions::CloseListener {
    Arc::new(move |session| {
        if let Some(helper) = context.node_helper() {
            helper.session_closed(session.as_str());
        }
    })
}
