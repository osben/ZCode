//! Fork: the snippet service of EvalWorkflowSnippet on the Rust engine (Node `dynamic-workflow-snippet-service.ts`;
//! specs/fork-rust-workflow-engine.md, W7-8c, section 9.28).
//!
//! A snippet is one run of the workflow engine with a fully transient journal: [`MemoryJournal`] holds its rows, nothing is
//! written to the run tables, and no background task is registered. The compile and the child come from the runner port
//! (`kernel-api`). The child's world reads go through the engine's world-read path and the production read port, so a
//! snippet sees what a run sees. A snippet has no agent(), so the engine never starts an ask; an ask that reached the handler
//! anyway is refused to the child.
//!
//! Settlement is the engine's. A script error is `fail`, a host failure or a timeout is `stop(interrupted)`, and a clean return
//! is `complete`. The result is read back from the engine's settlement, as Node reads it from `runWorkflowScript`.
//!
//! Locking. The engine sits behind one mutex, and it is held only for engine calls. A world read is started under the lock
//! (the engine records it and the driver queues its operation), then executed on a blocking thread with the lock released,
//! and settled under the lock again. So a slow read (a `run` can take minutes) never holds the engine, and the timeout
//! settles the run while it is in flight. The wall clock covers the start too.

// WireError is the child handler's error type, fixed by the port (kernel-api); its Err path is cold.
#![allow(clippy::result_large_err)]

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use anyhow::anyhow;
use async_trait::async_trait;
use futures_util::future::BoxFuture;
use rust_cli_kernel_api::workflow_child::{
    ChildEvent, ChildHandler, ChildRequest, CreateActor, Outcome, RequestType, WireError,
};
use rust_cli_kernel_api::workflow_snippet::{
    SnippetCheck, SnippetLaunch, SnippetOutcome, SnippetRequest, SnippetStart,
    WorkflowSnippetError, WorkflowSnippetPort, WorkflowSnippetRunner,
};
use rust_cli_workflow::engine::{
    AskMessage, AskOutcome, EngineConfig, RunSettlement, SubmitVerdict, WorkflowDriver,
    WorkflowEngine,
};
use rust_cli_workflow::error::{ErrorCode, WorkflowError};
use rust_cli_workflow::event::RunEvent;
use rust_cli_workflow::imported_cache::ActorSessionSeed;
use rust_cli_workflow::journal::MemoryJournal;
use rust_cli_workflow::model::{Caps, Ref, StopReason};
use rust_cli_workflow::world_read::{WorldReadPorts, execute_world_read};
use serde_json::Value;

/// Log limits (Node `MAX_LOGS` and `MAX_LOG_CHARS`): the first 100 items, each cut to 2048 characters, and a flag when any
/// item was dropped or cut.
const MAX_LOGS: usize = 100;
const MAX_LOG_CHARS: usize = 2_048;
/// Node `MAX_ARTIFACT_BYTES`: the serialized return value's cap.
const MAX_ARTIFACT_BYTES: usize = 256 * 1024;

/// The snippet service: the runner port and the read port.
pub struct SnippetService {
    runner: Arc<dyn WorkflowSnippetRunner>,
    reads: Arc<dyn WorldReadPorts>,
}

impl SnippetService {
    pub fn new(runner: Arc<dyn WorkflowSnippetRunner>, reads: Arc<dyn WorldReadPorts>) -> Self {
        Self { runner, reads }
    }
}

/// A world read the engine started and the driver queued: its instance, its operation and its arguments.
type QueuedRead = (Ref, String, Vec<Value>);

/// What the driver shares with the service: the captured logs, and the world reads queued for execution.
#[derive(Default)]
struct Sink {
    logs: Vec<String>,
    logs_truncated: bool,
    queued_reads: VecDeque<QueuedRead>,
}

/// The engine's driver for a snippet. Asks, submits and actors are unreachable (the scratch facade declares no agent()), so
/// those members do nothing; the handler refuses an ask to the child before it could reach here.
struct SnippetDriver {
    sink: Arc<Mutex<Sink>>,
}

impl WorkflowDriver for SnippetDriver {
    fn create_actor_session(
        &mut self,
        actor: &Ref,
        _persona: &Value,
        _seed: Option<&ActorSessionSeed>,
    ) -> anyhow::Result<String> {
        Err(anyhow!(
            "snippet driver received actor {}, but the scratch facade has no agent(): this is a wiring bug",
            actor.key()
        ))
    }

    fn start_ask(&mut self, _session: &str, _instance: &Ref, _message: &AskMessage) {}

    fn respond_to_submit(&mut self, _instance: &Ref, _verdict: &SubmitVerdict) {}

