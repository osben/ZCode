//! Fork: the runtime workflow run service (specs/fork-rust-workflow-engine.md, 9.25, W7-5a-3).
//!
//! The service starts a run's child through the kernel-api port, hosts the run's owner on its own thread, bridges the
//! child's messages to the owner's mailbox, and closes its live runs. Admission, orphan reconciliation and the production
//! owner assembly are not here (see 9.25 for what is deferred).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use anyhow::Result;
use futures_util::future::BoxFuture;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::workflow_child::{
    ChildEvent, ChildHandler, ChildRequest, ChildStop, Completion, CreateActor, LaunchError,
    LaunchInput, Outcome, RequestType, RunningChild, WireError, WorkflowChildRunner,
};
use rust_cli_kernel_api::workflow_run::WorkflowRunHost;
use rust_cli_workflow::actor_mailbox::{ActorHandle, ActorMailbox, MailboxError, TicketedCall};
use rust_cli_workflow::driver_owner::{ActorDriverOwner, ActorSessions, TicketSettlement};
use rust_cli_workflow::engine::EngineConfig;
use rust_cli_workflow::error::{ErrorCode, WorkflowError};
use rust_cli_workflow::journal::JournalPort;
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::RunConcurrency;
use serde_json::Value;

use crate::workflow_assembly::{RunRegistrations, attach_run};

