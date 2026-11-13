//! One resident agent process and its ACP session (Node `AcpSessionRuntime`, `runtime.ts`; spec
//! specs/acp-agent-runtime.md "Runtime").
//!
//! States: starting → ready ⇄ prompting; any → failed (exit, stream failure, handshake failure); stop → stopped.
//! A failed runtime restarts (and tries to load its last session) before the next prompt. Every process gets a
//! new generation; reports of an older process are ignored, as are updates of another ACP session (a
//! `session/load` replay arrives before the session id is committed, so it is never surfaced).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_proc::ledger::{Containment, Isolation, Ledger, Purpose};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::config::{ConfigOption, ConfigRequest, ConfigState};
use crate::error::{AcpError, AcpErrorCode};
use crate::launch::{AcpLaunch, child_env, validate};
use crate::rpc::{self, Answer, Inbound, Peer, PumpHandle, PumpTimings};
use crate::updates::{
    PermissionAnswer, RuntimeEvent, map_update, permission_ask, permission_response,
};

/// The ACP protocol version this runtime speaks.
const PROTOCOL_VERSION: u64 = 1;

/// Timeouts and graces (Node `DEFAULT_TIMEOUTS` of `runtime.ts`).
#[derive(Debug, Clone, Copy)]
pub struct AcpTimeouts {
    pub initialize: Duration,
    /// `session/new`, `session/load`, `session/set_config_option`, `session/set_mode`.
    pub new_session: Duration,
    /// How long a cancelled prompt may take to settle before the process is terminated.
    pub cancel_grace: Duration,
    /// How long the agent may take to exit after stdin is closed.
    pub stop_grace: Duration,
    /// Silence during a prompt before a stall is reported.
    pub stall_warning: Duration,
    /// After stdout ends, how long to wait for the exit before the stream counts as failed.
    pub death_grace: Duration,
}

impl Default for AcpTimeouts {
    fn default() -> Self {
        Self {
            initialize: Duration::from_secs(30),
            new_session: Duration::from_secs(30),
            cancel_grace: Duration::from_secs(10),
            stop_grace: Duration::from_secs(2),
            stall_warning: Duration::from_secs(120),
            death_grace: Duration::from_secs(1),
        }
    }
}

/// Poll interval while a cancelled prompt settles (`waitUntil`).
const CANCEL_POLL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpState {
    Starting,
    Ready,
    Prompting,
    Stopped,
    Failed,
}

/// How the latest ACP session began (`AcpSessionStart`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStart {
    /// No earlier session to load.
    Created,
    /// The earlier session was loaded.
    Loaded,
    /// The earlier session could not be loaded; a new one replaced it.
    Reset,
}

/// What starting a runtime needs.
#[derive(Clone)]
pub struct AcpRuntimeOptions {
    pub launch: AcpLaunch,
    /// The process environment captured by the entry crate.
    pub env_snapshot: Arc<[(String, String)]>,
    pub ledger: Ledger,
    /// The ACP session to load (from the session binding).
    pub resume_session_id: Option<String>,
    pub timeouts: AcpTimeouts,
}

/// The answer of `session/prompt`.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptResponse {
    pub stop_reason: String,
    pub usage: Option<Value>,
}

struct ActivePrompt {
    id: u64,
    generation: u64,
    reject: Option<oneshot::Sender<AcpError>>,
    last_activity: Instant,
    stall_emitted: bool,
    resumed_emitted: bool,
}

struct Core {
    state: AcpState,
    generation: u64,
    peer: Option<Arc<Peer>>,
    pump: Option<(u64, Arc<PumpHandle>)>,
    session_id: Option<String>,
    resume_target: Option<String>,
    session_start: Option<SessionStart>,
    config: ConfigState,
    active: Option<ActivePrompt>,
    next_prompt: u64,
    pending_asks: HashMap<String, CancellationToken>,
    next_ask: u64,
    stop_requested: bool,
    exited_generation: Option<u64>,
    listener: Option<mpsc::UnboundedSender<RuntimeEvent>>,
    ignored_updates: u64,
}

