//! Fork: the language-server pool (specs/fork-rust-lsp.md "Pool"), Node adapters `lsp/pool.ts`,
//! `lsp/server-lifecycle.ts`, `lsp/server-entry.ts` and `lsp/server-connection.ts`.
//!
//! Owners: the pool's mutex holds every entry's state; one driver task per process owns the child, its pipes and the
//! `initialize` call, and reports back through the pool under the process's generation, so a late report from a
//! replaced process changes nothing. `acquire` never waits for a start.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_ext::plugins::lsp::ResolvedLspServer;
use serde_json::{Map, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::process::{LaunchError, Launch, Launcher};
use super::rpc::{self, NotificationHandler, ReadEnd, RequestOptions};
use super::server::{
    PULL_DIAGNOSTICS, Registrations, initialize_params, server_requests, workspace_folders,
};
use super::{
    IDLE_SHUTDOWN, LspError, MAX_RUNNING_SERVERS, NOT_INSTALLED_RETRY, STDERR_TAIL_MAX_CHARS,
    UNAVAILABLE_RETRY,
};

/// Node `LanguageServerKey`: the session's identity key and the workspace path.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct ServerKey {
    pub(crate) identity: String,
    pub(crate) workspace: String,
}

/// Node `LanguageServerState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum State {
    Stopped,
    Starting,
    Ready,
    Crashed,
    NotInstalled,
    Unavailable,
}

impl State {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Crashed => "crashed",
            Self::NotInstalled => "not_installed",
            Self::Unavailable => "unavailable",
        }
    }
}

/// Node `LanguageServerAcquireResult`.
pub(crate) enum Acquired {
    Ready(Arc<ServerConnection>),
    Starting,
    Failed(LspError),
}

/// Node `LanguageServerEvent`.
#[derive(Clone)]
pub(crate) enum Event {
    Ready {
        server_id: String,
        key: ServerKey,
        connection: Arc<ServerConnection>,
    },
    Crashed {
        server_id: String,
        key: ServerKey,
    },
    Stopped {
        server_id: String,
        key: ServerKey,
    },
}

pub(crate) type Listener = Arc<dyn Fn(&Event) + Send + Sync>;

/// One entry of the pool's status (Node `LanguageServerStatus`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Status {
    pub(crate) server_id: String,
    pub(crate) key: ServerKey,
    pub(crate) state: State,
    pub(crate) restarts: u64,
    pub(crate) pull: bool,
    pub(crate) last_error_code: Option<&'static str>,
}

/// A ready server as callers use it (Node `LspServerConnection`): every request and notification counts as use.
pub(crate) struct ServerConnection {
    /// Unique per process: a document store belongs to one connection.
    pub(crate) id: u64,
    pub(crate) server: Arc<ResolvedLspServer>,
    rpc: rpc::Connection,
    initialize_capabilities: Map<String, Value>,
    registrations: Arc<Mutex<Registrations>>,
    last_used: Arc<Mutex<Instant>>,
}

impl ServerConnection {
    fn touch(&self) {
        *self.last_used.lock_unpoisoned() = Instant::now();
    }

    /// The `initialize` capabilities with a dynamically registered pull as `diagnosticProvider`.
    pub(crate) fn capabilities(&self) -> Map<String, Value> {
        let mut capabilities = self.initialize_capabilities.clone();
        if let Some(options) = self
            .registrations
            .lock_unpoisoned()
            .options_for(PULL_DIAGNOSTICS)
        {
            capabilities.insert("diagnosticProvider".to_owned(), options);
        }
        capabilities
    }

    /// `capabilities.diagnosticProvider` is truthy (JS).
    pub(crate) fn supports_pull(&self) -> bool {
        match self.capabilities().get("diagnosticProvider") {
            None | Some(Value::Null | Value::Bool(false)) => false,
            Some(Value::String(text)) => !text.is_empty(),
            Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
            Some(_) => true,
        }
    }