/// One run's owner as the service holds it: attached at launch, then served on its own thread until it settles.
pub trait HostedOwner: Send {
    /// The launch's registrations (9.15 item 2, 9.12 item 3). Runs in the launch's synchronous step.
    fn attach(&mut self, registrations: RunRegistrations<'_>) -> Result<()>;

    /// Serves the mailbox until the run settles or every handle is dropped. Returns the close failures the owner
    /// recorded, which the service reads at close.
    fn serve(self: Box<Self>) -> Vec<(String, String)>;
}

/// An owner with its mailbox, the production shape of `HostedOwner`.
pub struct Hosted<J: JournalPort + Send + 'static, S: ActorSessions + Send + 'static> {
    owner: ActorDriverOwner<J, S>,
    mailbox: ActorMailbox,
}

impl<J: JournalPort + Send + 'static, S: ActorSessions + Send + 'static> Hosted<J, S> {
    pub fn new(owner: ActorDriverOwner<J, S>, mailbox: ActorMailbox) -> Self {
        Self { owner, mailbox }
    }
}

impl<J: JournalPort + Send + 'static, S: ActorSessions + Send + 'static> HostedOwner
    for Hosted<J, S>
{
    fn attach(&mut self, registrations: RunRegistrations<'_>) -> Result<()> {
        attach_run(&mut self.owner, registrations)
    }

    fn serve(self: Box<Self>) -> Vec<(String, String)> {
        let mut hosted = *self;
        // The loop ends when the run settles (its guard and bound are then released, and a later request could not be
        // answered anyway) or when every handle is dropped. Requests after the settlement are refused by the dropped
        // receiver, as a settled run refuses them.
        while hosted.owner.settlement().is_none() {
            if hosted.mailbox.serve_next(&mut hosted.owner).is_err() {
                break;
            }
        }
        hosted.owner.take_close_failures()
    }
}

/// Builds a run's owner over its mailbox. Called once per launch, outside the service's lock. The handle is the mailbox's
/// own sender: the turn side posts its results through it (9.30).
pub type OwnerFactory = Arc<
    dyn Fn(EngineConfig, ActorMailbox, ActorHandle) -> Result<Box<dyn HostedOwner>> + Send + Sync,
>;

/// The most close failures the service keeps for the next close (L2). Later ones are logged and dropped.
pub const FAILURE_BUFFER_LIMIT: usize = 64;

/// Keeps the first failures up to [`FAILURE_BUFFER_LIMIT`]. The caller logs each one.
fn buffer_failures(buffer: &mut Vec<(String, String)>, failures: Vec<(String, String)>) {
    for failure in failures {
        if buffer.len() >= FAILURE_BUFFER_LIMIT {
            break;
        }
        buffer.push(failure);
    }
}

/// Why a launch did not start a run. Nothing is left behind in any case.
#[derive(Debug)]
pub enum LaunchFailure {
    /// The service is closed: a launch after close is a wiring fault (Node `assertOpen`).
    Closed,
    /// The run has no parent session to keep it resident, so it is refused before anything starts.
    NoParentSession,
    /// A live run, or a launch in progress, already has this id.
    Duplicate(String),
    /// The owner or its residency registration failed; the child was not kept.
    Attach(String),
    /// The child did not start (a rejected script, or a failed compile or entry write).
    Child(Box<LaunchError>),
}

impl fmt::Display for LaunchFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => f.write_str(
                "dynamic workflow run service is closed; a launch after close is a wiring fault",
            ),
            Self::NoParentSession => {
                f.write_str("a workflow run needs its parent session, which keeps it resident")
            }
            Self::Duplicate(run) => write!(
                f,
                "a live workflow run, or a launch still starting, already has the id {run}"
            ),
            Self::Attach(text) => write!(f, "the workflow run could not be registered: {text}"),
            Self::Child(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for LaunchFailure {}

/// What close did: the runs it stopped, the runs whose residency did not close in time, and the close failures.
#[derive(Debug, Default, PartialEq)]
pub struct CloseReport {
    pub stopped: usize,
    pub stuck: Vec<String>,
    pub close_failures: Vec<(String, String)>,
}

/// The run service. Cheap to clone; every clone shares one run map.
#[derive(Clone)]
pub struct WorkflowRunService {
    inner: Arc<Inner>,
}

struct Inner {
    residency: Arc<SessionResidency>,
    concurrency: Arc<dyn RunConcurrency>,
    runner: Arc<dyn WorkflowChildRunner>,
    owners: OwnerFactory,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    closed: bool,
    /// Run ids whose launch is past the duplicate check and has not finished (L3).
    starting: HashSet<String>,
    runs: HashMap<String, RunEntry>,
    /// Close failures of runs that settled on their own, for the next close (bounded, L2).
    failures: Vec<(String, String)>,
    /// Gives each launch a token, so a settled run removes only its own entry (a run id may be launched again).
    next_token: u64,
}

struct RunEntry {
    token: u64,
    parent: String,
    handle: ActorHandle,
    stop: ChildStop,
    serve: Option<JoinHandle<Vec<(String, String)>>>,
}

/// Frees a run id's reservation when its launch ends, however it ends.
struct Reservation {
    inner: Arc<Inner>,
    run_id: String,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.inner
            .state
            .lock_unpoisoned()
            .starting
            .remove(&self.run_id);
    }
}

impl WorkflowRunService {
    pub fn new(
        residency: Arc<SessionResidency>,
        concurrency: Arc<dyn RunConcurrency>,
        runner: Arc<dyn WorkflowChildRunner>,
        owners: OwnerFactory,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                residency,
                concurrency,
                runner,
                owners,
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// Starts a run: the child, then the owner, then the registrations, in one step after the compile (Node invariant 6).
    pub async fn launch(
        &self,
        input: LaunchInput,
        config: EngineConfig,
    ) -> Result<(), LaunchFailure> {
        let inner = self.inner.clone();
        let Some(parent) = config.parent_session_id.clone() else {
            return Err(LaunchFailure::NoParentSession);
        };
        if input.run_id != config.run_id {
            return Err(LaunchFailure::Attach(format!(
                "the launch names run {} but its config names {}",
                input.run_id, config.run_id
            )));
        }
        let run_id = input.run_id.clone();
        // The id is reserved before the compile's await, so a second launch of it is refused before its child starts.
        {
            let mut state = inner.state.lock_unpoisoned();
            if state.closed {
                return Err(LaunchFailure::Closed);
            }
            if state.runs.contains_key(&run_id) || !state.starting.insert(run_id.clone()) {
                return Err(LaunchFailure::Duplicate(run_id));
            }
        }
        let _reservation = Reservation {
            inner: inner.clone(),
            run_id: run_id.clone(),
        };

        // The compile and the child's start come first, as Node's launch does: a rejected script creates no engine and
        // no run row. The mailbox is held here, so the child's early requests wait in it until the owner serves.
        let (mailbox, handle) = ActorMailbox::new();
        let bridge = Arc::new(WireBridge::new(handle.clone()));
        let running = inner
            .runner
            .start(input, bridge)
            .await
            .map_err(|error| LaunchFailure::Child(Box::new(error)))?;
        let RunningChild { stop, outcome, .. } = running;

        // The owner is built outside the lock, since the factory may read the service (M1). It runs on the blocking pool:
        // a factory may block on the database (a migration check waiting on a busy writer), and that must not hold the
        // executor (9.30 review). The id stays reserved until this launch returns, so a failure releases it.
        let owners = inner.owners.clone();
        let factory_handle = handle.clone();
        let built =
            tokio::task::spawn_blocking(move || (owners)(config, mailbox, factory_handle)).await;
        let mut hosted = match built {
            Ok(Ok(hosted)) => hosted,
            Ok(Err(error)) => {
                stop.stop();
                return Err(LaunchFailure::Attach(format!("{error:#}")));
            }
            Err(join) => {
                stop.stop();
                return Err(LaunchFailure::Attach(format!(
                    "the owner factory did not finish: {join}"
                )));
            }
        };

        // The critical section: the closed re-check, the registrations, the thread and the entry, with no await.
        let mut state = inner.state.lock_unpoisoned();
        if state.closed {
            drop(state);
            stop.stop();
            return Err(LaunchFailure::Closed);
        }
        let registrations = RunRegistrations {
            residency: &inner.residency,
            concurrency: inner.concurrency.clone(),
            mailbox: handle.clone(),
        };
        if let Err(error) = hosted.attach(registrations) {
            drop(state);
            stop.stop();
            return Err(LaunchFailure::Attach(format!("{error:#}")));
        }
        let token = state.next_token;
        state.next_token += 1;
        let settle_inner = inner.clone();
        let settle_run_id = run_id.clone();
        let settle_stop = stop.clone();
        let serve = match std::thread::Builder::new()
            .name(format!("workflow-owner-{run_id}"))
            .spawn(move || {
                // A panic in serve still settles the run (finding 1): the panic is a failure, and settle_run runs.
                let failures =
                    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| hosted.serve()))
                    {
                        Ok(failures) => failures,
                        Err(payload) => vec![(
                            "owner".to_owned(),
                            format!("the owner panicked: {}", panic_text(payload.as_ref())),
                        )],
                    };
                settle_run(&settle_inner, &settle_run_id, token, &settle_stop, failures)
            }) {
            Ok(serve) => serve,
            Err(error) => {
                drop(state);
                stop.stop();
                return Err(LaunchFailure::Attach(format!(
                    "the owner thread did not start: {error}"
                )));
            }
        };
        state.runs.insert(
            run_id.clone(),
            RunEntry {
                token,
                parent,
                handle: handle.clone(),
                stop: stop.clone(),
                serve: Some(serve),
            },
        );
        drop(state);
        tokio::spawn(drive_outcome(run_id, handle, outcome, stop));
        Ok(())
    }

