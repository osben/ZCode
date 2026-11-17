//! Fork: the Node helper client (specs/fork-rust-node-helper.md). A Rust process whose Host configured a helper command
//! forwards the JS-only method families to a helper child over its stdio, in JSON-RPC with the Host's framing.
//!
//! Owner: this type owns the helper's lifecycle (lazy start, crash and breaker, idle reclaim, kill on drop) and the
//! forwarding allowlist. The process itself comes from an injected [`NodeHelperLauncher`], so this crate spawns nothing.

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_base::{Spawner, Task};
use rust_cli_protocol_core::connection::{self, CONNECTION_CLOSED, Options, Peer, Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncWrite};
use tokio::time::Instant;

/// The reason code of every helper-unavailable error (the Node helper's `proto.forkRustAgent.nodeHelperUnavailable`).
pub const NODE_HELPER_UNAVAILABLE: &str = "proto.forkRustAgent.nodeHelperUnavailable";

/// The helper protocol version, sent in `helper/initialize`. Version 2 adds the F3 messages (helper MCP pipes, helper
/// sessions, helper → Rust requests).
pub(crate) const PROTOCOL_VERSION: u64 = 2;

/// Methods Rust may forward (F1 plugin management, F2 saved workflows and run history, F3 session-scoped MCP App
/// methods). Forwarding also needs the method in the helper's advertised `methods`.
pub(crate) const FORWARDED_METHODS: &[&str] = &[
    "plugins/list",
    "plugins/overview",
    "plugins/describe",
    "plugins/install",
    "plugins/uninstall",
    "plugins/update",
    "plugins/setEnabled",
    "plugins/configure",
    "plugins/resetConfig",
    "plugins/validate",
    "plugins/restoreBuiltin",
    "plugins/marketplace/add",
    "plugins/marketplace/remove",
    "plugins/marketplace/update",
    "plugins/resolveSuggestedReference",
    "plugins/cancelOperation",
    "plugins/readUserOptions",
    "plugins/listUiSurfaces",
    "plugins/referenceCatalog",
    "plugins/referenceCatalogWithCategory",
    "workflows/list",
    "workflows/get",
    "workflows/updateMeta",
    "workflows/delete",
    "workflows/runs",
    "workflows/move",
    "workflows/save",
    "workflows/forRun",
    "v4/conversation/workflowRuns",
    "v4/conversation/workflowRunEvents",
    "v4/conversation/workflowRunArtifacts",
    "v4/conversation/workflowRunArtifactData",
    "v4/conversation/workflowRunArtifactRead",
    "v4/conversation/workflowRunWorkspace",
    "v4/conversation/workflowRunNodeResult",
    // F3: the session-scoped methods (`node_helper_sessions.rs`).
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

/// Helper notifications relayed to the Host verbatim. Any other notification from the helper is dropped.
pub(crate) const RELAYED_NOTIFICATIONS: &[&str] = &[
    "plugins/operationProgress",
    // F4c: the helper relays computer-use operation events (specs/fork-rust-node-helper.md F4c).
    "computer-use/operation-event",
];

/// Answered without a helper when no helper process exists or is starting: no operation can be in flight, and
/// starting one only to answer `cancelled: false` would cost a Node process. During a start the cancel waits for it,
/// since the operation it names may be the call that triggered the start.
const CANCEL_OPERATION: &str = "plugins/cancelOperation";

/// The liveness check after a timed-out forwarded call (F3, "Lifecycle changes").
const PING: &str = "helper/ping";

/// The timing of the client. The defaults are the Host's request timeouts and the idle reclaim period; tests shorten
/// them.
#[derive(Debug, Clone)]
pub struct Timing {
    /// Per forwarded `plugins/*` and `workflows/*` call (the Host's plugin-management timeout).
    pub request: Duration,
    /// Per forwarded `mcp/uiSampling` call (the Host's sampling timeout).
    pub sampling: Duration,
    /// Per forwarded call of any other method, and per `helper/mcp/connect` (the Host's default request timeout).
    pub default_request: Duration,
    /// How long a process whose call timed out has to answer `helper/ping` to be kept.
    pub ping: Duration,
    /// For `helper/initialize`. Every call waits on a start, so a helper that never answers the handshake must fail
    /// fast instead of holding them for the call timeout (spawn to answer is about 0.6 s).
    pub initialize: Duration,
    /// For the `plugins/cancelOperation` Rust sends for an abandoned call; the Host's own cancel request timeout.
    pub cancel: Duration,
    /// Idle time with no call in flight before the process is reclaimed.
    pub idle: Duration,
    /// The window in which `crash_limit` crashes keep the helper down for the life of the process.
    pub crash_window: Duration,
    pub crash_limit: usize,
    /// After a failed launch or `helper/initialize`, calls fail fast for this long instead of each starting a Node
    /// process (the run list is polled on every subscribe).
    pub start_cooldown: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            request: Duration::from_secs(300),
            sampling: Duration::from_secs(65),
            default_request: Duration::from_secs(180),
            ping: Duration::from_secs(5),
            initialize: Duration::from_secs(30),
            cancel: Duration::from_secs(5),
            idle: Duration::from_secs(300),
            crash_window: Duration::from_secs(60),
            crash_limit: 3,
            start_cooldown: Duration::from_secs(30),
        }
    }
}

