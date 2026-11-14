//! Fork: helper sessions (specs/fork-rust-node-helper.md F3, "Session open and close"). Before the first forwarded
//! session call, and before the first helper tool call of a session, in each helper generation, Rust opens the session
//! in the helper with `helper/session/open`; `helper/session/close` ends it when Rust closes the session.
//!
//! Owner: an open session lives in the [`super::Running`] slot of its generation, so a crash or reclaim forgets it and
//! the next generation opens it again lazily. An open session keeps the helper from idle reclaim.

use std::sync::Arc;
use std::sync::atomic::Ordering;

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

/// One session's open in a generation, holding its `openId`: concurrent first calls share it; a failed open leaves it
/// unset for a retry.
pub(super) type Opening = Arc<tokio::sync::OnceCell<u64>>;

/// Closes an open that Rust gave up on (its timeout, or the caller dropping it): the helper may still finish it, and
/// nothing in Rust would own that session. Disarmed once the helper answered.
struct AbandonedOpen<'a> {
    helper: &'a NodeHelper,
    peer: &'a Peer,
    session: &'a str,
    open_id: Option<u64>,
}

impl Drop for AbandonedOpen<'_> {
    fn drop(&mut self) {
        if let Some(open_id) = self.open_id.take()
            && !self.peer.is_closed()
        {
            self.helper.send_close(self.peer, self.session, open_id);
        }
    }
}

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
        let mut forgotten = None;
        self.with_running(generation, |running| {
            let current = running.sessions.get(session);
            match result {
                Err(_) => {
                    if current.is_some_and(|known| Arc::ptr_eq(known, &cell)) {
                        running.sessions.remove(session);
                    }
                }
                // Closed while this open was in flight, and not opened again since: the helper has a session that
                // nothing would close. A newer entry is a reopen, which its own close ends.
                Ok(open_id)
                    if opened_here.load(std::sync::atomic::Ordering::Relaxed)
                        && current.is_none() =>
                {
                    forgotten = Some(open_id);
                }
                Ok(_) => {}
            }
        });
        if let Some(open_id) = forgotten {
            self.send_close(peer, session, open_id);
        }
        result.map(|_| ())
    }

    async fn open_session(
        &self,
        generation: u64,
        peer: &Peer,
        session: &str,
    ) -> Result<u64, RpcError> {
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
        let open_id = self.last_open.fetch_add(1, Ordering::Relaxed) + 1;
        let mut params = json!({
            "sessionId": session,
            "openId": open_id,
            "workspace": workspace,
            "pluginIds": catalog.plugin_ids,
            "servers": catalog.servers,
        });
        // Node's app runs an execution worktree session in its worktree (create-app.ts:200-208).
        if let Some(directory) = answers.session_execution_directory(session).await {
            params["executionDirectory"] = Value::String(directory);
        }
        let mut abandoned = AbandonedOpen {
            helper: self,
            peer,
            session,
            open_id: Some(open_id),
        };
        let deadline = self.timing.timeout_for(OPEN);
        let answer = tokio::time::timeout(deadline, peer.request(OPEN, &params)).await;
        if answer.is_ok() {
            // The helper answered: it keeps nothing of a failed open.
            abandoned.open_id = None;
        }
        match answer {
            Ok(Ok(_)) => {
                self.heard(generation);
                Ok(open_id)
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
                    opening
                        .get()
                        .map(|open_id| (running.peer.clone(), *open_id))
                }
                None => None,
            }
        };
        if let Some((peer, open_id)) = peer {
            self.send_close(&peer, session, open_id);
        }
    }

    /// Closes one open of `session`: the helper ignores a close whose `openId` is not the session's open one.
    fn send_close(&self, peer: &Peer, session: &str, open_id: u64) {
        let peer = peer.clone();
        let params = json!({"sessionId": session, "openId": open_id});
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