impl Core {
    fn emit(&self, event: RuntimeEvent) {
        if let Some(listener) = &self.listener {
            let _ = listener.send(event);
        }
    }

    fn cancel_asks(&mut self) {
        for (_, token) in self.pending_asks.drain() {
            token.cancel();
        }
    }
}

struct Inner {
    options: AcpRuntimeOptions,
    core: Mutex<Core>,
    stderr_tail: Arc<Mutex<String>>,
}

/// A resident ACP agent. Cloning shares the same process.
#[derive(Clone)]
pub struct AcpRuntime {
    inner: Arc<Inner>,
}

/// Unbinds the turn's listener when dropped (only if it is still the bound one).
pub struct ListenerGuard {
    inner: Weak<Inner>,
    listener: mpsc::UnboundedSender<RuntimeEvent>,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.upgrade() {
            let mut core = inner.core.lock_unpoisoned();
            if core
                .listener
                .as_ref()
                .is_some_and(|bound| bound.same_channel(&self.listener))
            {
                core.listener = None;
            }
        }
    }
}

impl AcpRuntime {
    /// Spawns the agent and performs the handshake (`AcpSessionRuntime.start`).
    pub async fn start(options: AcpRuntimeOptions) -> Result<Self, AcpError> {
        let resume_target = options.resume_session_id.clone();
        let runtime = Self {
            inner: Arc::new(Inner {
                options,
                core: Mutex::new(Core {
                    state: AcpState::Starting,
                    generation: 0,
                    peer: None,
                    pump: None,
                    session_id: None,
                    resume_target,
                    session_start: None,
                    config: ConfigState::default(),
                    active: None,
                    next_prompt: 0,
                    pending_asks: HashMap::new(),
                    next_ask: 0,
                    stop_requested: false,
                    exited_generation: None,
                    listener: None,
                    ignored_updates: 0,
                }),
                stderr_tail: Arc::new(Mutex::new(String::new())),
            }),
        };
        runtime.connect().await?;
        Ok(runtime)
    }

    pub fn state(&self) -> AcpState {
        self.inner.core.lock_unpoisoned().state
    }

    /// The ACP session id of the current session.
    pub fn session_id(&self) -> Option<String> {
        self.inner.core.lock_unpoisoned().session_id.clone()
    }

    /// How the latest session began; read once.
    pub fn take_session_start(&self) -> Option<SessionStart> {
        self.inner.core.lock_unpoisoned().session_start.take()
    }

    pub fn config_options(&self) -> Vec<ConfigOption> {
        self.inner.core.lock_unpoisoned().config.options().to_vec()
    }

    /// The options of the handshake with their starting values (what the agent catalog stores).
    pub fn handshake_config_options(&self) -> Vec<ConfigOption> {
        self.inner
            .core
            .lock_unpoisoned()
            .config
            .handshake_options()
            .to_vec()
    }

    /// Updates that were not surfaced (other generation, other session, unknown kind).
    pub fn ignored_updates(&self) -> u64 {
        self.inner.core.lock_unpoisoned().ignored_updates
    }

    /// The last 64 KiB of the agent's stderr.
    pub fn stderr_tail(&self) -> String {
        self.inner.stderr_tail.lock_unpoisoned().clone()
    }

    /// Binds the turn that receives this runtime's events and permission asks until the guard drops.
    /// Without a bound turn events are dropped and asks are answered cancelled.
    pub fn bind(&self) -> (mpsc::UnboundedReceiver<RuntimeEvent>, ListenerGuard) {
        let (sender, receiver) = mpsc::unbounded_channel();
        self.inner.core.lock_unpoisoned().listener = Some(sender.clone());
        (
            receiver,
            ListenerGuard {
                inner: Arc::downgrade(&self.inner),
                listener: sender,
            },
        )
    }