    /// The caller's timeout is capped by the server's `requestTimeout`.
    pub(crate) async fn request(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Option<Duration>,
        cancel: Option<&CancellationToken>,
    ) -> Result<Value, LspError> {
        self.touch();
        let server = Duration::from_millis(self.server.request_timeout_ms);
        let options = RequestOptions {
            timeout: Some(timeout.map_or(server, |timeout| timeout.min(server))),
            timeout_code: "lsp_request_timeout",
            cancel,
        };
        self.rpc.request(method, params, options).await
    }

    pub(crate) fn notify(&self, method: &str, params: Option<Value>) {
        self.touch();
        self.rpc.notify(method, params);
    }

    pub(crate) fn subscribe(&self, method: &str, handler: NotificationHandler) -> u64 {
        self.rpc.subscribe(method, handler)
    }

    pub(crate) fn unsubscribe(&self, subscription: u64) {
        self.rpc.unsubscribe(subscription);
    }
}

/// The live process of an entry, as the pool sees it.
struct Running {
    generation: u64,
    rpc: rpc::Connection,
    registrations: Arc<Mutex<Registrations>>,
    capabilities: Option<Map<String, Value>>,
    /// Taken by the first stop request (Node `stopRequested`).
    stop: Option<oneshot::Sender<()>>,
    done: watch::Receiver<bool>,
}

/// Node `LspServerEntry`.
struct Entry {
    server: Arc<ResolvedLspServer>,
    state: State,
    restarts: u64,
    last_used: Arc<Mutex<Instant>>,
    last_error: Option<LspError>,
    not_installed_at: Option<Instant>,
    unavailable_at: Option<Instant>,
    process: Option<Running>,
    connection: Option<Arc<ServerConnection>>,
    /// A stop in progress (Node `stopping`): resolves when the driver reports it stopped.
    stopping: Option<watch::Receiver<bool>>,
    idle: Option<rust_cli_base::OwnedTask<()>>,
}

impl Entry {
    fn last_used(&self) -> Instant {
        *self.last_used.lock_unpoisoned()
    }

    fn in_flight(&self) -> usize {
        self.process
            .as_ref()
            .map_or(0, |process| process.rpc.in_flight())
    }

    /// Node `detach` (the stop signal and the idle task go with the process).
    fn detach(&mut self) {
        self.process = None;
        self.connection = None;
        self.idle = None;
    }

    /// Node `failedResult`.
    fn failed(&self, server_id: &str) -> LspError {
        if self.state == State::Unavailable {
            let last = self
                .last_error
                .as_ref()
                .map(|error| format!(" (last error: {})", error.code))
                .unwrap_or_default();
            return LspError::new(
                "lsp_server_unavailable",
                format!(
                    "{server_id} is unavailable after {} restarts{last}",
                    self.restarts
                ),
            );
        }
        self.last_error.clone().unwrap_or_else(|| {
            LspError::new(
                "lsp_server_unavailable",
                format!("{server_id} is {}", self.state.as_str()),
            )
        })
    }
}

type PoolKey = (String, ServerKey);

/// The pool's bounds (Node `LanguageServerPoolOptions`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Limits {
    pub(crate) idle_shutdown: Duration,
    pub(crate) max_running: usize,
    pub(crate) not_installed_retry: Duration,
    pub(crate) unavailable_retry: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            idle_shutdown: IDLE_SHUTDOWN,
            max_running: MAX_RUNNING_SERVERS,
            not_installed_retry: NOT_INSTALLED_RETRY,
            unavailable_retry: UNAVAILABLE_RETRY,
        }
    }
}

struct Inner {
    launcher: Arc<dyn Launcher>,
    /// The stdio-server projection of the process environment; each server's `env` goes on top.
    base_env: Vec<(String, String)>,
    windows: bool,
    limits: Limits,
    generations: AtomicU64,
    entries: Mutex<HashMap<PoolKey, Entry>>,
    listeners: Mutex<Vec<(u64, Listener)>>,
}

/// Node `createLanguageServerPool`. Cheap to clone.
#[derive(Clone)]
pub(crate) struct Pool(Arc<Inner>);