    fn cancel_ask(&mut self, _instance: &Ref) {}

    /// The read is queued, not run: the service executes it with the engine lock released and settles it afterwards.
    fn start_world_read(&mut self, instance: &Ref, op: &str, args: &Value) {
        let args = args.as_array().cloned().unwrap_or_default();
        lock(&self.sink)
            .queued_reads
            .push_back((instance.clone(), op.to_owned(), args));
    }

    fn emit(&mut self, event: &RunEvent) {
        let RunEvent::Log { message } = event else {
            return;
        };
        let mut sink = lock(&self.sink);
        if sink.logs.len() >= MAX_LOGS {
            sink.logs_truncated = true;
            return;
        }
        if message.chars().count() > MAX_LOG_CHARS {
            sink.logs
                .push(message.chars().take(MAX_LOG_CHARS).collect());
            sink.logs_truncated = true;
        } else {
            sink.logs.push(message.clone());
        }
    }
}

/// The engine and what settles one run.
struct Core {
    engine: WorkflowEngine<MemoryJournal, SnippetDriver>,
    sink: Arc<Mutex<Sink>>,
    /// The value the child returned, when it completed ok. The engine keeps the same value; the child's own `value` is
    /// what distinguishes "returned nothing" (no value) from "returned null".
    returned: Option<Option<Value>>,
    /// Settled world reads that no caller has collected yet, by ticket. Several requests may be in flight, and an engine
    /// call hands every settlement out at once.
    settled_tickets: HashMap<u64, Result<Value, WorkflowError>>,
}

impl Core {
    /// Moves every settlement the engine holds into `settled_tickets`, then takes the ticket's own, if it has settled.
    fn collect(&mut self, ticket: u64) -> Option<Result<Value, WorkflowError>> {
        for AskOutcome { ticket, result } in self.engine.take_outcomes() {
            self.settled_tickets.insert(ticket, result);
        }
        self.settled_tickets.remove(&ticket)
    }

    fn take_queued(&mut self) -> Vec<QueuedRead> {
        lock(&self.sink).queued_reads.drain(..).collect()
    }
}

/// The child's messages, as the engine sees them (Node `handleChildMessage` and `handleRequest`, for the kinds a snippet can
/// send).
struct SnippetHandler {
    core: Arc<Mutex<Core>>,
    reads: Arc<dyn WorldReadPorts>,
    cwd: PathBuf,
}

impl ChildHandler for SnippetHandler {
    fn create_actor(&self, actor: &CreateActor) -> BoxFuture<'static, Result<String, String>> {
        let message = format!(
            "the scratch facade has no agent(), so no actor can be created at site {}: this is a wiring bug",
            actor.site_id
        );
        Box::pin(std::future::ready(Err(message)))
    }

    fn request(
        &self,
        request: ChildRequest,
        _actor_id: Option<String>,
    ) -> BoxFuture<'static, Result<Value, WireError>> {
        match request.request_type {
            RequestType::WorldRead => {
                let Some(op) = request.op else {
                    return refused(
                        ErrorCode::DriverError,
                        "The world read request names no op: this is a wiring bug.".to_owned(),
                    );
                };
                Box::pin(world_read(
                    self.core.clone(),
                    self.reads.clone(),
                    self.cwd.clone(),
                    request.site_id,
                    op,
                    request.args.unwrap_or_default(),
                ))
            }
            RequestType::Ask => refused(
                ErrorCode::DriverError,
                "Snippet driver received an ask, but the scratch facade has no agent(), so the ask path must be unreachable. This is a wiring bug.".to_owned(),
            ),
            RequestType::Hole => refused(
                ErrorCode::DriverError,
                "Snippet driver received a hole, but the scratch facade declares none. This is a wiring bug.".to_owned(),
            ),
            RequestType::PublishArtifact => {
                let op = request.artifact_op.unwrap_or_default();
                refused(
                    ErrorCode::ArtifactStoreUnavailable,
                    format!("artifact.{op}: this assembly has no artifact store."),
                )
            }
        }
    }

    fn event(&self, event: ChildEvent) {
        let mut core = lock(&self.core);
        // The engine refuses nothing after settlement, and a journal write cannot fail here (the journal is in memory).
        match event {
            ChildEvent::Log { message } => {
                let _ = core.engine.log(&message);
            }
            ChildEvent::PhaseEntered { name } => {
                let _ = core.engine.enter_phase(&name);
            }
            // A snippet's facade has no report() or declared artifacts, so these do not come from a well-formed child.
            ChildEvent::Report { .. } | ChildEvent::DeclareArtifact { .. } => {}
        }
    }
}