    /// Sends one prompt; restarts a failed runtime first.
    pub async fn prompt(&self, blocks: Vec<Value>) -> Result<PromptResponse, AcpError> {
        if self.state() == AcpState::Failed {
            self.restart().await?;
        }
        let (peer, session_id, prompt_id, mut rejected) = {
            let mut core = self.inner.core.lock_unpoisoned();
            if core.state != AcpState::Ready {
                return Err(AcpError::state(format!(
                    "Cannot prompt while the runtime is \"{}\"",
                    state_name(core.state)
                )));
            }
            let (Some(peer), Some(session_id)) = (core.peer.clone(), core.session_id.clone())
            else {
                return Err(AcpError::state("ACP session is not established"));
            };
            let (reject, rejected) = oneshot::channel();
            core.next_prompt += 1;
            let id = core.next_prompt;
            core.active = Some(ActivePrompt {
                id,
                generation: core.generation,
                reject: Some(reject),
                last_activity: Instant::now(),
                stall_emitted: false,
                resumed_emitted: false,
            });
            core.state = AcpState::Prompting;
            (peer, session_id, id, rejected)
        };
        let request = peer.request(
            "session/prompt",
            json!({"sessionId": session_id, "prompt": blocks}),
            None,
        );
        tokio::pin!(request);
        let stall = self.watch_stall(prompt_id);
        tokio::pin!(stall);
        // Biased: the pump can settle the answer and report the exit in one poll (lines drained before the exit);
        // an answer that arrived first wins, as in Node, where the response resolves the prompt before `exit`.
        let outcome = tokio::select! {
            biased;
            outcome = &mut request => outcome.map_err(|error| match error.code {
                AcpErrorCode::StreamClosed => AcpError::died("Agent process died during the prompt"),
                _ => error,
            }),
            error = &mut rejected => Err(error.unwrap_or_else(|_| AcpError::died("Agent process died during the prompt"))),
            () = &mut stall => Err(AcpError::state("stall watch ended")),
        };
        {
            let mut core = self.inner.core.lock_unpoisoned();
            if core
                .active
                .as_ref()
                .is_some_and(|active| active.id == prompt_id)
            {
                core.active = None;
            }
            // A dead connection can wake the prompt before the pump reports the exit: the runtime is failed then,
            // never ready, so the next prompt restarts it.
            let died = outcome.as_ref().is_err_and(|error| {
                matches!(
                    error.code,
                    AcpErrorCode::AgentDied | AcpErrorCode::StreamClosed
                )
            });
            if core.state == AcpState::Prompting {
                core.state = if died {
                    AcpState::Failed
                } else {
                    AcpState::Ready
                };
            }
        }
        let response = outcome?;
        Ok(PromptResponse {
            stop_reason: response
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn")
                .to_owned(),
            usage: response
                .get("usage")
                .filter(|usage| !usage.is_null())
                .cloned(),
        })
    }

    /// Emits `stalled` once when the prompt is silent for the stall window; never completes.
    async fn watch_stall(&self, prompt_id: u64) {
        let window = self.inner.options.timeouts.stall_warning;
        loop {
            let deadline = {
                let mut core = self.inner.core.lock_unpoisoned();
                let Some(active) = core.active.as_mut().filter(|active| active.id == prompt_id)
                else {
                    break;
                };
                if active.stall_emitted {
                    break;
                }
                let deadline = active.last_activity + window;
                if Instant::now() >= deadline {
                    active.stall_emitted = true;
                    let silent_ms = active.last_activity.elapsed().as_millis();
                    core.emit(RuntimeEvent::Stalled {
                        silent_ms: u64::try_from(silent_ms).unwrap_or(u64::MAX),
                    });
                    break;
                }
                deadline
            };
            tokio::time::sleep_until(deadline).await;
        }
        std::future::pending::<()>().await;
    }