impl Pool {
    pub(crate) fn new(
        launcher: Arc<dyn Launcher>,
        base_env: Vec<(String, String)>,
        windows: bool,
        limits: Limits,
    ) -> Self {
        Self(Arc::new(Inner {
            launcher,
            base_env,
            windows,
            limits,
            generations: AtomicU64::new(1),
            entries: Mutex::default(),
            listeners: Mutex::default(),
        }))
    }

    pub(crate) fn subscribe(&self, listener: Listener) -> u64 {
        let id = self.0.generations.fetch_add(1, Ordering::Relaxed);
        self.0.listeners.lock_unpoisoned().push((id, listener));
        id
    }

    pub(crate) fn unsubscribe(&self, id: u64) {
        self.0
            .listeners
            .lock_unpoisoned()
            .retain(|(known, _)| *known != id);
    }

    /// Node `acquire`: never waits for a start.
    pub(crate) fn acquire(&self, server: &Arc<ResolvedLspServer>, key: &ServerKey) -> Acquired {
        let mut entries = self.0.entries.lock_unpoisoned();
        let pool_key = (server.id.clone(), key.clone());
        let entry = entries
            .entry(pool_key.clone())
            .or_insert_with(|| Entry {
                server: Arc::clone(server),
                state: State::Stopped,
                restarts: 0,
                last_used: Arc::new(Mutex::new(Instant::now())),
                last_error: None,
                not_installed_at: None,
                unavailable_at: None,
                process: None,
                connection: None,
                stopping: None,
                idle: None,
            });
        entry.server = Arc::clone(server);
        *entry.last_used.lock_unpoisoned() = Instant::now();
        if entry.stopping.is_some() {
            return Acquired::Starting;
        }
        let now = Instant::now();
        let limits = self.0.limits;
        match entry.state {
            State::Ready => entry
                .connection
                .clone()
                .map_or(Acquired::Starting, Acquired::Ready),
            State::Starting => Acquired::Starting,
            State::Stopped => self.start_fresh(&mut entries, &pool_key),
            State::NotInstalled => {
                if entry
                    .not_installed_at
                    .is_some_and(|at| now < at + limits.not_installed_retry)
                {
                    return Acquired::Failed(entry.failed(&server.id));
                }
                self.start_fresh(&mut entries, &pool_key)
            }
            State::Crashed => {
                if server.restart_on_crash && entry.restarts < server.max_restarts {
                    entry.restarts += 1;
                    tracing::info!(event = "adapters.lsp.restart", server_id = %server.id, restarts = entry.restarts, "LSP server restarting");
                    return self.start_fresh(&mut entries, &pool_key);
                }
                entry.state = State::Unavailable;
                entry.unavailable_at = server.restart_on_crash.then_some(now);
                tracing::warn!(
                    event = "adapters.lsp.unavailable",
                    server_id = %server.id,
                    restarts = entry.restarts,
                    last_error_code = entry.last_error.as_ref().map(|error| error.code),
                    "LSP server unavailable after failed starts"
                );
                Acquired::Failed(entry.failed(&server.id))
            }
            State::Unavailable => {
                let Some(at) = entry.unavailable_at else {
                    return Acquired::Failed(entry.failed(&server.id));
                };
                if now < at + limits.unavailable_retry {
                    return Acquired::Failed(entry.failed(&server.id));
                }
                entry.unavailable_at = None;
                tracing::info!(event = "adapters.lsp.retry", server_id = %server.id, restarts = entry.restarts, "LSP server retrying after unavailable window");
                self.start_fresh(&mut entries, &pool_key)
            }
        }
    }