impl Timing {
    /// The Host's timeout for a forwarded `method`. Model tool calls on helper pipes are timed by Rust's MCP client.
    pub fn timeout_for(&self, method: &str) -> Duration {
        if method.starts_with("plugins/") || method.starts_with("workflows/") {
            self.request
        } else if method == "mcp/uiSampling" {
            self.sampling
        } else {
            self.default_request
        }
    }
}

pub use launch::{NodeHelperLauncher, NodeHelperProcess};

/// Resolves a session's workspace catalog (F3, per-workspace admission): the catalog of the plugins
/// the session's workspace layer admitted, or `None` when no layer is loaded for it, in which case
/// the process catalog answers. Installed once at assembly; sync and cheap (it reads the workspace
/// layer's loaded slots).
pub type HelperCatalogResolver = dyn Fn(&str) -> Option<Arc<sessions::HelperCatalog>> + Send + Sync;

/// Resolves the catalog of the workspace a session's STORE ROW names, by workspace root path: the
/// authoritative resolution at helper-session open time. A store-resumable session has no
/// in-memory record yet (the kernel records its workspace at open/create), so the session-keyed
/// resolver cannot answer for it — the row can.
pub type WorkspaceCatalogResolver =
    dyn Fn(&str) -> Option<Arc<sessions::HelperCatalog>> + Send + Sync;

/// The Rust side of the helper connection, one per Rust process.
pub struct NodeHelper {
    launcher: Arc<dyn NodeHelperLauncher>,
    spawner: Spawner,
    /// The Host's peer, where allowlisted helper notifications are relayed.
    host: Peer,
    timing: Timing,
    /// Weak handle to this helper, for the tasks that outlive a call (reader, reclaim timer, a shared start).
    myself: Weak<NodeHelper>,
    /// Never held across an await: a start is shared through [`Slot::Starting`] instead.
    state: StdMutex<State>,
    /// Set by the first launch or initialize failure, cleared by a successful start, so the warning is logged once.
    warned: AtomicBool,
    /// F3: what Rust admitted process-wide — the fallback catalog of a session whose workspace has
    /// no loaded layer (set once plugins are loaded).
    catalog: StdMutex<Option<Arc<sessions::HelperCatalog>>>,
    /// F3: resolves a session's workspace catalog (per-workspace admission). `None` — no resolver
    /// installed, or no loaded layer for the session's workspace — falls back to the process
    /// catalog. The lock only clones the resolver out; it is never held across an await.
    catalog_resolver: StdMutex<Option<Arc<HelperCatalogResolver>>>,
    /// F3: resolves the catalog of the workspace a session's store row names (open time). The
    /// same lock discipline as [`Self::catalog_resolver`].
    workspace_catalog_resolver: StdMutex<Option<Arc<WorkspaceCatalogResolver>>>,
    /// F3: the workspace (with its key) each session's pipe traffic runs in, as its store row holds it — the same
    /// resolution the session open uses, cached with the oldest evicted at [`mcp::REMEMBERED_WORKSPACES`] (a row never
    /// changes workspace, so an evicted entry is only re-resolved, never wrong). Read by the pipe-workspace refusal
    /// and the routed transport's pipe choice; only cloned out under the lock.
    pipe_workspaces: StdMutex<mcp::PipeWorkspaces>,
    /// F3: the helper's requests to Rust and who answers them.
    requests: StdMutex<requests::Requests>,
    /// F3: the last `openId` of a `helper/session/open`; a close names its open's id.
    last_open: AtomicU64,
    /// Every session this agent has opened in the helper (never removed: a close-time relay still arrives after the
    /// close, and the session stays this agent's). Browser relays are answered only for these or a live session.
    opened_here: StdMutex<HashSet<String>>,
}