    /// Cancels the running prompt: pending asks are answered cancelled, `session/cancel` is sent, and a prompt that
    /// does not settle within the cancel grace has its process terminated (`runAcpCancel`).
    pub async fn cancel(&self) {
        let (peer, session_id, prompt_id, generation) = {
            let mut core = self.inner.core.lock_unpoisoned();
            let (Some(peer), Some(session_id), Some(active)) = (
                core.peer.clone(),
                core.session_id.clone(),
                core.active.as_ref(),
            ) else {
                return;
            };
            let ids = (active.id, active.generation);
            core.cancel_asks();
            (peer, session_id, ids.0, ids.1)
        };
        peer.notify("session/cancel", json!({"sessionId": session_id}));
        let deadline = Instant::now() + self.inner.options.timeouts.cancel_grace;
        loop {
            let same_turn = {
                let core = self.inner.core.lock_unpoisoned();
                core.generation == generation
                    && core
                        .active
                        .as_ref()
                        .is_some_and(|active| active.id == prompt_id)
            };
            if !same_turn {
                return;
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(CANCEL_POLL).await;
        }
        self.terminate(AcpError::cancelled(
            "The agent did not stop after the cancel",
        ))
        .await;
    }

    /// Stops the agent for good. Safe to call repeatedly.
    pub async fn stop(&self) {
        {
            let mut core = self.inner.core.lock_unpoisoned();
            core.stop_requested = true;
            core.state = AcpState::Stopped;
            core.cancel_asks();
        }
        self.terminate(AcpError::cancelled("Runtime stopped")).await;
    }

    /// Restarts a failed runtime (loading its last session when the agent can). Does nothing otherwise.
    pub async fn restart(&self) -> Result<(), AcpError> {
        {
            let core = self.inner.core.lock_unpoisoned();
            if core.state != AcpState::Failed || core.stop_requested {
                return Ok(());
            }
        }
        self.terminate(AcpError::cancelled(
            "Cleaning the previous agent before restart",
        ))
        .await;
        {
            let mut core = self.inner.core.lock_unpoisoned();
            if core.stop_requested {
                return Ok(());
            }
            core.state = AcpState::Starting;
        }
        self.connect().await
    }

    /// Changes one config option (`AcpConfigState.set`).
    pub async fn set_config_option(
        &self,
        config_id: &str,
        value: &str,
    ) -> Result<Vec<ConfigOption>, AcpError> {
        let (peer, session_id, generation, request) = {
            let core = self.inner.core.lock_unpoisoned();
            let request = core.config.plan_set(config_id, value)?;
            let (Some(peer), Some(session_id)) = (core.peer.clone(), core.session_id.clone())
            else {
                return Err(AcpError::state("ACP session is not established"));
            };
            (peer, session_id, core.generation, request)
        };
        let params = match request {
            ConfigRequest::SetMode => json!({"sessionId": session_id, "modeId": value}),
            ConfigRequest::SetConfigOption => {
                json!({"sessionId": session_id, "configId": config_id, "value": value})
            }
        };
        let response = peer
            .request(
                request.method(),
                params,
                Some(self.inner.options.timeouts.new_session),
            )
            .await?;
        let mut core = self.inner.core.lock_unpoisoned();
        if core.generation != generation || core.session_id.as_deref() != Some(session_id.as_str())
        {
            return Err(AcpError::state(
                "ACP session changed while setting a config option",
            ));
        }
        core.config.applied(config_id, value, &response);
        Ok(core.config.options().to_vec())
    }

    async fn connect(&self) -> Result<(), AcpError> {
        let options = &self.inner.options;
        // Every failure leaves the runtime `Failed` (a restart sets `Starting` before this), so the pool restarts it.
        let env = validate(&options.launch)
            .and_then(|()| child_env(&options.env_snapshot, options.launch.env.as_ref()))
            .inspect_err(|_| self.mark_failed())?;
        let command_name = rust_cli_base::js::string::trim(&options.launch.command).to_owned();
        let mut command = rust_cli_proc::command(&command_name);
        command
            .args(&options.launch.args)
            .current_dir(&options.launch.cwd)
            .env_clear()
            .envs(&env)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let spawned = options
            .ledger
            .spawn(
                &mut command,
                Purpose::Acp,
                Isolation::Group,
                Containment::ProcessJob,
            )
            .await;
        let mut tracked = match spawned {
            Ok(tracked) => tracked,
            Err(error) => {
                self.mark_failed();
                return Err(AcpError::new(
                    AcpErrorCode::SpawnFailed,
                    format!("Failed to spawn {command_name}: {error}"),
                ));
            }
        };
        let child = tracked.child();
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            self.mark_failed();
            return Err(AcpError::new(
                AcpErrorCode::SpawnFailed,
                format!("Failed to spawn {command_name}: stdio pipes are unavailable"),
            ));
        };
        let (peer, inbox) = Peer::new();
        let generation = {
            let mut core = self.inner.core.lock_unpoisoned();
            core.generation += 1;
            core.generation
        };
        let handle = rpc::start(rpc::Pump {
            tracked,
            stdin,
            stdout,
            stderr,
            peer: peer.clone(),
            inbox,
            inbound: Arc::new(Link {
                inner: Arc::downgrade(&self.inner),
                generation,
            }),
            shutdown: CancellationToken::new(),
            timings: PumpTimings {
                death_grace: options.timeouts.death_grace,
                stop_grace: options.timeouts.stop_grace,
            },
            stderr_tail: self.inner.stderr_tail.clone(),
        });
        {
            let mut core = self.inner.core.lock_unpoisoned();
            core.peer = Some(peer.clone());
            core.pump = Some((generation, Arc::new(handle)));
        }
        let target = self.inner.core.lock_unpoisoned().resume_target.clone();
        match self.handshake(&peer, target).await {
            Ok((session_id, start, response)) => {
                if self.commit_session(generation, session_id, start, &response) {
                    return Ok(());
                }
                self.fail_handshake(
                    generation,
                    AcpError::died("Agent terminated during the handshake"),
                )
                .await
            }
            Err(error) => self.fail_handshake(generation, error).await,
        }
    }