fn refused(code: ErrorCode, message: String) -> BoxFuture<'static, Result<Value, WireError>> {
    Box::pin(std::future::ready(Err(wire_error(WorkflowError::new(
        code, message,
    )))))
}

/// One world read, from the child's request. The engine starts it under the lock; the queued operation runs on a blocking
/// thread with the lock released; its settlement is handed back to the engine under the lock. The answer is the ticket's.
async fn world_read(
    core: Arc<Mutex<Core>>,
    reads: Arc<dyn WorldReadPorts>,
    cwd: PathBuf,
    site: String,
    op: String,
    args: Vec<Value>,
) -> Result<Value, WireError> {
    let (ticket, queued) = {
        let mut core = lock(&core);
        let ticket = core
            .engine
            .world_read(&site, &op, args)
            .map_err(|error| wire_error(engine_fault(&error)))?;
        (ticket, core.take_queued())
    };
    for (instance, op, args) in queued {
        let (reads, cwd) = (reads.clone(), cwd.clone());
        let result = tokio::task::spawn_blocking(move || {
            execute_world_read(&cwd, reads.as_ref(), &op, &args)
        })
        .await
        .unwrap_or_else(|error| {
            Err(WorkflowError::new(
                ErrorCode::DriverError,
                format!("the world read did not finish: {error}"),
            ))
        });
        lock(&core)
            .engine
            .world_read_settled(&instance, result)
            .map_err(|error| wire_error(engine_fault(&error)))?;
    }
    match lock(&core).collect(ticket) {
        Some(Ok(value)) => Ok(value),
        Some(Err(error)) => Err(wire_error(error)),
        None => Err(wire_error(WorkflowError::new(
            ErrorCode::DriverError,
            "the world read did not settle",
        ))),
    }
}

/// A workflow error as the child reads it (Node `toWireError`).
fn wire_error(error: WorkflowError) -> WireError {
    WireError {
        name: "WorkflowError".to_owned(),
        message: error.message,
        code: Some(error.code.as_str().to_owned()),
        violations: error.violations.and_then(|value| value.as_array().cloned()),
        final_text: error.final_text,
        stack: None,
    }
}

fn engine_fault(error: &anyhow::Error) -> WorkflowError {
    WorkflowError::new(
        ErrorCode::DriverError,
        format!("the workflow engine failed: {error}"),
    )
}