    /// Node `startFresh` + `startServerProcess`: room is made first, then the driver task starts.
    fn start_fresh(&self, entries: &mut HashMap<PoolKey, Entry>, pool_key: &PoolKey) -> Acquired {
        self.ensure_capacity(entries, pool_key);
        let Some(entry) = entries.get_mut(pool_key) else {
            return Acquired::Starting;
        };
        let server = Arc::clone(&entry.server);
        let workspace = &pool_key.1.workspace;
        entry.state = State::Starting;
        entry.last_error = None;
        let folders = match workspace_folders(&server, workspace, self.0.windows) {
            Ok(folders) => folders,
            Err(error) => {
                // Node `recordStartFailure`: a start that cannot even be built is a crash.
                tracing::warn!(event = "adapters.lsp.start_failed", server_id = %server.id, code = error.code, "LSP server failed to start");
                entry.state = State::Crashed;
                entry.last_error = Some(error);
                return Acquired::Failed(entry.failed(&server.id));
            }
        };
        let params = initialize_params(
            &server,
            workspace,
            &folders,
            std::process::id(),
            self.0.windows,
        );
        let registrations = Arc::new(Mutex::new(Registrations::default()));
        let requests = server_requests(
            server.settings.clone(),
            folders,
            Arc::clone(&registrations),
        );
        let (connection, outbox) = rpc::Connection::new(&server.id, requests);
        let (stop, stopped) = oneshot::channel();
        let (done, done_rx) = watch::channel(false);
        let generation = self.0.generations.fetch_add(1, Ordering::Relaxed);
        entry.process = Some(Running {
            generation,
            rpc: connection.clone(),
            registrations,
            capabilities: None,
            stop: Some(stop),
            done: done_rx,
        });
        let launch = Launch {
            command: server.command.clone(),
            args: server.args.clone(),
            cwd: workspace.clone(),
            env: merge_env(&self.0.base_env, &server.env, self.0.windows),
        };
        let driver = Driver {
            pool: Arc::downgrade(&self.0),
            launcher: Arc::clone(&self.0.launcher),
            pool_key: pool_key.clone(),
            generation,
            server,
            launch,
            params,
            rpc: connection,
            outbox,
            stopped,
            done,
        };
        // Detached: the driver ends with its process. Dropping the pool drops each stop sender, which stops it.
        drop(tokio::spawn(driver.run()));
        Acquired::Starting
    }

    /// Node `ensureCapacity`: the least recently used idle servers stop to make room for one more.
    fn ensure_capacity(&self, entries: &mut HashMap<PoolKey, Entry>, target: &PoolKey) {
        let live: Vec<&PoolKey> = entries
            .iter()
            .filter(|(key, entry)| *key != target && entry.process.is_some())
            .map(|(key, _)| key)
            .collect();
        let excess = (live.len() + 1).saturating_sub(self.0.limits.max_running);
        if excess == 0 {
            return;
        }
        let running: Vec<&PoolKey> = live
            .into_iter()
            .filter(|key| entries[*key].stopping.is_none())
            .collect();
        let mut idle: Vec<(Instant, PoolKey)> = running
            .iter()
            .filter(|key| entries[**key].in_flight() == 0)
            .map(|key| (entries[*key].last_used(), (*key).clone()))
            .collect();
        idle.sort_by_key(|(last_used, _)| *last_used);
        if idle.len() < excess {
            tracing::warn!(
                event = "adapters.lsp.cap_exceeded",
                running = running.len(),
                max_running_servers = self.0.limits.max_running,
                "LSP running-server cap exceeded because every server has requests in flight"
            );
        }
        for (_, victim) in idle.into_iter().take(excess) {
            tracing::info!(event = "adapters.lsp.evicted", server_id = %victim.0, "LSP server evicted by LRU cap");
            if let Some(entry) = entries.get_mut(&victim) {
                let _ = request_stop(entry);
            }
        }
    }

    /// Node `stopAll`: every server stops gracefully; returns when all have.
    pub(crate) async fn stop_all(&self) {
        let waits: Vec<watch::Receiver<bool>> = self
            .0
            .entries
            .lock_unpoisoned()
            .values_mut()
            .filter_map(request_stop)
            .collect();
        for mut wait in waits {
            let _ = wait.wait_for(|done| *done).await;
        }
    }