    /// Stops every live run and waits for each run's residency to close. A run whose residency does not close in time
    /// is reported as stuck: its owner did not settle, so its thread is left to end on its own.
    pub async fn close(&self) -> CloseReport {
        let inner = self.inner.clone();
        let runs = {
            let mut state = inner.state.lock_unpoisoned();
            state.closed = true;
            std::mem::take(&mut state.runs)
        };
        let stopped = runs.len();
        for entry in runs.values() {
            entry.stop.stop();
            let _ = entry.handle.stop_interrupted();
        }

        let parents: BTreeSet<String> = runs.values().map(|entry| entry.parent.clone()).collect();
        let mut stuck: Vec<String> = Vec::new();
        for parent in parents {
            let residency = inner.residency.clone();
            let session = parent.clone();
            let closed = tokio::task::spawn_blocking(move || residency.close(&session)).await;
            if !matches!(closed, Ok(Ok(()))) {
                stuck.extend(
                    runs.iter()
                        .filter(|(_, entry)| entry.parent == parent)
                        .map(|(run_id, _)| run_id.clone()),
                );
            }
        }
        stuck.sort();

        let mut close_failures = Vec::new();
        for (run_id, entry) in runs {
            if stuck.contains(&run_id) {
                continue;
            }
            if let Some(serve) = entry.serve {
                close_failures.extend(join_owner(serve).await);
            }
        }
        close_failures.extend(std::mem::take(&mut inner.state.lock_unpoisoned().failures));
        CloseReport {
            stopped,
            stuck,
            close_failures,
        }
    }

    /// The number of runs the service holds (live, or settled but not yet collected).
    pub fn run_count(&self) -> usize {
        self.inner.state.lock_unpoisoned().runs.len()
    }
}

impl WorkflowRunHost for WorkflowRunService {
    fn held_runs(&self) -> usize {
        self.run_count()
    }

    fn close(&self) -> BoxFuture<'static, Vec<String>> {
        let service = self.clone();
        Box::pin(async move {
            let report = WorkflowRunService::close(&service).await;
            let mut lines: Vec<String> = report
                .stuck
                .iter()
                .map(|run| format!("run {run}: its session did not close in time"))
                .collect();
            lines.extend(
                report
                    .close_failures
                    .iter()
                    .map(|(session, message)| format!("{session}: {message}")),
            );
            lines
        })
    }
}

