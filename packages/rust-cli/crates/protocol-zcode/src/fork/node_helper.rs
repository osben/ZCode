//! Fork: the Node helper client (specs/fork-rust-node-helper.md). A Rust process whose Host configured a helper command
//! forwards the JS-only method families to a helper child over its stdio, in JSON-RPC with the Host's framing.
//!
//! Owner: this type owns the helper's lifecycle (lazy start, crash and breaker, idle reclaim, kill on drop) and the
//! forwarding allowlist. The process itself comes from an injected [`NodeHelperLauncher`], so this crate spawns nothing.

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use rust_cli_base::Spawner;
use rust_cli_base::sync::LockUnpoisoned;
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
pub(crate) const RELAYED_NOTIFICATIONS: &[&str] = &["plugins/operationProgress"];

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

/// A launched helper process. Dropping `guard` kills the process tree.
pub struct NodeHelperProcess {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncBufRead + Send + Unpin>,
    pub guard: Box<dyn Send>,
}

/// Starts one helper process. The implementation owns the child's stderr.
#[async_trait]
pub trait NodeHelperLauncher: Send + Sync {
    async fn launch(&self) -> io::Result<NodeHelperProcess>;
}

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
    /// F3: what Rust admitted, sent with every session open (set once plugins are loaded).
    catalog: StdMutex<Option<Arc<sessions::HelperCatalog>>>,
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
    Running(Running),
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
        })
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
        Some(result)
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

    /// Launches and initializes a helper, then makes it the running slot. Runs once per start, shared by the callers
    /// that were waiting for it. Holds no lock across an await.
    async fn start(&self, generation: u64) -> Result<(), RpcError> {
        let process = match self.launcher.launch().await {
            Ok(process) => process,
            Err(error) => {
                self.warn_once("launch", Some(error.to_string()));
                self.start_failed(generation);
                return Err(unavailable("the helper could not be started"));
            }
        };
        let NodeHelperProcess {
            stdin,
            stdout,
            guard,
        } = process;
        let (peer, _writer) = connection::start(stdin, &self.spawner, Options::default());
        let relay = Arc::new(Relay {
            host: self.host.clone(),
            helper: self.myself.clone(),
            generation,
        });
        let weak = self.myself.clone();
        let reader_peer = peer.clone();
        let reader_spawner = self.spawner.clone();
        drop(self.spawner.spawn("node-helper-reader", async move {
            let _ = connection::serve(
                stdout,
                reader_peer,
                relay,
                reader_spawner,
                Options::default(),
            )
            .await;
            if let Some(helper) = weak.upgrade() {
                helper.link_lost(generation);
            }
        }));

        let initialized = tokio::time::timeout(
            self.timing.initialize,
            peer.request(
                "helper/initialize",
                &json!({"protocolVersion": PROTOCOL_VERSION}),
            ),
        )
        .await;
        let answer = match initialized {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) | Err(_) => {
                drop(guard);
                self.warn_once("initialize", None);
                self.start_failed(generation);
                return Err(unavailable("the helper did not initialize"));
            }
        };
        if answer["protocolVersion"].as_u64() != Some(PROTOCOL_VERSION) {
            drop(guard);
            self.state.lock_unpoisoned().slot = Slot::Down;
            tracing::warn!(
                event = "helper.unavailable",
                reason = "protocol_version",
                "the helper speaks another protocol version; it stays down"
            );
            return Err(unavailable("the helper speaks another protocol version"));
        }
        let methods: HashSet<String> = answer["methods"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        if methods.is_empty() {
            // A helper that advertises nothing is broken (the bundle and this binary disagree): report it as
            // unavailable instead of answering every method -32601 as if no helper were configured.
            drop(guard);
            self.warn_once(
                "initialize",
                Some("the helper advertised no methods".to_owned()),
            );
            self.start_failed(generation);
            return Err(unavailable("the helper advertised no methods"));
        }
        let now = Instant::now();
        let mut state = self.state.lock_unpoisoned();
        state.slot = Slot::Running(Running {
            generation,
            peer,
            methods,
            in_flight: 0,
            last_used: now,
            heard: 0,
            pipes: HashMap::new(),
            sessions: HashMap::new(),
            _guard: guard,
        });
        state.retry_at = None;
        drop(state);
        self.warned.store(false, Ordering::Relaxed);
        tracing::info!(
            event = "helper.spawned",
            generation,
            "the node helper started"
        );
        self.spawn_reclaim(generation);
        Ok(())
    }

    /// Returns a failed start to idle; the next call starts again once the cooldown has passed. Only the start of
    /// `generation` does this.
    fn start_failed(&self, generation: u64) {
        let mut state = self.state.lock_unpoisoned();
        if matches!(&state.slot, Slot::Starting(_)) && state.generation == generation {
            state.slot = Slot::Idle;
            state.retry_at = Some(Instant::now() + self.timing.start_cooldown);
        }
    }

    /// A helper process is starting, or running with its connection open.
    fn has_process(&self) -> bool {
        match &self.state.lock_unpoisoned().slot {
            Slot::Starting(_) => true,
            Slot::Running(running) => !running.peer.is_closed(),
            Slot::Idle | Slot::Down => false,
        }
    }

    fn spawn_reclaim(&self, generation: u64) {
        let weak = self.myself.clone();
        let idle = self.timing.idle;
        drop(self.spawner.spawn("node-helper-idle", async move {
            reclaim(weak, generation, idle).await;
        }));
    }

    fn finish(&self, generation: u64) {
        let mut state = self.state.lock_unpoisoned();
        if let Slot::Running(running) = &mut state.slot
            && running.generation == generation
        {
            running.in_flight -= 1;
            running.last_used = Instant::now();
        }
    }

    /// The process of `generation` sent something: it is alive.
    fn heard(&self, generation: u64) {
        let mut state = self.state.lock_unpoisoned();
        if let Slot::Running(running) = &mut state.slot
            && running.generation == generation
        {
            running.heard += 1;
        }
    }

    /// How much `generation` was heard from so far (see [`Running::heard`]).
    fn heard_count(&self, generation: u64) -> u64 {
        match &self.state.lock_unpoisoned().slot {
            Slot::Running(running) if running.generation == generation => running.heard,
            _ => 0,
        }
    }

    /// A call of `generation` timed out; `started` is [`Self::heard_count`] when it started. The process is kept when it was heard from since the
    /// call started (an answer, progress or pipe traffic) or when it answers `helper/ping` in time: it is alive and only
    /// this call is slow, and dropping it would close every session's helper pipes. Otherwise it is hung and is dropped
    /// without counting a crash. Returns whether the process was kept.
    async fn timed_out(&self, generation: u64, started: u64, peer: &Peer) -> bool {
        let heard = match &self.state.lock_unpoisoned().slot {
            Slot::Running(running) if running.generation == generation => running.heard != started,
            _ => return false,
        };
        let alive = heard || self.answers_ping(peer).await;
        let mut state = self.state.lock_unpoisoned();
        if !is_current(&state, generation) {
            return false;
        }
        if alive {
            if let Slot::Running(running) = &mut state.slot {
                running.heard += 1;
            }
            tracing::warn!(
                event = "helper.call_timed_out",
                generation,
                "a forwarded call timed out; the helper is alive and is kept"
            );
            return true;
        }
        let retired = std::mem::replace(&mut state.slot, Slot::Idle);
        drop(state);
        drop(retired);
        tracing::warn!(
            event = "helper.unavailable",
            reason = "timeout",
            "the node helper was dropped"
        );
        false
    }

    /// Any answer to `helper/ping` within [`Timing::ping`] proves the process is alive, an error answer included.
    async fn answers_ping(&self, peer: &Peer) -> bool {
        match tokio::time::timeout(self.timing.ping, peer.request(PING, &json!({}))).await {
            Ok(Ok(_)) => true,
            Ok(Err(error)) => !(error.code == CONNECTION_CLOSED && peer.is_closed()),
            Err(_elapsed) => false,
        }
    }

    /// The kept process still runs a call its caller gave up on. A cancellable plugin operation is cancelled in the
    /// helper, as the Host would, so it neither keeps running nor stays registered under its id. Fire and forget: the
    /// answer does not matter, and a process dropped meanwhile ends the operation anyway.
    fn cancel_abandoned(&self, method: &str, params: &Value, peer: &Peer) {
        if method == CANCEL_OPERATION {
            return;
        }
        let Some(operation_id) = operation_id(params) else {
            return;
        };
        let peer = peer.clone();
        let deadline = self.timing.cancel;
        drop(self.spawner.spawn("node-helper-cancel", async move {
            let cancel = json!({"operationId": operation_id});
            let _ = tokio::time::timeout(deadline, peer.request(CANCEL_OPERATION, &cancel)).await;
        }));
    }

    /// The reader of `generation` ended (the process closed its stdout), or a call saw the connection closed.
    fn link_lost(&self, generation: u64) {
        let mut state = self.state.lock_unpoisoned();
        if is_current(&state, generation) {
            let retired = self.crashed(&mut state, generation);
            drop(state);
            drop(retired);
        } else {
            tracing::info!(
                event = "helper.exited",
                generation,
                "the node helper exited"
            );
        }
    }

    /// Counts a crash of `generation` and trips the breaker at the limit. Ignored unless `generation` is the running
    /// process, so a crash is counted once however many callers see it. Returns the crashed slot, for the caller to
    /// drop after it releases the lock.
    #[must_use]
    fn crashed(&self, state: &mut State, generation: u64) -> Option<Slot> {
        if !is_current(state, generation) {
            return None;
        }
        let retired = std::mem::replace(&mut state.slot, Slot::Idle);
        let now = Instant::now();
        let window = self.timing.crash_window;
        state
            .crashes
            .retain(|at| now.saturating_duration_since(*at) < window);
        state.crashes.push(now);
        tracing::warn!(
            event = "helper.crashed",
            generation,
            crashes = state.crashes.len(),
            "the node helper crashed"
        );
        if state.crashes.len() >= self.timing.crash_limit {
            state.slot = Slot::Down;
            tracing::warn!(
                event = "helper.unavailable",
                reason = "crash_limit",
                "the node helper stays down until this process restarts"
            );
        }
        Some(retired)
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

fn is_current(state: &State, generation: u64) -> bool {
    matches!(&state.slot, Slot::Running(running) if running.generation == generation)
}

/// Ends the process of `generation` once it has been idle for `idle`. Each wake-up re-checks the state, so a call in
/// flight or a newer process is never reclaimed by a stale timer.
async fn reclaim(weak: Weak<NodeHelper>, generation: u64, idle: Duration) {
    loop {
        let Some(helper) = weak.upgrade() else {
            return;
        };
        // The lock lives in this block only: the guard must not be held, or even live, across the sleep below.
        let wake = {
            let mut state = helper.state.lock_unpoisoned();
            let Slot::Running(running) = &state.slot else {
                return;
            };
            if running.generation != generation {
                return;
            }
            if !running.idle() {
                Some(Instant::now() + idle)
            } else if running.last_used.elapsed() >= idle {
                let retired = std::mem::replace(&mut state.slot, Slot::Idle);
                drop(state);
                drop(retired);
                tracing::info!(
                    event = "helper.reclaimed",
                    generation,
                    "the idle node helper was reclaimed"
                );
                None
            } else {
                Some(running.last_used + idle)
            }
        };
        let Some(wake) = wake else {
            return;
        };
        drop(helper);
        tokio::time::sleep_until(wake).await;
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

/// The helper's side of the connection: relays allowlisted notifications to the Host and answers the helper's own
/// requests with method-not-found.
struct Relay {
    host: Peer,
    /// Anything the process sends marks it alive (see [`Running::heard`]), relayed or not: a dropped notification
    /// is still proof that the process is running. A hung call on a live process is then left to its cancel (calls
    /// with an `operationId`) and to the idle reclaim.
    helper: Weak<NodeHelper>,
    generation: u64,
}

impl Relay {
    fn heard(&self) {
        if let Some(helper) = self.helper.upgrade() {
            helper.heard(self.generation);
        }
    }
}

#[async_trait]
impl Service for Relay {
    /// F3: pipe traffic is routed in the read loop, so a connection's messages reach Rust's MCP client in the order the
    /// helper sent them (`serve` spawns every other notification as its own task).
    fn control(&self, method: &str, params: &Value) -> bool {
        if !mcp::PIPE_NOTIFICATIONS.contains(&method) {
            return false;
        }
        if let Some(helper) = self.helper.upgrade() {
            helper.heard(self.generation);
            helper.pipe_event(self.generation, method, params);
        }
        true
    }

    async fn request(&self, method: &str, _params: Value) -> Result<Reply, RpcError> {
        self.heard();
        Err(RpcError::method_not_found(method))
    }

    async fn notification(&self, method: &str, params: Value) {
        self.heard();
        if RELAYED_NOTIFICATIONS.contains(&method) {
            self.host.notify(method, &params).await;
        } else {
            tracing::debug!(
                event = "helper.notification.dropped",
                method,
                "a helper notification is not relayed"
            );
        }
    }
}

#[path = "node_helper_mcp.rs"]
mod mcp;
#[path = "node_helper_sessions.rs"]
mod sessions;
#[cfg(test)]
use mcp::HelperMcpConnection;
pub use mcp::HelperRoutedMcp;
pub use sessions::HelperCatalog;
pub(crate) use sessions::{close_listener, session_of};

#[cfg(test)]
#[path = "node_helper_tests.rs"]
mod tests;