    /// Node `status`: every entry, with `pull` from the live process's capabilities or registrations.
    pub(crate) fn status(&self) -> Vec<Status> {
        self.0
            .entries
            .lock_unpoisoned()
            .iter()
            .map(|((server_id, key), entry)| {
                let pull = entry.process.as_ref().is_some_and(|process| {
                    let provider = process
                        .capabilities
                        .as_ref()
                        .and_then(|capabilities| capabilities.get("diagnosticProvider"));
                    matches!(provider, Some(value) if *value != Value::Bool(false))
                        || process
                            .registrations
                            .lock_unpoisoned()
                            .options_for(PULL_DIAGNOSTICS)
                            .is_some()
                });
                Status {
                    server_id: server_id.clone(),
                    key: key.clone(),
                    state: entry.state,
                    restarts: entry.restarts,
                    pull,
                    last_error_code: entry.last_error.as_ref().map(|error| error.code),
                }
            })
            .collect()
    }
}

/// Node `stopServerProcess`: concurrent stops share one; an entry without a process only changes state.
fn request_stop(entry: &mut Entry) -> Option<watch::Receiver<bool>> {
    if let Some(stopping) = &entry.stopping {
        return Some(stopping.clone());
    }
    let Some(process) = entry.process.as_mut() else {
        if matches!(entry.state, State::Ready | State::Starting) {
            entry.state = State::Stopped;
        }
        return None;
    };
    if let Some(stop) = process.stop.take() {
        let _ = stop.send(());
    }
    entry.idle = None;
    let done = process.done.clone();
    entry.stopping = Some(done.clone());
    Some(done)
}

/// Node `buildLspProcessEnv`: the server's `env` on top; on Windows a server key replaces every key that differs only
/// in case, and the new key goes last.
pub(crate) fn merge_env(
    base: &[(String, String)],
    server: &[(String, String)],
    windows: bool,
) -> Vec<(String, String)> {
    let mut env = base.to_vec();
    for (key, value) in server {
        if windows {
            env.retain(|(existing, _)| !existing.eq_ignore_ascii_case(key));
            env.push((key.clone(), value.clone()));
        } else {
            match env.iter_mut().find(|(existing, _)| existing == key) {
                Some(slot) => slot.1.clone_from(value),
                None => env.push((key.clone(), value.clone())),
            }
        }
    }
    env
}

/// Why the running phase of a process ended.
enum End {
    Exited(String),
    Failed(LspError),
    Stop,
}

/// One process's life: launch, `initialize`, run until exit, failure or a stop request, then end the tree and report.
struct Driver {
    pool: Weak<Inner>,
    launcher: Arc<dyn Launcher>,
    pool_key: PoolKey,
    generation: u64,
    server: Arc<ResolvedLspServer>,
    launch: Launch,
    params: Value,
    rpc: rpc::Connection,
    outbox: rpc::Outbox,
    stopped: oneshot::Receiver<()>,
    done: watch::Sender<bool>,
}