    /// Commits the handshake's session unless the process died meanwhile.
    fn commit_session(
        &self,
        generation: u64,
        session_id: String,
        start: SessionStart,
        response: &Value,
    ) -> bool {
        let mut core = self.inner.core.lock_unpoisoned();
        let alive = core.generation == generation
            && core
                .pump
                .as_ref()
                .is_some_and(|(owner, _)| *owner == generation)
            && !matches!(core.state, AcpState::Failed | AcpState::Stopped);
        if !alive {
            return false;
        }
        core.session_id = Some(session_id.clone());
        core.config.reset(response);
        core.resume_target = Some(session_id);
        core.session_start = Some(start);
        core.state = if core.stop_requested {
            AcpState::Stopped
        } else {
            AcpState::Ready
        };
        tracing::info!(
            event = "acp.session_ready",
            agent = %self.inner.options.launch.agent_id,
            "ACP agent session ready"
        );
        true
    }

    async fn fail_handshake(&self, generation: u64, error: AcpError) -> Result<(), AcpError> {
        let failure = {
            let mut core = self.inner.core.lock_unpoisoned();
            core.state = if core.stop_requested {
                AcpState::Stopped
            } else {
                AcpState::Failed
            };
            if core.exited_generation == Some(generation)
                && !core.stop_requested
                && error.code != AcpErrorCode::AgentDied
            {
                AcpError::died("Agent terminated during the handshake")
            } else {
                error
            }
        };
        tracing::warn!(
            event = "acp.handshake_failed",
            agent = %self.inner.options.launch.agent_id,
            error = %failure,
            "ACP agent handshake failed"
        );
        self.terminate(AcpError::cancelled("Handshake failed"))
            .await;
        Err(failure)
    }

