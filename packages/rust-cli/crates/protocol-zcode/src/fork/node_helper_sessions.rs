//! Fork: helper sessions (specs/fork-rust-node-helper.md F3, "Session open and close"). Before the first forwarded
//! session call, and before the first helper tool call of a session, in each helper generation, Rust opens the session
//! in the helper with `helper/session/open`; `helper/session/close` ends it when Rust closes the session.
//!
//! Owner: an open session lives in the [`super::Running`] slot of its generation, so a crash or reclaim forgets it and
//! the next generation opens it again lazily. An open session keeps the helper from idle reclaim.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::browser_turn::BrowserCandidate;
use rust_cli_protocol_core::connection::{CONNECTION_CLOSED, Peer};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{NodeHelper, Slot, unavailable};

const OPEN: &str = "helper/session/open";
const CLOSE: &str = "helper/session/close";
/// F4-D7: Rust is the only sender of a subagent's browser registration (specs/fork-rust-node-helper.md "F4b").
const CHILD_SESSION: &str = "helper/browser/childSession";
const CHILD_SESSION_END: &str = "helper/browser/childSessionEnd";
/// F4-D5: a turn of an open session ended; the helper's broker runs its turnEnded (specs/fork-rust-node-helper.md F4b).
const TURN_ENDED: &str = "helper/turn/ended";
/// D2-H: the end-of-turn screenshot of the active tab (specs/fork-rust-node-helper.md, "D2 end-of-turn screenshot").
const TURN_SCREENSHOT: &str = "helper/browser/turnScreenshot";
/// C1: the turn's abort reached a capture in flight; the helper aborts it (`helper/browser/turnScreenshotCancel`).
const TURN_SCREENSHOT_CANCEL: &str = "helper/browser/turnScreenshotCancel";

/// Settles a turn-end capture against the turn's cancel. Biased: a ready answer wins over a cancel that is ready in the
/// same tick, so a capture that finished is kept rather than dropped. `None` means the cancel fired first.
pub(super) async fn settle_capture<T>(
    answer: impl std::future::Future<Output = T>,
    cancel: &CancellationToken,
) -> Option<T> {
    tokio::select! {
        biased;
        value = answer => Some(value),
        () = cancel.cancelled() => None,
    }
}

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
    // F3b(b): an app tool call runs in its session's helper session (the set lives in that session's record). Its
    // cancel is not session-scoped: it must not open a session, so it is sent without `ensure_session`.
    "helper/appTools/call",
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

/// What Rust admitted: the plugin ids and the helper-hosted server names one session is opened and admitted against.
/// The process-wide set is installed once its plugins are loaded; a session whose workspace has a loaded layer resolves
/// its own catalog instead (per-workspace admission, the resolver of [`NodeHelper::set_catalog_resolver`]). It names no
/// workspace itself: a session opens with its own, never the agent's cwd.
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

/// Bounds the restarts of [`NodeHelper::ensure_session`]; each one needs another call's open to fail first.
const OPEN_ATTEMPTS: usize = 8;

/// Why one attempt of [`NodeHelper::ensure_session`] did not open the session.
enum Attempt {
    /// The cell this call waited on was removed (its open failed, or Rust closed the session) before the call could
    /// open it: the call starts again from the registered entry.
    Unregistered,
    Failed(RpcError),
}

/// Closes an open that Rust gave up on (its timeout, or the caller dropping it): the helper may still finish it, and
/// nothing in Rust would own that session. Disarmed once the helper answered.
struct AbandonedOpen<'a> {
    helper: &'a NodeHelper,
    peer: &'a Peer,
    session: &'a str,
    open_id: Option<u64>,
    /// The child registration this call may have made and not yet handed to the session's lifecycle. A caller that
    /// drops the open mid-way must end it too, since the helper may already have accepted it.
    child: bool,
}

/// A session call that its caller dropped before the open finished. When no other call waits on that open, its unset
/// cell is forgotten: an entry keeps the helper from idle reclaim. A waiting call takes the open over instead.
struct Waiting<'a> {
    helper: &'a NodeHelper,
    generation: u64,
    session: &'a str,
    cell: Opening,
    done: bool,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        // Clones are taken only under this lock: two references are the map's and this call's.
        self.helper.with_running(self.generation, |running| {
            if running
                .sessions
                .get(self.session)
                .is_some_and(|known| Arc::ptr_eq(known, &self.cell))
                && !self.cell.initialized()
                && Arc::strong_count(&self.cell) == 2
            {
                running.sessions.remove(self.session);
            }
        });
    }
}