impl Driver {
    async fn run(self) {
        let Self {
            pool,
            launcher,
            pool_key,
            generation,
            server,
            launch,
            params,
            rpc,
            outbox,
            mut stopped,
            done,
        } = self;
        let report = Report {
            pool,
            pool_key,
            generation,
            server: Arc::clone(&server),
        };
        let launched = match launcher.launch(launch).await {
            Ok(launched) => launched,
            Err(error) => {
                report.spawn_failed(&error, &rpc);
                let _ = done.send(true);
                return;
            }
        };
        tracing::info!(event = "adapters.lsp.spawned", server_id = %server.id, pid = launched.pid, "LSP server spawned");
        let mut process = launched.process;
        let tail = Arc::new(Mutex::new(String::new()));
        let stderr = read_stderr(launched.stderr, Arc::clone(&tail));
        tokio::pin!(stderr);
        let pump = rpc::pump(rpc.clone(), outbox, launched.stdin, launched.stdout);
        tokio::pin!(pump);
        let startup = RequestOptions {
            timeout: Some(Duration::from_millis(server.startup_timeout_ms)),
            timeout_code: "lsp_startup_timeout",
            cancel: None,
        };
        let initialize = rpc.request("initialize", Some(params), startup);
        tokio::pin!(initialize);
        let (mut initialized, mut initializing, mut pumping, mut reading) =
            (false, true, true, true);
        let end = loop {
            tokio::select! {
                result = &mut initialize, if initializing => {
                    initializing = false;
                    match result {
                        Ok(result) => initialized = report.initialized(&result, &rpc),
                        Err(error) => break End::Failed(error),
                    }
                }
                read = &mut pump, if pumping => {
                    pumping = false;
                    if let ReadEnd::Invalid(error) = read {
                        tracing::warn!(event = "adapters.lsp.protocol_error", server_id = %server.id, pid = launched.pid, "LSP stream is not valid JSON-RPC; treating server as crashed");
                        drop(error);
                        let code = if initialized { "lsp_server_crashed" } else { "lsp_server_start_failed" };
                        break End::Failed(LspError::new(code, format!("{} sent an invalid LSP frame", server.id)));
                    }
                }
                () = &mut stderr, if reading => reading = false,
                detail = process.wait() => break End::Exited(detail),
                _ = &mut stopped => break End::Stop,
            }
        };
        let exited = matches!(end, End::Exited(_));
        let failure = match end {
            End::Exited(detail) => Some(if initialized {
                LspError::new("lsp_server_crashed", format!("{} {detail}", server.id))
            } else {
                LspError::new(
                    "lsp_server_start_failed",
                    format!("{} {detail} before initialization", server.id),
                )
            }),
            End::Failed(error) => Some(error),
            End::Stop => None,
        };
        // A failure after a stop request is the stop's to finish (Node `failProcess` returns on `stopRequested`).
        if let Some(error) = failure
            && report.failed(error, &tail, initialized, &rpc)
        {
            process.terminate().await;
            let _ = done.send(true);
            return;
        }
        // Node `gracefulStop`. The pipes keep being read so the `shutdown` answer arrives.
        let started = Instant::now();
        let mut exited_in_time = exited;
        if initialized && !exited {
            let shutdown_timeout = Duration::from_millis(server.shutdown_timeout_ms);
            let graceful = async {
                if let Err(error) = rpc
                    .request("shutdown", None, RequestOptions::timeout(shutdown_timeout))
                    .await
                {
                    tracing::warn!(event = "adapters.lsp.shutdown_failed", server_id = %server.id, code = error.code, "LSP shutdown request did not complete; sending exit");
                }
                rpc.notify("exit", None);
                tokio::time::timeout(shutdown_timeout, process.wait())
                    .await
                    .is_ok()
            };
            let io = async {
                tokio::join!(
                    async {
                        if pumping {
                            let _ = (&mut pump).await;
                        }
                    },
                    async {
                        if reading {
                            (&mut stderr).await;
                        }
                    }
                );
                std::future::pending::<bool>().await
            };
            exited_in_time = tokio::select! {
                exited = graceful => exited,
                never = io => never,
            };
        }
        if !exited_in_time {
            tracing::warn!(event = "adapters.lsp.forced_kill", server_id = %server.id, "LSP server did not exit in time; killing process tree");
        }
        process.terminate().await;
        report.stopped(&rpc, started);
        let _ = done.send(true);
    }
}

/// Keeps the last [`STDERR_TAIL_MAX_CHARS`] characters of stderr; never logged.
async fn read_stderr(mut stderr: Box<dyn AsyncRead + Send + Unpin>, tail: Arc<Mutex<String>>) {
    let mut buffer = [0_u8; 4_096];
    loop {
        match stderr.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                let mut tail = tail.lock_unpoisoned();
                tail.push_str(&String::from_utf8_lossy(&buffer[..read]));
                let extra = tail.chars().count().saturating_sub(STDERR_TAIL_MAX_CHARS);
                if extra > 0 {
                    let cut = tail.char_indices().nth(extra).map_or(tail.len(), |(at, _)| at);
                    tail.drain(..cut);
                }
            }
        }
    }
}