    /// `initialize`, then `session/load` of the target when the agent can load, else `session/new`.
    async fn handshake(
        &self,
        peer: &Peer,
        target: Option<String>,
    ) -> Result<(String, SessionStart, Value), AcpError> {
        let timeouts = self.inner.options.timeouts;
        let cwd = self.inner.options.launch.cwd.clone();
        let init = peer
            .request(
                "initialize",
                json!({"protocolVersion": PROTOCOL_VERSION, "clientCapabilities": {}}),
                Some(timeouts.initialize),
            )
            .await?;
        let version = init.get("protocolVersion").cloned().unwrap_or(Value::Null);
        if version.as_u64() != Some(PROTOCOL_VERSION) {
            let shown = match &version {
                Value::String(text) => text.clone(),
                Value::Null => "undefined".to_owned(),
                other => other.to_string(),
            };
            return Err(AcpError::new(
                AcpErrorCode::ProtocolVersion,
                format!(
                    "Agent negotiated protocol version {shown}, runtime requires {PROTOCOL_VERSION}"
                ),
            ));
        }
        let can_load = init
            .get("agentCapabilities")
            .and_then(|capabilities| capabilities.get("loadSession"))
            .and_then(Value::as_bool)
            == Some(true);
        if let Some(previous) = target.as_ref().filter(|_| can_load) {
            let loaded = peer
                .request(
                    "session/load",
                    json!({"sessionId": previous, "cwd": cwd, "mcpServers": []}),
                    Some(timeouts.new_session),
                )
                .await;
            // Not restorable (refused or timed out): a new session replaces it, shown as a reset.
            if let Ok(response) = loaded {
                return Ok((previous.clone(), SessionStart::Loaded, response));
            }
        }
        let created = peer
            .request(
                "session/new",
                json!({"cwd": cwd, "mcpServers": []}),
                Some(timeouts.new_session),
            )
            .await?;
        let Some(session_id) = created.get("sessionId").and_then(Value::as_str) else {
            return Err(AcpError::new(
                AcpErrorCode::HandshakeFailed,
                "session/new returned no sessionId",
            ));
        };
        let start = if target.is_some() {
            SessionStart::Reset
        } else {
            SessionStart::Created
        };
        Ok((session_id.to_owned(), start, created))
    }

    fn mark_failed(&self) {
        let mut core = self.inner.core.lock_unpoisoned();
        core.state = if core.stop_requested {
            AcpState::Stopped
        } else {
            AcpState::Failed
        };
    }

    /// `terminateProcess`: fails the running prompt with `reason`, closes the connection and waits until the
    /// process tree is gone. Concurrent callers wait for the same teardown.
    async fn terminate(&self, reason: AcpError) {
        let pump = {
            let mut core = self.inner.core.lock_unpoisoned();
            if core.state != AcpState::Stopped {
                core.state = AcpState::Failed;
            }
            if let Some(mut active) = core.active.take()
                && let Some(reject) = active.reject.take()
            {
                let _ = reject.send(reason.clone());
            }
            core.cancel_asks();
            if let Some(peer) = core.peer.take() {
                peer.close(&reason);
            }
            core.session_id = None;
            core.pump.clone()
        };
        if let Some((generation, handle)) = pump {
            handle.stop().await;
            let mut core = self.inner.core.lock_unpoisoned();
            if core
                .pump
                .as_ref()
                .is_some_and(|(owner, _)| *owner == generation)
            {
                core.pump = None;
            }
        }
    }
}

fn state_name(state: AcpState) -> &'static str {
    match state {
        AcpState::Starting => "starting",
        AcpState::Ready => "ready",
        AcpState::Prompting => "prompting",
        AcpState::Stopped => "stopped",
        AcpState::Failed => "failed",
    }
}

/// The pump's view of the runtime for one process generation.
struct Link {
    inner: Weak<Inner>,
    generation: u64,
}

impl Link {
    fn with_core<T>(&self, f: impl FnOnce(&mut Core) -> T) -> Option<T> {
        let inner = self.inner.upgrade()?;
        let mut core = inner.core.lock_unpoisoned();
        Some(f(&mut core))
    }
}

impl Inbound for Link {
    fn activity(&self) {
        let generation = self.generation;
        self.with_core(|core| {
            if core.generation != generation {
                return;
            }
            let mut resumed = false;
            if let Some(active) = core.active.as_mut() {
                active.last_activity = Instant::now();
                if active.stall_emitted && !active.resumed_emitted {
                    active.resumed_emitted = true;
                    resumed = true;
                }
            }
            if resumed {
                core.emit(RuntimeEvent::Resumed);
            }
        });
    }

    fn notification(&self, method: &str, params: Value) {
        if method != "session/update" {
            return;
        }
        let generation = self.generation;
        self.with_core(|core| {
            let current = core.generation == generation
                && params.get("sessionId").and_then(Value::as_str) == core.session_id.as_deref()
                && core.session_id.is_some();
            let update = params.get("update").cloned().unwrap_or(Value::Null);
            let event = if current {
                match core.config.surface(&update) {
                    Some(true) => Some(RuntimeEvent::ConfigOptions(core.config.options().to_vec())),
                    Some(false) => None,
                    None => map_update(&update),
                }
            } else {
                None
            };
            match event {
                Some(event) => core.emit(event),
                None => core.ignored_updates += 1,
            }
        });
    }