impl Drop for AbandonedOpen<'_> {
    fn drop(&mut self) {
        if self.peer.is_closed() {
            return;
        }
        let child = std::mem::take(&mut self.child);
        match self.open_id.take() {
            Some(open_id) => self
                .helper
                .send_close_ending(self.peer, self.session, open_id, child),
            None if child => self.helper.send_child_end(self.peer, self.session),
            None => {}
        }
    }
}

impl NodeHelper {
    /// Sets what Rust admitted, once its plugins are loaded. Session calls before it are unavailable.
    pub fn set_catalog(&self, catalog: HelperCatalog) {
        *self.catalog.lock_unpoisoned() = Some(Arc::new(catalog));
    }

    /// Sets how a session's workspace catalog is resolved (per-workspace admission): installed once at
    /// assembly, before any session opens. The process catalog stays the fallback of a session whose
    /// workspace has no loaded layer.
    pub fn set_catalog_resolver(&self, resolver: Arc<super::HelperCatalogResolver>) {
        *self.catalog_resolver.lock_unpoisoned() = Some(resolver);
    }

    /// Sets how the catalog of the workspace a session's STORE ROW names is resolved (by root
    /// path): the authoritative resolution at helper-session open. Installed once at assembly.
    pub fn set_workspace_catalog_resolver(&self, resolver: Arc<super::WorkspaceCatalogResolver>) {
        *self.workspace_catalog_resolver.lock_unpoisoned() = Some(resolver);
    }

    pub(crate) fn catalog(&self) -> Option<Arc<HelperCatalog>> {
        self.catalog.lock_unpoisoned().clone()
    }

    /// The catalog `session` is admitted against: its workspace's when a layer is loaded for it, else
    /// the process one. The forwarding check and the app-tool authorization read this one view (a
    /// session carrying traffic is open in the kernel, so its workspace is recorded).
    pub(crate) fn catalog_for(&self, session: &str) -> Option<Arc<HelperCatalog>> {
        let resolver = self.catalog_resolver.lock_unpoisoned().clone();
        resolver
            .and_then(|resolve| resolve(session))
            .or_else(|| self.catalog())
    }

    /// The open-time catalog of a session whose store row names `workspace_path`: the workspace's
    /// own when its layer is loaded, else the session-keyed view (an opened session), else the
    /// process one. The store row is authoritative: a store-resumable session has no in-memory
    /// workspace record until the kernel opens it, and the helper session lives for a whole
    /// generation, so its open params must not depend on that record existing yet.
    pub(crate) fn catalog_for_open(
        &self,
        session: &str,
        workspace_path: &str,
    ) -> Option<Arc<HelperCatalog>> {
        let resolver = self.workspace_catalog_resolver.lock_unpoisoned().clone();
        resolver
            .and_then(|resolve| resolve(workspace_path))
            .or_else(|| self.catalog_for(session))
    }

    /// Opens `session` on `generation` unless it is open there.
    pub(super) async fn ensure_session(
        &self,
        generation: u64,
        peer: &Peer,
        session: &str,
    ) -> Result<(), RpcError> {
        // A failed open removes its cell, and the OnceCell hands the retry to a call still waiting on that cell. Such
        // a call starts again from the registered entry: opening on the removed cell would look closed in flight.
        for _ in 0..OPEN_ATTEMPTS {
            match self.ensure_on_registered(generation, peer, session).await {
                Err(Attempt::Unregistered) => {}
                Err(Attempt::Failed(error)) => return Err(error),
                Ok(()) => {
                    self.opened_here
                        .lock_unpoisoned()
                        .insert(session.to_owned());
                    return Ok(());
                }
            }
        }
        Err(unavailable("the session open kept failing"))
    }