struct State {
    slot: Slot,
    /// Each started process gets a new generation. Events from an older process are ignored by generation.
    generation: u64,
    /// Instants of crashes inside the breaker window.
    crashes: Vec<Instant>,
    /// Set by a failed start: until then a call fails fast and starts nothing.
    retry_at: Option<Instant>,
}

enum Slot {
    Idle,
    /// A start in progress. Concurrent first calls await the same future.
    Starting(Shared<BoxFuture<'static, Result<(), RpcError>>>),
    Running(Box<Running>),
    /// The breaker tripped, or the helper speaks another protocol version: every call fails fast.
    Down,
}

struct Running {
    generation: u64,
    peer: Peer,
    methods: HashSet<String>,
    in_flight: usize,
    last_used: Instant,
    /// Counts everything the process sent (an answer, a notification such as operation progress or pipe traffic, a
    /// request): a timed-out call keeps the process when the count moved since the call started. A count, not a
    /// timestamp, so an answer at the call's own instant is not mistaken for one after it.
    heard: u64,
    /// F3: the helper MCP connections of this generation, by connection id. Dropped with the slot, each closes its
    /// connection's event stream (a crash, timeout or reclaim closes every pipe). An open pipe blocks idle reclaim.
    pipes: HashMap<String, mcp::Pipe>,
    /// F3: the helper sessions opened (or opening) in this generation. An open session blocks idle reclaim.
    sessions: HashMap<String, sessions::Opening>,
    /// F4-D7: the subagent sessions whose child registration this generation made. Ending one
    /// sends `helper/browser/childSessionEnd` before its close.
    children: HashSet<String>,
    /// F3: the panel instances this generation opened and nobody closed. Dropped with the slot, it closes them on
    /// their sessions' streams.
    panels: Box<panels::Panels>,
    /// Dropped with the slot: kills the process tree. Always dropped after the state lock is released, since it comes
    /// from an injected launcher.
    _guard: Box<dyn Send>,
}

impl Running {
    /// Nothing keeps the process: no call in flight and no open helper resource (F3 "Open resources").
    fn idle(&self) -> bool {
        self.in_flight == 0 && self.pipes.is_empty() && self.sessions.is_empty()
    }
}

impl NodeHelper {
    pub fn new(
        launcher: Arc<dyn NodeHelperLauncher>,
        spawner: Spawner,
        host: Peer,
        timing: Timing,
    ) -> Arc<Self> {
        Arc::new_cyclic(|myself| Self {
            launcher,
            spawner,
            host,
            timing,
            myself: myself.clone(),
            state: StdMutex::new(State {
                slot: Slot::Idle,
                generation: 0,
                crashes: Vec::new(),
                retry_at: None,
            }),
            warned: AtomicBool::new(false),
            catalog: StdMutex::new(None),
            catalog_resolver: StdMutex::new(None),
            workspace_catalog_resolver: StdMutex::new(None),
            pipe_workspaces: StdMutex::default(),
            requests: StdMutex::default(),
            last_open: AtomicU64::new(0),
            opened_here: StdMutex::new(HashSet::new()),
        })
    }

    /// Whether this agent opened `session` in the helper. Foreign sessions in the workspace-shared store are not.
    pub(crate) fn opened_here(&self, session: &str) -> bool {
        self.opened_here.lock_unpoisoned().contains(session)
    }