    fn request(&self, method: &str, params: Value) -> Option<Answer> {
        if method != "session/request_permission" {
            return None;
        }
        let generation = self.generation;
        let cancelled = permission_response(&params, &PermissionAnswer::Cancelled);
        let prepared = self.with_core(|core| {
            let session_matches = match params.get("sessionId").and_then(Value::as_str) {
                Some(session) => core.session_id.as_deref() == Some(session),
                None => true,
            };
            let live = core.generation == generation
                && core.state == AcpState::Prompting
                && session_matches;
            let listener = core.listener.clone().filter(|_| live)?;
            // Without a `toolCallId` the ACP SDK rejects the request on the Node side; here it answers `cancelled`.
            let tool_call_id = params
                .get("toolCall")
                .and_then(|call| call.get("toolCallId"))
                .and_then(Value::as_str)?;
            core.next_ask += 1;
            let request_id = format!("{generation}:{tool_call_id}:{}", core.next_ask);
            let token = CancellationToken::new();
            core.pending_asks.insert(request_id.clone(), token.clone());
            Some((listener, request_id, token))
        });
        let Some(Some((listener, request_id, token))) = prepared else {
            return Some(Box::pin(async move { cancelled }));
        };
        let inner = self.inner.clone();
        Some(Box::pin(async move {
            let (reply, answered) = oneshot::channel();
            let ask = permission_ask(&params, request_id.clone());
            let answer = if listener
                .send(RuntimeEvent::Permission { ask, reply })
                .is_err()
            {
                PermissionAnswer::Cancelled
            } else {
                tokio::select! {
                    answer = answered => answer.unwrap_or(PermissionAnswer::Cancelled),
                    () = token.cancelled() => PermissionAnswer::Cancelled,
                }
            };
            let live = inner.upgrade().is_some_and(|inner| {
                let mut core = inner.core.lock_unpoisoned();
                core.pending_asks.remove(&request_id);
                core.generation == generation && core.state == AcpState::Prompting
            });
            permission_response(
                &params,
                if live {
                    &answer
                } else {
                    &PermissionAnswer::Cancelled
                },
            )
        }))
    }

    fn exited(&self, code: Option<i32>, signal: Option<String>) {
        let generation = self.generation;
        self.with_core(|core| {
            if core.generation != generation {
                return;
            }
            core.cancel_asks();
            if core.stop_requested || core.state == AcpState::Stopped {
                tracing::info!(
                    event = "acp.process_exit",
                    ?code,
                    ?signal,
                    "ACP agent process exited"
                );
                return;
            }
            tracing::warn!(
                event = "acp.process_exit",
                ?code,
                ?signal,
                "ACP agent process exited unexpectedly"
            );
            core.state = AcpState::Failed;
            core.exited_generation = Some(generation);
            let died = AcpError::died(format!(
                "Agent process exited (code={}, signal={})",
                code.map_or_else(|| "null".to_owned(), |code| code.to_string()),
                signal.as_deref().unwrap_or("null"),
            ));
            if let Some(mut active) = core.active.take()
                && let Some(reject) = active.reject.take()
            {
                let _ = reject.send(died.clone());
            }
            if let Some(peer) = core.peer.take() {
                peer.close(&died);
            }
            core.session_id = None;
        });
    }

    fn stream_failed(&self, error: AcpError) {
        let generation = self.generation;
        self.with_core(|core| {
            if core.generation != generation
                || core.stop_requested
                || matches!(core.state, AcpState::Stopped | AcpState::Failed)
            {
                return;
            }
            tracing::warn!(event = "acp.stream_failed", error = %error, "ACP agent stream failed");
            core.state = AcpState::Failed;
            core.cancel_asks();
            if let Some(mut active) = core.active.take()
                && let Some(reject) = active.reject.take()
            {
                let _ = reject.send(error.clone());
            }
            if let Some(peer) = core.peer.take() {
                peer.close(&error);
            }
            core.session_id = None;
        });
    }
}