/// The driver's reports into the pool; each applies only while the entry still holds this process.
struct Report {
    pool: Weak<Inner>,
    pool_key: PoolKey,
    generation: u64,
    server: Arc<ResolvedLspServer>,
}

impl Report {
    /// Runs `apply` on the entry when it still holds this process; the events it returns go out after the lock.
    fn with_entry<T>(&self, apply: impl FnOnce(&Inner, &mut Entry) -> (T, Option<Event>)) -> Option<T> {
        let pool = self.pool.upgrade()?;
        let (value, event) = {
            let mut entries = pool.entries.lock_unpoisoned();
            let entry = entries.get_mut(&self.pool_key)?;
            if entry
                .process
                .as_ref()
                .is_none_or(|process| process.generation != self.generation)
            {
                return None;
            }
            apply(&pool, entry)
        };
        if let Some(event) = event {
            let listeners: Vec<Listener> = pool
                .listeners
                .lock_unpoisoned()
                .iter()
                .map(|(_, listener)| Arc::clone(listener))
                .collect();
            for listener in listeners {
                listener(&event);
            }
        }
        Some(value)
    }

    fn stop_requested(entry: &Entry) -> bool {
        entry
            .process
            .as_ref()
            .is_none_or(|process| process.stop.is_none())
    }

    /// Node `handleSpawnError`.
    fn spawn_failed(&self, error: &LaunchError, rpc: &rpc::Connection) {
        let server = Arc::clone(&self.server);
        let stopping = self.with_entry(|_, entry| {
            if Self::stop_requested(entry) {
                return (true, None);
            }
            entry.detach();
            let closed = match error {
                LaunchError::NotFound => {
                    let message = format!("command \"{}\" was not found", server.command);
                    entry.state = State::NotInstalled;
                    entry.not_installed_at = Some(Instant::now());
                    entry.last_error = Some(LspError::new("lsp_server_not_installed", message.clone()));
                    tracing::warn!(event = "adapters.lsp.not_installed", server_id = %server.id, "LSP server command is not installed");
                    LspError::new("lsp_server_not_installed", format!("{}: {message}", server.id))
                }
                LaunchError::Other(code) => {
                    let message = format!("failed to spawn ({code})");
                    entry.state = State::Crashed;
                    entry.last_error = Some(LspError::new("lsp_server_start_failed", message.clone()));
                    tracing::warn!(event = "adapters.lsp.start_failed", server_id = %server.id, code = %code, "LSP server failed to spawn");
                    LspError::new("lsp_server_start_failed", format!("{}: {message}", server.id))
                }
            };
            rpc.close(&closed);
            (false, None)
        });
        if stopping == Some(true) {
            self.stopped(rpc, Instant::now());
        }
    }

    /// Node `onInitialized`. False when a stop came first.
    fn initialized(&self, result: &Value, rpc: &rpc::Connection) -> bool {
        let server = Arc::clone(&self.server);
        let key = self.pool_key.1.clone();
        let pool_key = self.pool_key.clone();
        let generation = self.generation;
        self.with_entry(|pool, entry| {
            if Self::stop_requested(entry) {
                return (false, None);
            }
            let capabilities = result
                .get("capabilities")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            rpc.notify("initialized", Some(Value::Object(Map::new())));
            if let Some(settings) = &server.settings {
                rpc.notify(
                    "workspace/didChangeConfiguration",
                    Some(serde_json::json!({"settings": settings})),
                );
            }
            let Some(process) = entry.process.as_mut() else {
                return (false, None);
            };
            process.capabilities = Some(capabilities.clone());
            let connection = Arc::new(ServerConnection {
                id: generation,
                server: Arc::clone(&server),
                rpc: rpc.clone(),
                initialize_capabilities: capabilities,
                registrations: Arc::clone(&process.registrations),
                last_used: Arc::clone(&entry.last_used),
            });
            entry.state = State::Ready;
            entry.restarts = 0;
            entry.last_error = None;
            entry.connection = Some(Arc::clone(&connection));
            entry.idle = Some(rust_cli_base::owned(idle_loop(
                Weak::clone(&self.pool),
                pool_key,
                generation,
                pool.limits.idle_shutdown,
            )));
            tracing::info!(event = "adapters.lsp.ready", server_id = %server.id, "LSP server ready");
            let event = Event::Ready {
                server_id: server.id.clone(),
                key,
                connection,
            };
            (true, Some(event))
        })
        .unwrap_or(false)
    }