    /// Forwards `method` when it is allowlisted and the helper advertises it. `None` means the caller answers as
    /// before (`-32601`). `Some(Err)` with [`NODE_HELPER_UNAVAILABLE`] means the helper could not answer.
    pub async fn forward(&self, method: &str, params: &Value) -> Option<Result<Value, RpcError>> {
        if !FORWARDED_METHODS.contains(&method) {
            return None;
        }
        if method == CANCEL_OPERATION
            && !self.has_process()
            && let Some(operation_id) = params.get("operationId").and_then(Value::as_str)
        {
            return Some(Ok(json!({"operationId": operation_id, "cancelled": false})));
        }
        let (generation, peer) = match self.acquire(method).await {
            Ok(Some(link)) => link,
            Ok(None) => return None,
            Err(error) => return Some(Err(error)),
        };
        // Released on every exit, including a caller that drops this future mid-call: a leaked in-flight count would
        // keep the idle reclaim from ever ending the process.
        let _in_flight = InFlight {
            helper: self,
            generation,
        };
        // F3: a session-scoped call runs in its helper session, opened first in this generation.
        if let Some(session) = sessions::session_of(method, params)
            && let Err(error) = self.ensure_session(generation, &peer, session).await
        {
            return Some(Err(error));
        }
        let started = self.heard_count(generation);
        let deadline = self.timing.timeout_for(method);
        let result = match tokio::time::timeout(deadline, peer.request(method, params)).await {
            Err(_elapsed) => {
                if self.timed_out(generation, started, &peer).await {
                    self.cancel_abandoned(method, params, &peer);
                }
                Err(unavailable("the helper did not answer in time"))
            }
            Ok(Err(error)) if error.code == CONNECTION_CLOSED && peer.is_closed() => {
                self.link_lost(generation);
                Err(unavailable("the helper connection closed"))
            }
            Ok(result) => {
                self.heard(generation);
                result
            }
        };
        Some(self.panel_answered(generation, method, params, result))
    }

    /// A ready link for `method`, starting the helper when it is not running. `Ok(None)` when the helper does not
    /// advertise `method`.
    async fn acquire(&self, method: &str) -> Result<Option<(u64, Peer)>, RpcError> {
        self.acquire_for(Some(method)).await
    }

    /// [`Self::acquire`] for a helper message of Rust's own (`helper/*`, F3), which the helper never advertises.
    async fn acquire_link(&self) -> Result<(u64, Peer), RpcError> {
        match self.acquire_for(None).await? {
            Some(link) => Ok(link),
            None => Err(unavailable("the helper is not running")),
        }
    }

    async fn acquire_for(&self, method: Option<&str>) -> Result<Option<(u64, Peer)>, RpcError> {
        loop {
            // Declared before the lock so a dropped process is released after the lock is.
            let mut retired = None;
            let starting = {
                let mut state = self.state.lock_unpoisoned();
                if let Slot::Running(running) = &state.slot
                    && running.peer.is_closed()
                {
                    let generation = running.generation;
                    retired = self.crashed(&mut state, generation);
                }
                match &mut state.slot {
                    Slot::Down => {
                        return Err(unavailable("the helper is down after repeated crashes"));
                    }
                    Slot::Running(running) => {
                        if method.is_some_and(|method| !running.methods.contains(method)) {
                            return Ok(None);
                        }
                        running.in_flight += 1;
                        return Ok(Some((running.generation, running.peer.clone())));
                    }
                    Slot::Starting(starting) => starting.clone(),
                    Slot::Idle => {
                        if state.retry_at.is_some_and(|at| Instant::now() < at) {
                            return Err(unavailable("the helper failed to start; retrying later"));
                        }
                        let Some(this) = self.myself.upgrade() else {
                            return Err(unavailable("the helper is not running"));
                        };
                        state.generation += 1;
                        let generation = state.generation;
                        // A detached task: a caller dropped mid-start must not leave a launched process waiting in
                        // `Starting` for the next call to drive it.
                        let task = self.spawner.spawn("node-helper-start", async move {
                            this.start(generation).await
                        });
                        let weak = self.myself.clone();
                        let starting = async move {
                            match task.await {
                                Ok(result) => result,
                                Err(_) => {
                                    // A panicked or aborted start never reached its own failure path; without this
                                    // the slot would hold this failed start for the life of the process.
                                    if let Some(helper) = weak.upgrade() {
                                        helper.warn_once(
                                            "start",
                                            Some(
                                                "the start task panicked or was aborted".to_owned(),
                                            ),
                                        );
                                        helper.start_failed(generation);
                                    }
                                    Err(unavailable("the helper start was interrupted"))
                                }
                            }
                        }
                        .boxed()
                        .shared();
                        state.slot = Slot::Starting(starting.clone());
                        starting
                    }
                }
            };
            drop(retired);
            starting.await?;
        }
    }