    async fn ensure_on_registered(
        &self,
        generation: u64,
        peer: &Peer,
        session: &str,
    ) -> Result<(), Attempt> {
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
            return Err(Attempt::Failed(unavailable("the helper exited")));
        };
        let mut waiting = Waiting {
            helper: self,
            generation,
            session,
            cell,
            done: false,
        };
        let cell = &waiting.cell;
        let opened_here = std::sync::atomic::AtomicBool::new(false);
        let result = cell
            .get_or_try_init(|| async {
                let mut registered = false;
                self.with_running(generation, |running| {
                    registered = running
                        .sessions
                        .get(session)
                        .is_some_and(|known| Arc::ptr_eq(known, cell));
                });
                if !registered {
                    return Err(Attempt::Unregistered);
                }
                opened_here.store(true, std::sync::atomic::Ordering::Relaxed);
                self.open_session(generation, peer, session)
                    .await
                    .map_err(Attempt::Failed)
            })
            .await
            .copied();
        let mut forgotten = None;
        self.with_running(generation, |running| {
            let current = running.sessions.get(session);
            match result {
                Err(_) => {
                    if current.is_some_and(|known| Arc::ptr_eq(known, cell)) {
                        running.sessions.remove(session);
                    }
                }
                // Closed while this open was in flight, and not opened again since: the helper has a session that
                // nothing would close. A newer entry is a reopen, which its own close ends.
                Ok(open_id)
                    if opened_here.load(std::sync::atomic::Ordering::Relaxed)
                        && current.is_none() =>
                {
                    // The open's child registration, made while the session was closing, ends with the close.
                    forgotten = Some((open_id, running.children.remove(session)));
                }
                Ok(_) => {}
            }
        });
        waiting.done = true;
        if let Some((open_id, child)) = forgotten {
            self.send_close_ending(peer, session, open_id, child);
        }
        result.map(|_| ())
    }

    async fn open_session(
        &self,
        generation: u64,
        peer: &Peer,
        session: &str,
    ) -> Result<u64, RpcError> {
        let Some(answers) = self.answers() else {
            return Err(unavailable("the agent does not answer helper requests yet"));
        };
        // The session's own workspace: one agent may serve several (the Host's shared local task runtime).
        let Some(workspace) = answers.session_workspace(session).await else {
            return Err(unavailable("the session's workspace is unknown"));
        };
        // The catalog resolves through the store row's workspace: the row exists for a store-resumable
        // session too, while the in-memory record appears only at the kernel's open.
        let workspace_path = workspace["workspacePath"].as_str().unwrap_or_default();
        let Some(catalog) = self.catalog_for_open(session, workspace_path) else {
            return Err(unavailable("the helper has no plugin catalog yet"));
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
        // Node's subagent runs carry the root session (subagent/runner.ts), and the Office server keeps one viewer per
        // `root_session_id ?? session_id`: without it a subagent's documents land in a viewer of their own.
        if let Some(root) = answers.session_root(session).await
            && root != session
        {
            params["rootSessionId"] = Value::String(root);
        }
        // F4-D7: a subagent's browser registration goes before its open, so its first browser call finds it. A
        // refused registration fails the open.
        let parent = answers.session_parent(session).await;
        // Until the open is answered, a caller that drops this call ends what it made: the child registration, and
        // the open (its close) once it was sent.
        let mut abandoned = AbandonedOpen {
            helper: self,
            peer,
            session,
            open_id: Some(open_id),
            child: false,
        };
        if let Some(parent) = &parent {
            let registration = json!({
                "childSessionId": session,
                "parentSessionId": parent,
                "tabOwner": "parent",
            });
            // Set before the request: the helper may accept it even when this call times out or is dropped, and the
            // registration then has to be ended (the drop of `abandoned` does it, as the open's own close).
            abandoned.child = true;
            let deadline = self.timing.timeout_for(OPEN);
            match tokio::time::timeout(deadline, peer.request(CHILD_SESSION, &registration)).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    // Refused: nothing was registered, so there is nothing to end.
                    abandoned.child = false;
                    return Err(error);
                }
                Err(_elapsed) => {
                    // No open was sent. The late registration is ended by the drop of `abandoned`.
                    abandoned.open_id = None;
                    return Err(unavailable(
                        "the helper did not register the child session in time",
                    ));
                }
            }
        }
        let deadline = self.timing.timeout_for(OPEN);
        let answer = tokio::time::timeout(deadline, peer.request(OPEN, &params)).await;
        if answer.is_ok() {
            // The helper answered: it keeps nothing of a failed open.
            abandoned.open_id = None;
        }
        let outcome = match answer {
            Ok(Ok(_)) => {
                self.heard(generation);
                if parent.is_some() {
                    self.with_running(generation, |running| {
                        running.children.insert(session.to_owned());
                    });
                }
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
        };
        // The registration is settled here: kept by the session's lifecycle on success, ended on a failed open. The
        // `abandoned` guard must not end it a second time.
        abandoned.child = false;
        if outcome.is_err() && parent.is_some() {
            self.send_child_end(peer, session);
        }
        outcome
    }

    /// Rust closed `session`. When the running generation opened it, the helper closes it too (fire and forget).
    pub fn session_closed(&self, session: &str) {
        let peer = {
            let mut state = self.state.lock_unpoisoned();
            let Slot::Running(running) = &mut state.slot else {
                return;
            };
            running.panels.forget_session(session);
            let child = running.children.remove(session);
            match running.sessions.remove(session) {
                Some(opening) => {
                    running.last_used = tokio::time::Instant::now();
                    // An open still in flight closes the session itself once it succeeds (`ensure_session`).
                    opening
                        .get()
                        .map(|open_id| (running.peer.clone(), *open_id, child))
                }
                None => None,
            }
        };
        if let Some((peer, open_id, child)) = peer {
            self.send_close_ending(&peer, session, open_id, child);
        }
    }

    /// A turn of `session` finished (sent once per turn by its owner, after the turn's own tool calls answered). Only a
    /// session this generation holds open is told: there is no browser scope to release otherwise.
    pub fn turn_ended(&self, session: &str, turn_id: &str, reason: &str) {
        let peer = {
            let state = self.state.lock_unpoisoned();
            match &state.slot {
                Slot::Running(running) if running.sessions.contains_key(session) => {
                    Some(running.peer.clone())
                }
                _ => None,
            }
        };
        let Some(peer) = peer else {
            return;
        };
        let params = json!({"sessionId": session, "turnId": turn_id, "reason": reason});
        drop(self.spawner.spawn("node-helper-turn-ended", async move {
            peer.notify(TURN_ENDED, &params).await;
        }));
    }

    /// D2-H: `helper/browser/turnScreenshot` on the session's helper, when this generation holds the session open. `None`
    /// when there is no helper session to ask (Node has no browser scope then either), when the turn is cancelled, or
    /// when the helper does not answer in time; the turn is then unchanged. Bounded by the helper's default request
    /// timeout, so a slow helper cannot hold the turn end.
    pub(crate) async fn turn_screenshot(
        &self,
        session: &str,
        turn: &str,
        candidate: &BrowserCandidate,
        cancel: &CancellationToken,
    ) -> Option<Value> {
        let peer = {
            let state = self.state.lock_unpoisoned();
            match &state.slot {
                Slot::Running(running) if running.sessions.contains_key(session) => {
                    running.peer.clone()
                }
                _ => return None,
            }
        };
        let params = json!({
            "sessionId": session,
            "turnId": turn,
            "browserId": candidate.browser_id,
            "browserGeneration": candidate.browser_generation,
        });
        let deadline = self.timing.timeout_for(TURN_SCREENSHOT);
        let cancel_peer = peer.clone();
        let cancel_params = json!({"sessionId": session, "turnId": turn});
        match settle_capture(
            tokio::time::timeout(deadline, peer.request(TURN_SCREENSHOT, &params)),
            cancel,
        )
        .await
        {
            Some(Ok(Ok(value))) => Some(value),
            settled => {
                // Any other end while the turn is cancelled (an error, the timeout, or the cancel itself) still sends the
                // cancel: a timed-out capture may be in flight in the helper.
                if cancel.is_cancelled() {
                    // C1: the helper aborts its broker calls, which send `cancelRequest` to Main (Node's turnAbortSignal).
                    drop(
                        self.spawner
                            .spawn("node-helper-turn-screenshot-cancel", async move {
                                cancel_peer
                                    .notify(TURN_SCREENSHOT_CANCEL, &cancel_params)
                                    .await;
                            }),
                    );
                }
                match settled {
                    Some(Ok(Err(error))) => {
                        tracing::warn!(
                            event = "fork_rust_helper.browser.turn_screenshot_failed",
                            code = error.code,
                            "the helper could not capture the turn screenshot"
                        );
                    }
                    Some(Err(_elapsed)) => {
                        tracing::warn!(
                            event = "fork_rust_helper.browser.turn_screenshot_timeout",
                            "the helper did not capture the turn screenshot in time"
                        );
                    }
                    _ => {}
                }
                None
            }
        }
    }

    /// F4-D7: `helper/browser/childSessionEnd` for a subagent session. One task sends it and then the close, so the
    /// helper releases the registration before the session closes.
    fn send_close_ending(&self, peer: &Peer, session: &str, open_id: u64, child: bool) {
        let peer = peer.clone();
        let close = json!({"sessionId": session, "openId": open_id});
        let end = json!({"childSessionId": session});
        drop(self.spawner.spawn("node-helper-session-close", async move {
            if child {
                peer.notify(CHILD_SESSION_END, &end).await;
            }
            peer.notify(CLOSE, &close).await;
        }));
    }

    /// F4-D7: ends a child registration whose open failed after it was made (fire and forget).
    fn send_child_end(&self, peer: &Peer, session: &str) {
        let peer = peer.clone();
        let params = json!({"childSessionId": session});
        drop(self.spawner.spawn("node-helper-child-end", async move {
            peer.notify(CHILD_SESSION_END, &params).await;
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