/// Runs on the owner's thread once the owner has stopped serving: the run settled, or every handle was dropped. The
/// child is stopped here, so its host ends with the run whatever settled it (H1). The run's entry is removed unless close
/// took it; a taken entry's failures go back to close through the thread's return value, which close joins.
fn settle_run(
    inner: &Inner,
    run_id: &str,
    token: u64,
    stop: &ChildStop,
    failures: Vec<(String, String)>,
) -> Vec<(String, String)> {
    stop.stop();
    log_failures(run_id, &failures);
    let mut state = inner.state.lock_unpoisoned();
    let owned = state
        .runs
        .get(run_id)
        .is_some_and(|entry| entry.token == token);
    if owned {
        state.runs.remove(run_id);
        buffer_failures(&mut state.failures, failures);
        return Vec::new();
    }
    failures
}

/// The text of a panic payload, for the close failure that reports it.
fn panic_text(payload: &(dyn std::any::Any + Send)) -> &str {
    payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("a panic without a message")
}

/// Logs each close failure at the point it is collected, so a failure that is not returned to a caller is still recorded.
fn log_failures(run_id: &str, failures: &[(String, String)]) {
    for (session, message) in failures {
        tracing::warn!(
            event = "workflow.run.close_failed",
            run = %run_id,
            session = %session,
            error = %message,
            "a workflow run's session did not close"
        );
    }
}

/// The engine side of the child's messages for one run (9.25 item 1). Calls that wait for the owner run on the blocking
/// pool, so an ask in flight never holds the child's host.
pub struct WireBridge {
    handle: ActorHandle,
}

impl WireBridge {
    pub fn new(handle: ActorHandle) -> Self {
        Self { handle }
    }
}

impl ChildHandler for WireBridge {
    fn create_actor(&self, actor: &CreateActor) -> BoxFuture<'static, Result<String, String>> {
        let handle = self.handle.clone();
        let site_id = actor.site_id.clone();
        let name = actor.name.clone();
        let persona = actor.persona.clone();
        Box::pin(async move {
            match tokio::task::spawn_blocking(move || {
                handle.create_actor(&site_id, name.as_deref(), persona.as_ref())
            })
            .await
            {
                Ok(Ok(id)) => Ok(id),
                Ok(Err(error)) => Err(error.to_string()),
                Err(join) => Err(format!("the owner call did not finish: {join}")),
            }
        })
    }

    fn request(
        &self,
        request: ChildRequest,
        actor_id: Option<String>,
    ) -> BoxFuture<'static, Result<Value, WireError>> {
        let handle = self.handle.clone();
        Box::pin(async move {
            let call = ticketed_call(request, actor_id).map_err(|error| *error)?;
            // The owner's calls block, so they run on the blocking pool: the child's host keeps reading meanwhile.
            match tokio::task::spawn_blocking(move || ticketed(&handle, call)).await {
                Ok(Ok(Ok(value))) => Ok(value),
                Ok(Ok(Err(error))) => Err(workflow_wire(&error)),
                Ok(Err(error)) => Err(wire("DriverError", error.to_string())),
                Err(join) => Err(wire(
                    "DriverError",
                    format!("the owner call did not finish: {join}"),
                )),
            }
        })
    }

    fn event(&self, event: ChildEvent) {
        match event {
            ChildEvent::Log { message } => {
                let _ = self.handle.log(&message);
            }
            ChildEvent::Report {
                site_id,
                item,
                artifact_id,
            } => {
                let _ = self.handle.report(&site_id, item, artifact_id.as_deref());
            }
            ChildEvent::PhaseEntered { name } => {
                let _ = self.handle.enter_phase(&name);
            }
            // The mailbox has no declare-artifact request yet (9.23 defers it), so the run fails rather than drop it. The
            // failure is posted inline, not on the blocking pool: a later `complete` from this child must queue after it.
            ChildEvent::DeclareArtifact { .. } => {
                let _ = self.handle.fail_posted(WorkflowError::new(
                    ErrorCode::DriverError,
                    "declare-artifact is not wired yet",
                ));
            }
        }
    }
}