    fn warn_once(&self, stage: &'static str, detail: Option<String>) {
        if !self.warned.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                event = "helper.unavailable",
                stage,
                detail = detail.as_deref().unwrap_or(""),
                "the node helper is unavailable"
            );
        }
    }

    /// Crashes counted inside the breaker window (tests).
    #[cfg(test)]
    pub(crate) fn crash_count(&self) -> usize {
        self.state.lock_unpoisoned().crashes.len()
    }
}

/// One forwarded call counted in [`Running::in_flight`]; dropping it ends the call.
struct InFlight<'a> {
    helper: &'a NodeHelper,
    generation: u64,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.helper.finish(self.generation);
    }
}

const UI_CALL_TOOL: &str = "mcp/uiCallTool";
const UI_SAMPLING: &str = "mcp/uiSampling";
/// The plugin scope of an `mcp/ui*` call (`zcodeMcpUiPluginScopeShape`). The cancel schemas are strict: a cancel carries
/// these and its id, nothing else.
const UI_SCOPE: &[&str] = &[
    "instance",
    "workspace",
    "sessionId",
    "pluginId",
    "serverName",
];

/// The cancel of an abandoned call: a panel tool call by its `callId` (`mcp/uiCancelCall`), a panel sampling call by
/// its `operationId` (`mcp/uiCancelSampling`), any other call with an `operationId` as a plugin operation.
fn abandoned_cancel(method: &str, params: &Value) -> Option<(&'static str, Value)> {
    let ui_cancel = |cancel: &'static str, id: &str| {
        let value = params
            .get(id)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())?;
        let mut fields: serde_json::Map<String, Value> = UI_SCOPE
            .iter()
            .filter_map(|key| {
                params
                    .get(*key)
                    .map(|value| ((*key).to_owned(), value.clone()))
            })
            .collect();
        fields.insert(id.to_owned(), json!(value));
        Some((cancel, Value::Object(fields)))
    };
    match method {
        // A cancel is never cancelled: an abandoned one sends nothing.
        CANCEL_OPERATION | "mcp/uiCancelCall" | "mcp/uiCancelSampling" => None,
        UI_CALL_TOOL => ui_cancel("mcp/uiCancelCall", "callId"),
        UI_SAMPLING => ui_cancel("mcp/uiCancelSampling", "operationId"),
        _ => operation_id(params).map(|id| (CANCEL_OPERATION, json!({"operationId": id}))),
    }
}

/// The id a cancellable plugin operation registers under in the helper: trimmed and non-empty, as Node's
/// `getPluginOperationId`.
fn operation_id(params: &Value) -> Option<String> {
    let id = params.get("operationId")?.as_str()?.trim();
    (!id.is_empty()).then(|| id.to_owned())
}

fn unavailable(message: &str) -> RpcError {
    RpcError::internal(format!("{message} ({NODE_HELPER_UNAVAILABLE})"))
        .with_data(json!({"reasonCode": NODE_HELPER_UNAVAILABLE}))
}

#[path = "node_helper_launch.rs"]
mod launch;
#[path = "node_helper_link.rs"]
mod link;
#[path = "node_helper_mcp.rs"]
mod mcp;
#[path = "node_helper_panels.rs"]
mod panels;
#[path = "node_helper_requests.rs"]
mod requests;
#[path = "node_helper_sessions.rs"]
mod sessions;
#[path = "node_helper_stop.rs"]
mod stop;
#[cfg(test)]
use mcp::HelperMcpConnection;
pub use mcp::HelperRoutedMcp;
pub(crate) use requests::HelperRequests;
pub use sessions::HelperCatalog;
pub(crate) use sessions::{close_listener, session_of};

#[cfg(test)]
#[path = "node_helper_tests.rs"]
mod tests;