fn service_fault(error: &anyhow::Error) -> WorkflowSnippetError {
    WorkflowSnippetError {
        message: format!("the workflow engine failed: {error}"),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The child's outcome, into the engine: a clean return completes, a script error fails, and a host stop interrupts (Node
/// `handleChildMessage` and `finalize`).
fn settle_child(core: &mut Core, outcome: Outcome) -> anyhow::Result<()> {
    match outcome {
        Outcome::Completed(completion) => {
            if completion.ok {
                let value = completion.value;
                core.returned = Some(value.clone());
                core.engine.complete(value.unwrap_or(Value::Null))
            } else {
                let message = completion.error.map_or_else(
                    || "The workflow script threw an error".to_owned(),
                    |error| error.message,
                );
                core.engine
                    .fail(WorkflowError::new(ErrorCode::DriverError, message))
            }
        }
        Outcome::Stopped { cause, .. } => core.engine.stop(
            StopReason::Interrupted,
            Some(WorkflowError::new(ErrorCode::Interrupted, cause)),
            None,
        ),
    }
}

/// The wall-clock message of a timeout (Node `timer` in `bridge`).
fn timeout_message(timeout_ms: u64) -> String {
    format!("The workflow sandbox process exceeded its wall-clock timeout of {timeout_ms}ms")
}

/// The timeout settle: the run stops as interrupted, with the timeout as its message.
fn settle_timeout(core: &mut Core, timeout_ms: u64) -> anyhow::Result<()> {
    core.engine.stop(
        StopReason::Interrupted,
        Some(WorkflowError::new(
            ErrorCode::Interrupted,
            timeout_message(timeout_ms),
        )),
        None,
    )
}

/// The snippet's model-facing result, from the engine's settlement (Node `runWorkflowScript`'s result, as
/// `dynamic-workflow-snippet-service.ts` maps it).
fn outcome_of(core: &mut Core) -> Result<SnippetOutcome, WorkflowSnippetError> {
    let (logs, logs_truncated) = {
        let mut sink = lock(&core.sink);
        (std::mem::take(&mut sink.logs), sink.logs_truncated)
    };
    let settlement = core
        .engine
        .settlement()
        .cloned()
        .ok_or_else(|| WorkflowSnippetError {
            message: "the snippet did not settle".to_owned(),
        })?;
    Ok(match settlement {
        RunSettlement::Completed { .. } => {
            let value = core.returned.take().flatten();
            match value.as_ref().and_then(oversize) {
                Some(bytes) => SnippetOutcome::Failed {
                    code: ErrorCode::ArtifactTooLarge.as_str().to_owned(),
                    message: format!(
                        "The snippet's return value serializes to {bytes} bytes, over the cap of {MAX_ARTIFACT_BYTES} bytes. Return a summary (a count, the first few items) and leave the full data to log() or to the real run."
                    ),
                    logs,
                    logs_truncated,
                },
                None => SnippetOutcome::Completed {
                    value,
                    logs,
                    logs_truncated,
                },
            }
        }
        RunSettlement::Errored { error } => {
            let (code, message) = failure_of(&error);
            SnippetOutcome::Failed {
                code,
                message,
                logs,
                logs_truncated,
            }
        }
        RunSettlement::Stopped { error, .. } => {
            let (code, message) = match error {
                Some(error) => failure_of(&error),
                None => (
                    ErrorCode::Cancelled.as_str().to_owned(),
                    "snippet evaluation was cancelled".to_owned(),
                ),
            };
            SnippetOutcome::Failed {
                code,
                message,
                logs,
                logs_truncated,
            }
        }
    })
}

/// The byte count of a return value whose compact JSON is over the cap; `None` when it fits.
fn oversize(value: &Value) -> Option<usize> {
    let bytes = serde_json::to_vec(value).map_or(0, |bytes| bytes.len());
    (bytes > MAX_ARTIFACT_BYTES).then_some(bytes)
}

/// The `code` and `message` of a journal failure object.
fn failure_of(error: &Value) -> (String, String) {
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("DriverError")
        .to_owned();
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    (code, message)
}

/// A process-unique run id (Node `dwfeval-<uuid>`). It names the entry file, so it is never reused in the process.
fn next_run_id() -> String {
    static RUNS: AtomicU64 = AtomicU64::new(0);
    format!(
        "dwfeval-{}-{}",
        std::process::id(),
        RUNS.fetch_add(1, Ordering::Relaxed)
    )
}

#[async_trait]
impl WorkflowSnippetPort for SnippetService {
    async fn check(&self, code: &str) -> Result<SnippetCheck, WorkflowSnippetError> {
        self.runner.check(code).await
    }

    async fn eval(&self, request: SnippetRequest) -> Result<SnippetOutcome, WorkflowSnippetError> {
        // One deadline for the whole snippet: the start (compile, entry, spawn), the run, and the child's world reads.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(request.timeout_ms);
        let sink = Arc::new(Mutex::new(Sink::default()));
        let driver = SnippetDriver { sink: sink.clone() };
        let config = EngineConfig {
            run_id: next_run_id(),
            caps: Caps::default(),
            cwd: Some(request.cwd.to_string_lossy().into_owned()),
            ..EngineConfig::default()
        };
        let run_id = config.run_id.clone();
        let engine = WorkflowEngine::new(config, MemoryJournal::new(), driver)
            .map_err(|error| service_fault(&error))?;
        let core = Arc::new(Mutex::new(Core {
            engine,
            sink,
            returned: None,
            settled_tickets: HashMap::new(),
        }));
        let handler: Arc<dyn ChildHandler> = Arc::new(SnippetHandler {
            core: core.clone(),
            reads: self.reads.clone(),
            cwd: request.cwd.clone(),
        });
        let launch = SnippetLaunch {
            code: request.code,
            run_id,
            cwd: request.cwd,
        };
        let start =
            match tokio::time::timeout_at(deadline, self.runner.start(launch, handler)).await {
                Ok(start) => start?,
                Err(_elapsed) => {
                    return Ok(SnippetOutcome::Failed {
                        code: ErrorCode::Interrupted.as_str().to_owned(),
                        message: timeout_message(request.timeout_ms),
                        logs: Vec::new(),
                        logs_truncated: false,
                    });
                }
            };
        let running = match start {
            SnippetStart::Rejected(diagnostics) => {
                return Ok(SnippetOutcome::Diagnostics(diagnostics));
            }
            SnippetStart::Started(running) => running,
        };
        let waited = tokio::time::timeout_at(deadline, running.outcome).await;
        let mut core_guard = lock(&core);
        let settled = match waited {
            Ok(outcome) => settle_child(&mut core_guard, outcome),
            Err(_elapsed) => {
                // The outcome future was dropped at the deadline, which ends the child's tree; the stop makes it explicit.
                running.stop.stop();
                settle_timeout(&mut core_guard, request.timeout_ms)
            }
        };
        settled.map_err(|error| service_fault(&error))?;
        outcome_of(&mut core_guard)
    }
}

#[cfg(test)]
#[path = "workflow_snippet_tests.rs"]
mod tests;
