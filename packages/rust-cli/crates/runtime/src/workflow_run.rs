//! Fork: the runtime workflow run service (specs/fork-rust-workflow-engine.md, 9.25, W7-5a-3).
//!
//! The service starts a run's child through the kernel-api port, hosts the run's owner on its own thread, bridges the
//! child's messages to the owner's mailbox, and closes its live runs. Admission, orphan reconciliation and the production
//! owner assembly are not here (see 9.25 for what is deferred).

use std::collections::{BTreeSet, HashMap};
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

/// Builds a run's owner over its mailbox. Called once per launch, on the launching thread.
pub type OwnerFactory =
    Arc<dyn Fn(EngineConfig, ActorMailbox) -> Result<Box<dyn HostedOwner>> + Send + Sync>;

/// Why a launch did not start a run. Nothing is left behind in any case.
#[derive(Debug)]
pub enum LaunchFailure {
    /// The service is closed: a launch after close is a wiring fault (Node `assertOpen`).
    Closed,
    /// The run has no parent session to keep it resident, so it is refused before anything starts.
    NoParentSession,
    /// A live run already has this id.
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
            Self::Duplicate(run) => write!(f, "a live workflow run already has the id {run}"),
            Self::Attach(text) => write!(f, "the workflow run could not be registered: {text}"),
            Self::Child(error) => write!(f, "{error}"),
        }
    }
}

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
    runs: HashMap<String, RunEntry>,
    failures: Vec<(String, String)>,
}

struct RunEntry {
    parent: String,
    handle: ActorHandle,
    stop: ChildStop,
    serve: Option<JoinHandle<Vec<(String, String)>>>,
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
        if inner.state.lock_unpoisoned().closed {
            return Err(LaunchFailure::Closed);
        }
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
        if inner.state.lock_unpoisoned().runs.contains_key(&run_id) {
            return Err(LaunchFailure::Duplicate(run_id));
        }

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

        // The synchronous step: the owner, its registrations, its thread and its entry, with no await in between.
        let mut state = inner.state.lock_unpoisoned();
        if state.closed {
            drop(state);
            stop.stop();
            return Err(LaunchFailure::Closed);
        }
        if state.runs.contains_key(&run_id) {
            drop(state);
            stop.stop();
            return Err(LaunchFailure::Duplicate(run_id));
        }
        let refused = |text: String| {
            stop.stop();
            LaunchFailure::Attach(text)
        };
        let mut hosted = match (inner.owners)(config, mailbox) {
            Ok(hosted) => hosted,
            Err(error) => {
                drop(state);
                return Err(refused(format!("{error:#}")));
            }
        };
        let registrations = RunRegistrations {
            residency: &inner.residency,
            concurrency: inner.concurrency.clone(),
            mailbox: handle.clone(),
        };
        if let Err(error) = hosted.attach(registrations) {
            drop(state);
            return Err(refused(format!("{error:#}")));
        }
        let thread_name = format!("workflow-owner-{run_id}");
        let serve = match std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || hosted.serve())
        {
            Ok(serve) => serve,
            Err(error) => {
                drop(state);
                return Err(refused(format!("the owner thread did not start: {error}")));
            }
        };
        state.runs.insert(
            run_id.clone(),
            RunEntry {
                parent,
                handle: handle.clone(),
                stop,
                serve: Some(serve),
            },
        );
        drop(state);
        tokio::spawn(drive_outcome(inner, run_id, handle, outcome));
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
    fn create_actor(&self, actor: &CreateActor) -> Result<String, String> {
        self.handle
            .create_actor(
                &actor.site_id,
                actor.name.as_deref(),
                actor.persona.as_ref(),
            )
            .map_err(|error| error.to_string())
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
            // The mailbox has no declare-artifact request yet (9.23 defers it), so the run fails rather than drop it.
            ChildEvent::DeclareArtifact { .. } => {
                let _ = self.handle.fail(WorkflowError::new(
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
    // drain's error is not the answer.
    let _ = handle.drain();
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

/// The child's outcome settles the run, then the run's entry is collected and its owner thread joined. A run that
/// settled by close has no entry left, and close joins its thread itself.
async fn drive_outcome(
    inner: Arc<Inner>,
    run_id: String,
    handle: ActorHandle,
    outcome: BoxFuture<'static, Outcome>,
) {
    let outcome = outcome.await;
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
        Outcome::Stopped { .. } => {
            let _ = handle.stop_interrupted();
        }
    })
    .await;
    let entry = inner.state.lock_unpoisoned().runs.remove(&run_id);
    if let Some(serve) = entry.and_then(|entry| entry.serve) {
        let failures = join_owner(serve).await;
        inner.state.lock_unpoisoned().failures.extend(failures);
    }
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