    /// Node `failProcess`. False when a stop was requested: the stop finishes the process instead.
    fn failed(&self, error: LspError, tail: &Mutex<String>, initialized: bool, rpc: &rpc::Connection) -> bool {
        let server = Arc::clone(&self.server);
        let key = self.pool_key.1.clone();
        self.with_entry(|_, entry| {
            if Self::stop_requested(entry) {
                return (false, None);
            }
            entry.detach();
            let message = if initialized {
                error.message.clone()
            } else {
                let tail = tail.lock_unpoisoned();
                match tail.trim() {
                    "" => error.message.clone(),
                    tail => format!("{}; stderr tail: {tail}", error.message),
                }
            };
            entry.state = State::Crashed;
            entry.last_error = Some(LspError::new(error.code, message.clone()));
            rpc.close(&LspError::new("lsp_server_crashed", message));
            if initialized {
                tracing::info!(event = "adapters.lsp.crashed", server_id = %server.id, code = error.code, "LSP server crashed");
                let event = Event::Crashed {
                    server_id: server.id.clone(),
                    key,
                };
                return (true, Some(event));
            }
            tracing::warn!(event = "adapters.lsp.start_failed", server_id = %server.id, code = error.code, "LSP server failed to start");
            (true, None)
        })
        // The entry no longer holds this process: nothing to report, but the tree still ends.
        .unwrap_or(true)
    }

    /// The end of Node `gracefulStop`.
    fn stopped(&self, rpc: &rpc::Connection, started: Instant) {
        let server = Arc::clone(&self.server);
        let key = self.pool_key.1.clone();
        rpc.close(&LspError::new(
            "lsp_server_unavailable",
            format!("{} was stopped", server.id),
        ));
        self.with_entry(|_, entry| {
            entry.detach();
            entry.stopping = None;
            entry.state = State::Stopped;
            tracing::info!(event = "adapters.lsp.stopped", server_id = %server.id, duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX), "LSP server stopped");
            let event = Event::Stopped {
                server_id: server.id.clone(),
                key,
            };
            ((), Some(event))
        });
    }
}

/// Node `scheduleIdleCheck` / `onIdleCheck`: a server unused for the idle window with nothing in flight stops.
async fn idle_loop(pool: Weak<Inner>, pool_key: PoolKey, generation: u64, idle: Duration) {
    let mut delay = idle;
    loop {
        tokio::time::sleep(delay).await;
        let Some(pool) = pool.upgrade() else {
            return;
        };
        let mut entries = pool.entries.lock_unpoisoned();
        let Some(entry) = entries.get_mut(&pool_key) else {
            return;
        };
        let current = entry
            .process
            .as_ref()
            .is_some_and(|process| process.generation == generation);
        if !current || entry.stopping.is_some() {
            return;
        }
        let in_flight = entry.in_flight();
        let idle_for = entry.last_used().elapsed();
        if in_flight == 0 && idle_for >= idle {
            tracing::info!(event = "adapters.lsp.idle_stop", server_id = %pool_key.0, "LSP server idle, stopping");
            // Dropping the entry's idle task (this one) aborts it at its next await; it returns before any.
            let _ = request_stop(entry);
            return;
        }
        delay = if in_flight > 0 {
            idle
        } else {
            (idle - idle_for).max(Duration::from_millis(1))
        };
    }
}

#[cfg(test)]
#[path = "pool_tests.rs"]
mod tests;