/// The owner call for one ticketed child request. The call is sent, then the owner is drained, which starts the turns
/// the call queued (the engine queues starts until a drain), and then the call waits for its settlement.
fn ticketed(handle: &ActorHandle, call: TicketedCall) -> Result<TicketSettlement, MailboxError> {
    let answer = handle.send_ticketed(call)?;
    // A drain refused by a run that settled on this very call still leaves the call's settlement in its reply, so the
    // drain's error is not the answer. It is logged, not returned (L5).
    if let Err(error) = handle.drain() {
        tracing::warn!(%error, "the owner refused a drain after a child call; the call's settlement is still awaited");
    }
    ActorHandle::await_ticketed(answer)
}

/// Maps one child request to its owner call. A hole is refused here until W7-8.
fn ticketed_call(
    request: ChildRequest,
    actor_id: Option<String>,
) -> Result<TicketedCall, Box<WireError>> {
    let site_id = request.site_id;
    match request.request_type {
        RequestType::Ask => {
            let Some(actor) = actor_id else {
                return Err(Box::new(wire("DriverError", "the ask names no actor")));
            };
            Ok(TicketedCall::Ask {
                site_id,
                actor,
                instructions: request.instructions.unwrap_or_default(),
            })
        }
        RequestType::WorldRead => Ok(TicketedCall::WorldRead {
            site_id,
            op: request.op.unwrap_or_default(),
            args: request.args.unwrap_or_default(),
        }),
        RequestType::PublishArtifact => Ok(TicketedCall::PublishArtifact {
            site_id,
            op: request.artifact_op.unwrap_or_default(),
            args: request.args.unwrap_or_default(),
        }),
        RequestType::Hole => Err(Box::new(wire(
            "DriverError",
            "a hole request is not wired yet (W7-8)",
        ))),
    }
}

/// A workflow error as the child sees it: the code is its name, and the ask refusal keeps its violations and final text.
fn workflow_wire(error: &WorkflowError) -> WireError {
    WireError {
        name: error.code.as_str().to_owned(),
        message: error.message.clone(),
        code: Some(error.code.as_str().to_owned()),
        violations: error.violations.as_ref().and_then(Value::as_array).cloned(),
        final_text: error.final_text.clone(),
        stack: None,
    }
}

fn wire(name: &str, message: impl Into<String>) -> WireError {
    WireError {
        name: name.to_owned(),
        message: message.into(),
        code: Some(name.to_owned()),
        violations: None,
        final_text: None,
        stack: None,
    }
}

/// The child's outcome settles the run. A stream that stops before `complete` settles the run as interrupted, and its
/// reason and cause are logged, since the stop carries no error text (L6).
async fn drive_outcome(
    run_id: String,
    handle: ActorHandle,
    outcome: BoxFuture<'static, Outcome>,
    stop: ChildStop,
) {
    let outcome = outcome.await;
    // Read after the outcome: a stop the service requested is visible here, since the request came before the outcome.
    let requested = stop.is_stopped();
    let _ = tokio::task::spawn_blocking(move || match outcome {
        Outcome::Completed(Completion {
            ok: true, value, ..
        }) => {
            let _ = handle.complete(value.unwrap_or(Value::Null));
        }
        Outcome::Completed(Completion {
            ok: false, error, ..
        }) => {
            let message = error
                .map(|error| error.message)
                .unwrap_or_else(|| "The workflow script threw an error".to_owned());
            let _ = handle.fail(WorkflowError::new(ErrorCode::DriverError, message));
        }
        Outcome::Stopped { reason, cause } => {
            // A stop the service asked for (close, or the run settling) is expected; only a child that stopped by itself
            // is logged as a warning (finding 4).
            if requested {
                tracing::debug!(run = %run_id, reason = ?reason, "the service stopped the child");
            } else {
                tracing::warn!(
                    event = "workflow.run.host_stopped",
                    run = %run_id,
                    reason = ?reason,
                    cause = %cause,
                    "the child's stream ended before it completed; the run is stopped as interrupted"
                );
            }
            let _ = handle.stop_interrupted();
        }
    })
    .await;
}

/// Joins an owner thread on the blocking pool, and returns the close failures it recorded. A thread that panicked is
/// reported as one failure.
async fn join_owner(serve: JoinHandle<Vec<(String, String)>>) -> Vec<(String, String)> {
    tokio::task::spawn_blocking(move || serve.join())
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_else(|| {
            vec![(
                "owner".to_owned(),
                "the owner thread ended by a panic".to_owned(),
            )]
        })
}

#[cfg(test)]
#[path = "workflow_run_tests.rs"]
mod tests;
