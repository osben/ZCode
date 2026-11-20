//! The driver owner of an actor run (W6a part 2; spec section 9.8).
//!
//! `ActorDriverOwner` is the only caller of the engine on the driver side and the only holder of the escalation
//! book and the active-ask table. Turns (the async side, on each actor's child session) reach it through
//! `submit_result`, `turn_ended`, `escalate`, and `answer`, one message at a time. The engine reaches the turn side
//! through `ActorPort`, the engine's `WorkflowDriver`, which only queues work and records verdicts: it never touches
//! the book, and it never blocks on the run's own work.
//!
//! The one exception is the progress sink (9.31). `emit_stored` runs it inline on the owner's thread, so the sink's port
//! call (the parent session's record) is blocking I/O on that thread. It is the only port-side call that is not queued.
//!
//! Event order for each engine call: the engine runs, `pump` applies what the port queued (book start, turn start,
//! failed asks), then `reconcile` ends every active ask the engine no longer has live. `pump` reconciles on every
//! exit path, so no caller reconciles on its own. Ending an ask is one rule for every path (accept, budget
//! exhaustion, cancel), not a step each path has to remember.
//!
//! Errors. A turn that cannot start fails its ask as a `DriverError` (Node's `askFailed` on a turn error). Any other
//! error from the pump (a turn-side error the engine cannot receive, such as a refused withdrawal or cancel, or a
//! journal write inside `ask_failed`) is handled by the kind of call that raised the pump:
//!
//! - Non-reply calls (`create_actor`, `ask`, `drain`, `complete`, `set_message_boundary`, `ask_mutating`) return every
//!   pump error, after the engine's own error if they have one.
//! - Reply calls (`submit_result`, `turn_ended`, `escalate`, `answer`) return the reply and log the pump error. The
//!   engine has already settled the ask, so a returned error would make the caller retry a settled call. A reply call
//!   returns an error only when the engine call itself failed, since then no reply exists; the pump error is logged in
//!   that case too.
use crate::actor_feed::{FeedEvent, NON_FAILURE_RETRY_REASONS};
use crate::actor_mailbox::{ActorHandle, ActorRequest};
use crate::actor_turns::TurnInput;
use crate::driver_rules::{
    NO_ACTIVE_ASK_MESSAGE, ProfileFit, SubmitProfile, SubmitRoute, UNTYPED_ASK_MESSAGE,
    actor_interaction_description, actor_session_title, actor_task_link_path, ask_input,
    profile_fit, submit_route,
};
use crate::engine::{
    AskMessage, AskOutcome, AskProgress, EngineConfig, RunSettlement, SubmitVerdict,
    WorkflowDriver, WorkflowEngine,
};
use crate::engine_artifacts::ArtifactPublishRequest;
use crate::error::{ErrorCode, WorkflowError};
use crate::escalation::{AnswerOutcome, EscalateOutcome, EscalationBook, EscalationRequest};
use crate::event::{LastTool, RunEvent};
use crate::journal::JournalPort;
use crate::model::{AskWait, StopReason, WaitCause};
use crate::model::{ConcurrencyChange, Ref, StoredEvent};
use crate::model_failure::{
    RedriveClock, TRANSIENT_CONTINUE_PROMPT, TurnFailure, transient_backoff_ms,
};
use crate::model_failure::{provider_stop_error, quota_reset_at, retry_after_of};
use crate::persona::persona_name;
use crate::residency::{LiveRun, LiveRunGuard, SessionResidency};
use crate::run_concurrency::RunConcurrency;
use crate::run_progress::RunProgress;
use crate::stall_clock::RunStallClock;
use crate::world_host::{WORLD_JOB_LIMIT, WorldJob, WorldWiring, spawn_world_job};
use anyhow::{Result, anyhow};
use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::workflow_failure::ProviderStopKind;
use rust_cli_kernel_api::workflow_failure::{
    WorkflowModelFailurePolicy, facts_of, model_failure_policy, next_unrecognized_streak,
};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

/// Node `cancelAsk`'s rejection of a pending submit: the text the submit's caller reads.
pub const CANCELLED_BY_ENGINE_MESSAGE: &str = "The ask was cancelled by the engine.";

/// How a ticket (an ask, a world read, or an artifact publish) settled: its value, or the error it rejected with (Node's
/// promise result).
pub type TicketSettlement = Result<Value, WorkflowError>;

/// What the turn side needs to create an actor's session (Node `createActorSession` and `persistActorSession`).
#[derive(Debug, Clone, PartialEq)]
pub struct ActorSessionRequest {
    pub run_id: String,
    pub parent_session_id: Option<String>,
    pub actor: Ref,
    /// `workflow subagent <site>@<ordinal>`.
    pub title: String,
    /// `dwf/<runId>/<site>@<ordinal>`, the `workflow_actor` task link's path.
    pub link_path: String,
    pub persona: Value,
    /// The session seed of a diverged actor (Node `createActorSession`'s `seed`): its predecessor's model pin, read at
    /// creation by the turn side when the run has no pin of its own (9.33 review round 3). None for a fresh actor.
    pub seed: Option<crate::imported_cache::ActorSessionSeed>,
}

/// The turn side. Implementations run turns and create sessions; they never call the engine. Each call that can
/// fail says so, and the owner turns the failure into the engine's language (a failed ask, or a kept error).
pub trait ActorSessions {
    /// Create the actor's session and its `workflow_actor` task link, and return the session id.
    fn create_session(&mut self, request: &ActorSessionRequest) -> Result<String>;
    /// Run one ask's first turn on the session. An error fails the ask.
    /// `interaction` is the description the actor's asks are named by (Node `workflowActorInteractionDescription`).
    fn start_turn(
        &mut self,
        session: &str,
        instance: &Ref,
        message: &AskMessage,
        input: &TurnInput,
        interaction: &str,
    ) -> Result<()>;
    /// Stop the session's turn for an ask the engine cancelled.
    fn cancel_turn(&mut self, session: &str, instance: &Ref) -> Result<()>;
    /// Reject the deferred of a parked question that was withdrawn with its ask.
    fn reject_parked(&mut self, session: &str, qid: &str) -> Result<()>;
    /// Resolve the deferred of a parked question with the main agent's answer (Node `deferred.resolve(answer)`): the
    /// blocked escalate call returns it as its tool result.
    fn deliver_answer(&mut self, session: &str, qid: &str, answer: &str) -> Result<()>;
    /// Close the session once the run has settled (Node `releaseActorSessions`, per session). The owner calls it once per
    /// session, from the engine's dispose. A failure is recorded and logged; it does not fail the settlement.
    fn close_session(&mut self, session: &str) -> Result<()>;
    /// Drains the deferred closes that failed after their turn landed. A port that has no such closes returns nothing.
    fn take_close_failures(&mut self) -> Vec<(String, String)> {
        Vec::new()
    }
}

/// The answer to a `submit_result` call, which is the tool result the model reads.
#[derive(Debug, Clone, PartialEq)]
pub enum SubmitReply {
    /// The port refused the submit. The engine was not told.
    Refused(String),
    /// The engine's verdict on the submit (accept, or reject with its violations).
    Verdict(SubmitVerdict),
    /// The engine cancelled the ask while the submit was pending (Node's `cancelAsk` rejects the deferred).
    Cancelled(String),
}

/// The answer to a turn that ended without a submit.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnEndReply {
    /// The engine's verdict: a nudge, so a fresh turn runs.
    Verdict(SubmitVerdict),
    /// The engine settled the ask (a text result for an untyped ask, or `ResultNotSubmitted`). No turn runs again.
    AskEnded,
    /// No ask is in flight for the session.
    NoAsk,
}

#[derive(Debug, Clone)]
struct QueuedStart {
    session: String,
    instance: Ref,
    message: AskMessage,
    /// The turn's input: the composed text and its boundary (`ask_input`), and the mono submit schema if any.
    turn: TurnInput,
}

/// An ask the owner has started and not yet ended.
#[derive(Debug, Clone)]
struct ActiveAsk {
    instance: Ref,
    typed: bool,
    /// The ask's message and the submit schema of its first turn. A redrive starts its turn with the same schema, as
    /// Node's redrive keeps the runtime's turn shape (W6b part 3).
    message: AskMessage,
    schema: Option<Value>,
    /// Redrives scheduled for this ask so far (Node `transientAttempts`).
    attempts: u32,
    /// Unrecognized business codes in a row, across this ask's failures (Node's streak, W6b part 3).
    unrecognized: u32,
    /// Turns this ask has resolved, across its redrives (Node `turnsResolved`, W6b part 5).
    turns: u64,
    /// The tool and world-tool counts the owner last reported, and the counts that earlier turns of this ask already
    /// contributed. A redriven turn counts from zero on its own thread, so its reports are added to `stats_base`
    /// (ocr review, finding 9).
    stats_base: (f64, f64),
    stats_last: (f64, f64),
    /// The last tool the ask started, as the turn side fed it (Node `lastTool`). It is carried on the ask's next
    /// `node-progress`, and the ask's own state, so a new ask starts with none.
    last_tool: Option<LastTool>,
}

/// The owner's redrive wiring. A redrive job reads the mailbox out of `slot` when it fires, so a settled run can clear
/// the slot and release the mailbox handle at once, even while a job still waits on its clock (ocr review, finding 5).
struct RedriveWiring {
    slot: Arc<Mutex<Option<ActorHandle>>>,
    clock: Arc<dyn RedriveClock>,
}

/// The engine's driver for an actor run. It records what the engine asks for and answers verdicts; it does not
/// decide anything the book or the owner decides.
pub struct ActorPort<S: ActorSessions> {
    run_id: String,
    parent_session_id: Option<String>,
    sessions: S,
    /// Submit profile per actor key, set by the caller before the actor's first typed ask.
    profiles: HashMap<String, SubmitProfile>,
    session_of_actor: HashMap<String, String>,
    actor_of_session: HashMap<String, String>,
    /// The actor and its persona name of each session: an escalation is named by the session's actor, whatever the caller
    /// put in its request.
    identity_of_session: HashMap<String, (Ref, Option<String>)>,
    /// The interaction description of each session's actor (`<persona name ?? "subagent"> (<site>@<ordinal>)`).
    interaction_of_session: HashMap<String, String>,
    /// Session of each ask whose turn has started and not ended, keyed by instance. Removed when the ask ends.
    session_of_instance: HashMap<String, String>,
    /// Instances the engine cancelled while they ran. A cancelled ask takes no message boundary.
    cancelled: HashSet<String>,
    queued_starts: Vec<QueuedStart>,
    queued_failures: Vec<(Ref, WorkflowError)>,
    /// Errors the engine cannot receive (its trait methods return nothing); the owner returns them.
    deferred_errors: Vec<anyhow::Error>,
    /// The host's world wiring, set by [`ActorDriverOwner::with_world`]. Without it world reads fail as before.
    world: Option<WorldWiring>,
    /// Jobs the pump hands to workers (world reads and artifact publishes).
    queued_world: Vec<WorldJob>,
    /// Jobs waiting for a free worker slot, and how many are running (at most `WORLD_JOB_LIMIT`).
    world_queue: VecDeque<WorldJob>,
    world_running: usize,
    /// The engine's verdict for each instance, taken by the owner right after the engine call that made it.
    verdicts: HashMap<String, SubmitVerdict>,
    /// Set by the engine's dispose (once per settlement). A disposed port refuses new sessions.
    disposed: bool,
    /// Close failures, as (session, message). Recorded for the owner's caller; the settlement does not fail on them.
    pub(crate) close_failures: Vec<(String, String)>,
    /// The run's progress sink (9.31), set by the run service. Absent, progress is not published.
    progress: Option<Box<dyn RunProgress>>,
}

impl<S: ActorSessions> WorkflowDriver for ActorPort<S> {
    /// Node's `dispose` (W6b part 6): the engine calls it once per settlement. Each session the run created is handed to
    /// the close port once, in session-id order, so the close does not depend on map order. A failed close is recorded
    /// and logged; the settlement does not fail. The close port waits for a turn that is still running (turn side).
    fn dispose(&mut self) {
        if self.disposed {
            return;
        }
        self.disposed = true;
        let mut sessions: Vec<String> = self.actor_of_session.keys().cloned().collect();
        sessions.sort();
        // `disposed` makes this run once per driver, and no session can be created after it, so each session is asked
        // exactly once.
        for session in sessions {
            if let Err(error) = self.sessions.close_session(&session) {
                let message = format!("{error:#}");
                tracing::warn!(
                    event = "dynamic_workflow.actor_runtime.close_failed",
                    session = %session,
                    error = %message,
                    "a workflow actor's session did not close"
                );
                self.close_failures.push((session, message));
            }
        }
    }

    fn minted_session_id(&self, run_id: &str, actor: &Ref) -> Option<String> {
        Some(rust_cli_node_store::mint_actor_session_id(
            run_id,
            &actor.site_id,
            actor.ordinal as f64,
        ))
    }

    fn create_actor_session(
        &mut self,
        actor: &Ref,
        persona: &Value,
        seed: Option<&crate::imported_cache::ActorSessionSeed>,
    ) -> Result<String> {
        // Node's `Workflow driver closed during actor creation`: a disposed driver accepts no new session.
        if self.disposed {
            return Err(anyhow!("Workflow driver is closed"));
        }
        let request = ActorSessionRequest {
            run_id: self.run_id.clone(),
            parent_session_id: self.parent_session_id.clone(),
            actor: actor.clone(),
            title: actor_session_title(&actor.site_id, actor.ordinal),
            link_path: actor_task_link_path(&self.run_id, &actor.site_id, actor.ordinal),
            persona: persona.clone(),
            seed: seed.cloned(),
        };
        let session = self.sessions.create_session(&request)?;
        let interaction =
            actor_interaction_description(&actor.site_id, actor.ordinal, persona_name(persona));
        self.interaction_of_session
            .insert(session.clone(), interaction);
        // The actor's identity, which every escalation of this session is named by (Node `effectiveActorName`).
        self.identity_of_session.insert(
            session.clone(),
            (actor.clone(), persona_name(persona).map(str::to_owned)),
        );
        self.session_of_actor.insert(actor.key(), session.clone());
        self.actor_of_session.insert(session.clone(), actor.key());
        Ok(session)
    }

    fn start_ask(&mut self, session: &str, instance: &Ref, message: &AskMessage) {
        // Node `startAsk`: a session the driver does not know is a DriverError, reported as the ask's failure.
        let Some(actor_key) = self.actor_of_session.get(session).cloned() else {
            self.queued_failures.push((
                instance.clone(),
                WorkflowError::new(
                    ErrorCode::DriverError,
                    format!("Unknown subagent session: {session}"),
                ),
            ));
            return;
        };
        let mut profile = self
            .profiles
            .get(&actor_key)
            .cloned()
            .unwrap_or(SubmitProfile::Generic);
        if message.typed {
            let schema = message.schema.clone().unwrap_or(Value::Null);
            // A failed fit fails the ask before any turn starts (Node `ensureSubmitProfileFits` throws inside the
            // ask's promise, so the engine sees `askFailed`).
            match profile_fit(&profile, &schema, &instance.key(), session) {
                ProfileFit::Fail { message: text } => {
                    self.queued_failures.push((
                        instance.clone(),
                        WorkflowError::new(ErrorCode::DriverError, text),
                    ));
                    return;
                }
                // The repair (Node `ensureSubmitProfileFits` sets the session's profile to the generic one): the
                // session keeps the generic declaration from here on, and this ask's input is composed for it.
                ProfileFit::FallBackToGeneric => {
                    // Node logs this warning and journals nothing: the session's profile is in memory only, so a
                    // restarted run finds the same mismatch from the static analysis and falls back again.
                    tracing::warn!(
                        event = "dynamic_workflow.submit_profile.mismatch",
                        %session,
                        instance = %instance.key(),
                        "Dynamic workflow submit profile mismatch: falling back to the generic submit_result"
                    );
                    self.profiles.insert(actor_key, SubmitProfile::Generic);
                    profile = SubmitProfile::Generic;
                }
                ProfileFit::Fits => {}
            }
        }
        // The input is composed after the fit, as Node composes it after `ensureSubmitProfileFits`.
        let (text, epilogue_start) = ask_input(
            &message.instructions,
            message.typed,
            message.schema.as_ref(),
            &profile,
        );
        // A mono session's turn declares its schema; a generic one, and an untyped ask, declare none.
        // The profile is this call's own copy, so the schema moves out of it rather than being cloned again.
        let submit_schema = match (profile, message.typed) {
            (SubmitProfile::Mono { schema }, true) => Some(schema),
            _ => None,
        };
        self.queued_starts.push(QueuedStart {
            session: session.to_owned(),
            instance: instance.clone(),
            message: message.clone(),
            turn: TurnInput {
                text,
                epilogue_start,
                submit_schema,
            },
        });
    }

    fn respond_to_submit(&mut self, instance: &Ref, verdict: &SubmitVerdict) {
        self.verdicts.insert(instance.key(), verdict.clone());
    }

    fn abort_ask(&mut self, instance: &Ref) {
        self.cancelled.insert(instance.key());
        self.cancel_ask(instance);
    }

    fn cancel_ask(&mut self, instance: &Ref) {
        self.verdicts.remove(&instance.key());
        let Some(session) = self.session_of_instance.remove(&instance.key()) else {
            return;
        };
        if let Err(error) = self.sessions.cancel_turn(&session, instance) {
            self.deferred_errors.push(error);
        }
    }

    fn emit(&mut self, _event: &RunEvent) {
        // The journal is the record (the engine appends before it emits). Without a stored row there is no sequence
        // to publish, so this path publishes nothing; the engine always calls `emit_stored`.
    }

    /// The progress fan-out (9.31): the sink sees the event with its row, on this thread, right after the append.
    fn emit_stored(&mut self, _event: &RunEvent, stored: &StoredEvent) {
        if let Some(progress) = self.progress.as_mut() {
            progress.progress(stored);
        }
    }

    fn start_world_read(&mut self, instance: &Ref, op: &str, args: &Value) {
        if self.world.is_some() {
            // The owner's pump hands the job to a worker; the outcome comes back as a mailbox request.
            self.queued_world.push(WorldJob::Read {
                instance: instance.clone(),
                op: op.to_owned(),
                args: args.as_array().cloned().unwrap_or_default(),
            });
            return;
        }
        // No wiring (no host read port): an ask that reaches a world read fails as a driver fault.
        self.queued_failures.push((
            instance.clone(),
            WorkflowError::new(
                ErrorCode::DriverError,
                "world reads are not wired to the actor driver yet",
            ),
        ));
    }
    fn has_artifact_store(&self) -> bool {
        self.world
            .as_ref()
            .is_some_and(|wiring| wiring.artifacts.as_ref().is_some_and(|a| a.store.is_some()))
    }

    fn start_artifact_publish(&mut self, instance: &Ref, request: &ArtifactPublishRequest) {
        // The engine asks `has_artifact_store` first, so the job is queued only when a store is wired.
        self.queued_world.push(WorldJob::Publish {
            instance: instance.clone(),
            request: request.clone(),
        });
    }
}

/// The log line for a pump error that a reply call cannot return. Its source may be a turn-side error or an engine
/// journal write inside `ask_failed`.
fn log_settle_error(result: Result<()>) {
    if let Err(error) = result {
        tracing::warn!(
            "the owner's pump failed while settling an ask; the reply is unchanged: {error:#}"
        );
    }
}

/// The owner for one actor run: the engine, its driver port, and the escalation book.
pub struct ActorDriverOwner<J: JournalPort, S: ActorSessions> {
    engine: WorkflowEngine<J, ActorPort<S>>,
    book: EscalationBook,
    active: BTreeMap<String, ActiveAsk>,
    /// The run's link to the process governor, when one is attached (W6b part 2b). Released at settlement.
    concurrency: Option<ConcurrencyLink>,
    /// The redrive wiring (W6b part 3). Without it a transient failure cannot be redriven and fails the ask.
    redrive: Option<RedriveWiring>,
    /// The run-level stall clock (W6b part 5). Attached with the redrive wiring; released at settlement.
    stall: Option<RunStallClock>,
    /// The run's residency guard on its parent session (W6b part 6). Held from the launch to the settlement.
    residency: Option<LiveRunGuard>,
    /// Mailbox replies waiting for a ticket's settlement, by ticket (W7-5a-2). Each is answered by `route_outcomes`
    /// when the ticket settles, or by a stop or the owner's shutdown with an error. Never dropped silently.
    pending_tickets: HashMap<u64, Sender<Result<TicketSettlement>>>,
    /// Settlements no pending reply claimed, for `take_outcomes`.
    unclaimed: Vec<AskOutcome>,
}

impl<J: JournalPort, S: ActorSessions> Drop for ActorDriverOwner<J, S> {
    /// The owner's shutdown: a settlement that already arrived is answered, and every other pending reply gets an error,
    /// so no waiting turn is left with nothing.
    fn drop(&mut self) {
        self.route_outcomes();
        let error = WorkflowError::new(
            ErrorCode::DriverError,
            "the workflow owner shut down before this request settled",
        );
        self.answer_pending_with(&error);
    }
}

/// What the owner holds of the governor for its run: the port, and the subscription's end.
///
/// Dropping the link is the release: the subscription ends, then the bound is cleared. So a link that ends without the
/// run settling (the owner dropped, or a re-attach) still gives the governor its bound back, and the release happens once.
struct ConcurrencyLink {
    port: Arc<dyn RunConcurrency>,
    run_id: String,
    unsubscribe: Option<Box<dyn FnOnce() + Send>>,
}

impl Drop for ConcurrencyLink {
    fn drop(&mut self) {
        if let Some(unsubscribe) = self.unsubscribe.take() {
            unsubscribe();
        }
        self.port.clear_run_bound(&self.run_id);
    }
}

/// The bound a run registers: the cap floored, and never less than 1 (the engine floors and raises its cap the same way).
fn bound_of(max_concurrency: f64) -> u64 {
    // `set_max_concurrency` ignores a non-finite cap, so one only reaches here from the config. It binds the minimum,
    // rather than NaN (which `max` would hide) or infinity (which `as u64` would saturate to `u64::MAX`).
    if !max_concurrency.is_finite() {
        return 1;
    }
    max_concurrency.floor().max(1.0) as u64
}

impl<J: JournalPort, S: ActorSessions> ActorDriverOwner<J, S> {
    pub fn new(config: EngineConfig, journal: J, sessions: S) -> Result<Self> {
        let port = ActorPort {
            run_id: config.run_id.clone(),
            parent_session_id: config.parent_session_id.clone(),
            sessions,
            profiles: HashMap::new(),
            session_of_actor: HashMap::new(),
            actor_of_session: HashMap::new(),
            identity_of_session: HashMap::new(),
            interaction_of_session: HashMap::new(),
            session_of_instance: HashMap::new(),
            cancelled: HashSet::new(),
            queued_starts: Vec::new(),
            queued_failures: Vec::new(),
            deferred_errors: Vec::new(),
            verdicts: HashMap::new(),
            world: None,
            queued_world: Vec::new(),
            world_queue: VecDeque::new(),
            world_running: 0,
            disposed: false,
            close_failures: Vec::new(),
            progress: None,
        };
        let book = EscalationBook::new(config.run_id.clone());
        let engine = WorkflowEngine::new(config, journal, port)?;
        Ok(Self {
            engine,
            book,
            active: BTreeMap::new(),
            concurrency: None,
            redrive: None,
            stall: None,
            residency: None,
            pending_tickets: HashMap::new(),
            unclaimed: Vec::new(),
        })
    }

    /// Node's launch registration of residency-blocking work (W6b part 6): the run's parent session holds a guard from
    /// the launch to the settlement, so the session is not evicted while the run is live. A run that has settled takes
    /// no guard. Settlement releases it (see `pump`).
    pub fn attach_residency(
        &mut self,
        residency: &SessionResidency,
        run: Arc<dyn LiveRun>,
    ) -> Result<()> {
        // An earlier guard is released first, so one run holds one guard.
        self.residency.take();
        let Some(parent) = self.engine.driver.parent_session_id.clone() else {
            return Err(anyhow!(
                "a workflow run needs its parent session, which keeps it resident"
            ));
        };
        if self.engine.is_settled() {
            return Ok(());
        }
        let run_id = self.engine.run_id().to_owned();
        self.residency = Some(residency.acquire(&parent, &run_id, run)?);
        Ok(())
    }

    /// The closes of the run's sessions that failed, as (session, message), drained: the ones the port recorded at
    /// settlement, then the ones the turn side refused after a turn landed. A failed close never fails the settlement;
    /// this is where a caller (W7) reads it. A second call returns only the failures since the first.
    pub fn take_close_failures(&mut self) -> Vec<(String, String)> {
        let mut failures = std::mem::take(&mut self.engine.driver.close_failures);
        failures.extend(self.engine.driver.sessions.take_close_failures());
        failures
    }

    /// The driver port, for tests of the port's own rules after settlement.
    #[cfg(test)]
    pub(crate) fn driver_for_test(&mut self) -> &mut ActorPort<S> {
        &mut self.engine.driver
    }

    /// Test hook: the next pump reports `message` as its error, through the same channel a deferred driver error uses.
    #[cfg(test)]
    pub(crate) fn fail_next_pump_for_test(&mut self, message: &str) {
        self.engine
            .driver
            .deferred_errors
            .push(anyhow!(message.to_owned()));
    }

    /// Node's launch registration (`setRunBound` with the run's cap, then `subscribe`): binds the run on the governor
    /// and hears its cap changes through the mailbox, as `concurrency-changed` events. A run that has already settled
    /// attaches nothing. The listener only posts to `handle`, since the governor calls it on its own thread.
    pub fn attach_concurrency(&mut self, port: Arc<dyn RunConcurrency>, handle: ActorHandle) {
        // An earlier link is released first: its clear must not run after the new bound is set.
        self.release_concurrency();
        if self.engine.is_settled() {
            return;
        }
        let run_id = self.engine.run_id().to_owned();
        port.set_run_bound(&run_id, bound_of(self.engine.caps().max_concurrency));
        let unsubscribe = port.subscribe(
            &run_id,
            Box::new(move |change: &ConcurrencyChange| {
                handle.post(ActorRequest::ConcurrencyChanged {
                    change: change.clone(),
                });
            }),
        );
        self.concurrency = Some(ConcurrencyLink {
            port,
            run_id,
            unsubscribe: Some(unsubscribe),
        });
    }

    /// Node's settings retune: the run's cap changes, and the bound follows it (Node `runBoundTarget`'s `setLimit`
    /// re-registers the bound on every retune). Returns what the engine says: whether the cap changed.
    pub fn set_max_concurrency(&mut self, max_concurrency: f64) -> Result<bool> {
        let result = self.engine.set_max_concurrency(max_concurrency);
        if let Some(link) = &self.concurrency
            && !self.engine.is_settled()
        {
            link.port
                .set_run_bound(&link.run_id, bound_of(self.engine.caps().max_concurrency));
        }
        self.after_engine(result)
    }

    /// Node `concurrencyChanged`: a cap change the governor fanned out to this run. Reached through the mailbox.
    pub fn concurrency_changed(&mut self, change: &ConcurrencyChange) -> Result<()> {
        if let Some(stall) = &self.stall {
            stall.note_cap(change.next);
        }
        let result = self.engine.concurrency_changed(change);
        self.after_engine(result)
    }

    /// Node's release at settlement. Taking the link drops it, and the drop ends the subscription and clears the bound.
    /// Taking it means this happens once per link.
    fn release_concurrency(&mut self) {
        self.concurrency.take();
    }

    /// Queue a start as the engine's dispatch would, for a test of the liveness check at apply time.
    #[cfg(test)]
    pub(crate) fn queue_start_for_test(
        &mut self,
        session: &str,
        instance: &Ref,
        message: AskMessage,
    ) {
        let (input, epilogue_start) = ask_input(
            &message.instructions,
            message.typed,
            message.schema.as_ref(),
            &SubmitProfile::Generic,
        );
        self.engine.driver.queued_starts.push(QueuedStart {
            session: session.to_owned(),
            instance: instance.clone(),
            message,
            turn: TurnInput {
                text: input,
                epilogue_start,
                submit_schema: None,
            },
        });
    }

    /// The journal behind the engine, read-only: the node rows an ask leaves (its message boundary, for one), for tests and
    /// for callers that inspect what the owner wrote.
    pub fn journal(&self) -> &J {
        &self.engine.journal
    }

    /// Set an actor's submit profile before its typed asks start (the caller's ask-to-actor analysis).
    pub fn set_actor_profile(&mut self, actor: &str, profile: SubmitProfile) {
        self.engine
            .driver
            .profiles
            .insert(actor.to_owned(), profile);
    }

    /// The session of an actor created by this owner.
    pub fn session_of(&self, actor: &str) -> Option<String> {
        self.engine.driver.session_of_actor.get(actor).cloned()
    }

    pub fn create_actor(
        &mut self,
        site_id: &str,
        name: Option<&str>,
        persona: Option<&Value>,
    ) -> Result<String> {
        let result = self.engine.create_actor(site_id, name, persona);
        self.after_engine(result)
    }

    pub fn ask(&mut self, site_id: &str, actor_id: &str, instructions: &str) -> Result<u64> {
        let result = self.engine.ask(site_id, actor_id, instructions);
        self.after_engine(result)
    }

    pub fn drain(&mut self) -> Result<()> {
        let result = self.engine.drain();
        self.after_engine(result)
    }

    pub fn complete(&mut self, artifact: Value) -> Result<()> {
        let result = self.engine.complete(artifact);
        self.after_engine(result)
    }

    /// The child's failed `complete` (W7-5a-3): the run fails with `error`, as Node's `failRun`. First settlement wins.
    pub fn fail(&mut self, error: WorkflowError) -> Result<()> {
        let result = self.engine.fail(error);
        self.after_engine(result)
    }

    /// The run's stop, as the residency ledger asks it (`LiveRun::stop_interrupted`, W6b part 6): the run settles as
    /// `stopped(interrupted)`, and the settlement releases the guard, the governor link and the clocks. Served on the
    /// owner's thread by the mailbox.
    pub fn stop_interrupted(&mut self) -> Result<()> {
        self.stop_with(StopReason::Interrupted, None)
    }

    /// The run's stop by a user or the model (W8a, 9.48; Node `stop(initiator)` through the cancel path): the run settles as
    /// `stopped(user | model)`, its in-flight asks are cancelled, and a parked question is withdrawn (row 69).
    pub fn stop_run(&mut self, reason: StopReason) -> Result<()> {
        self.stop_with(reason, None)
    }

    /// The run's stop by an amendment (9.43, Node `controller.abort({ superseded: newRunId })`): the run settles as
    /// `stopped(superseded)` and names the successor, as the journal's `superseded_by` column does.
    pub fn stop_superseded(&mut self, successor_run_id: &str) -> Result<()> {
        self.stop_with(StopReason::Superseded, Some(successor_run_id.to_owned()))
    }

    /// The shared stop: the same settlement order for every reason (see `stop_interrupted`).
    fn stop_with(&mut self, reason: StopReason, superseded_by: Option<String>) -> Result<()> {
        // The stop runs whatever the pump reports. A run that does not settle holds its guard, so every later close of
        // its parent waits out the full bound. The pump's error is still returned, after the run has settled.
        let pumped = self.pump();
        let result = self.engine.stop(reason, None, superseded_by);
        let stopped = self.after_engine(result);
        pumped?;
        stopped
    }

    /// Routes one observation of an actor's ask to its engine call (W7-3). The ask is found by its session. An
    /// observation for a session with no ask in flight changes nothing, as the engine ignores late observations.
    pub fn feed(&mut self, session: &str, event: FeedEvent) -> Result<()> {
        self.pump()?;
        match event {
            FeedEvent::Waiting(wait) => {
                let Some(instance) = self.active.get(session).map(|ask| ask.instance.clone())
                else {
                    return Ok(());
                };
                let result = self.engine.ask_waiting(&instance, wait);
                self.after_engine(result)
            }
            FeedEvent::Executing => {
                let Some(instance) = self.active.get(session).map(|ask| ask.instance.clone())
                else {
                    return Ok(());
                };
                let result = self.engine.ask_executing(&instance);
                self.after_engine(result)
            }
            FeedEvent::RetryScheduled(reason) => {
                self.model_retry_scheduled(&reason);
                Ok(())
            }
            FeedEvent::RequestCompleted => {
                self.model_request_completed();
                Ok(())
            }
            FeedEvent::LastTool(tool) => {
                if let Some(ask) = self.active.get_mut(session) {
                    ask.last_tool = Some(tool);
                }
                Ok(())
            }
        }
    }

    /// The settlements no mailbox reply claimed, in settlement order. A settlement a pending reply waits for goes to
    /// that reply instead.
    pub fn take_outcomes(&mut self) -> Vec<AskOutcome> {
        self.route_outcomes();
        std::mem::take(&mut self.unclaimed)
    }

    /// Registers the mailbox reply for `ticket` (W7-5a-2). The reply is answered when the ticket settles.
    pub(crate) fn await_ticket(&mut self, ticket: u64, reply: Sender<Result<TicketSettlement>>) {
        self.pending_tickets.insert(ticket, reply);
    }

    /// Hands every settlement to its pending reply, and keeps the rest for `take_outcomes`. Called after every mailbox
    /// request. The engine settles a stopped run's live asks with `Run stopped.` (Node's `abortInFlight`). A world read or
    /// publish is not live, so its reply waits for its worker, which then settles it with the run's error (Node's
    /// `settleWorldRead` throws `runError()` once the run has settled).
    pub(crate) fn route_outcomes(&mut self) {
        for outcome in self.engine.take_outcomes() {
            match self.pending_tickets.remove(&outcome.ticket) {
                Some(reply) => {
                    // A turn that has gone away is not an error for the owner: its reply has no receiver.
                    let _ = reply.send(Ok(outcome.result));
                }
                None => self.unclaimed.push(outcome),
            }
        }
    }

    /// Answers every pending reply with `error`.
    fn answer_pending_with(&mut self, error: &WorkflowError) {
        for (_ticket, reply) in self.pending_tickets.drain() {
            let _ = reply.send(Ok(Err(error.clone())));
        }
    }

    /// The child's log event (W7-5a-2). Node `log`: nothing is written after settlement.
    pub fn log(&mut self, message: &str) -> Result<()> {
        let result = self.engine.log(message);
        self.after_engine(result)
    }

    /// The child's phase-entered event (W7-5a-2). Node `enterPhase`.
    pub fn enter_phase(&mut self, name: &str) -> Result<()> {
        let result = self.engine.enter_phase(name);
        self.after_engine(result)
    }

    /// The child's report event (W7-5a-2). Node `report`: one item at the next ordinal of `site_id`.
    pub fn report(&mut self, site_id: &str, item: Value, artifact_id: Option<&str>) -> Result<()> {
        let result = self.engine.report(site_id, item, artifact_id);
        self.after_engine(result)
    }

    /// Attach the host's world wiring. Until it is attached, world reads fail with a driver fault.
    pub fn with_world(mut self, wiring: WorldWiring) -> Self {
        self.engine.driver.world = Some(wiring);
        self
    }

    /// Set the run's progress sink (9.31). The engine journals `run-started` while the owner is built, before any sink
    /// can be attached, so the rows already journaled are delivered to the sink first, in sequence order. They go
    /// through the same builder as later rows, so a late attach loses nothing.
    pub fn set_progress(&mut self, mut progress: Box<dyn RunProgress>) {
        // Once per owner (finding 5): a sink already installed has the backlog, so a second one would apply every row
        // twice to a shared projection. The second sink is dropped.
        if self.engine.driver.progress.is_some() {
            tracing::warn!(
                event = "dynamic_workflow.run_progress.sink_already_set",
                "a progress sink is already installed on this run; the new one is not attached"
            );
            return;
        }
        match self.events() {
            Ok(backlog) => {
                for stored in &backlog {
                    progress.progress(stored);
                }
            }
            Err(error) => tracing::warn!(
                event = "dynamic_workflow.run_progress.backlog_failed",
                error = %error,
                "the run's journaled events could not be read for progress; the sink starts at the next event, and this run's earlier rows are missing from the session projection (they are never re-applied) (9.31)"
            ),
        }
        self.engine.driver.progress = Some(progress);
    }

    /// Node `worldRead`: one world read or run at the next ordinal of `site_id`. The outcome comes back through
    /// `take_outcomes` once the worker has posted its settlement.
    pub fn world_read(&mut self, site_id: &str, op: &str, args: Vec<Value>) -> Result<u64> {
        let result = self.engine.world_read(site_id, op, args);
        self.after_engine(result)
    }

    /// Node `publish`: one content artifact version at the next ordinal of `site_id`.
    pub fn publish_artifact(&mut self, site_id: &str, op: &str, args: &[Value]) -> Result<u64> {
        let result = self.engine.publish_artifact(site_id, op, args);
        self.after_engine(result)
    }

    /// The time a hole's reach or fill is stamped with: the clock the host attached (the same one the redrives and the
    /// quota resets read), or the production clock when none is attached. Node reads `Date.now()` through `EngineConfig.now`.
    fn hole_clock_ms(&self) -> f64 {
        match &self.redrive {
            Some(wiring) => wiring.clock.now_ms() as f64,
            None => crate::engine_holes::wall_clock_ms(),
        }
    }

    /// Node `hole` (W7-12, 9.45): the script reached a hole with no body. The branch parks until its fill, or is answered
    /// at once from a fill this lifetime already has.
    pub fn hole(&mut self, site_id: &str, name: &str, prompt: Option<&str>) -> Result<u64> {
        let result = self
            .engine
            .hole(site_id, name, prompt, self.hole_clock_ms());
        self.after_engine(result)
    }

    /// Node `fillHole` (W7-12, 9.45): the effective script, the tables and the code of one hole. The parked branch is
    /// released with the code, and the outcome comes back through `take_outcomes`.
    pub fn fill_hole(
        &mut self,
        fill: crate::engine_holes::HoleFill,
    ) -> Result<crate::engine_holes::FillHoleResult> {
        let result = self.engine.fill_hole(fill, self.hole_clock_ms());
        self.after_engine(result)
    }

    /// The worker's answer to a world read (Node's `.then`). Called by the mailbox dispatch.
    pub(crate) fn world_settled(
        &mut self,
        instance: &Ref,
        result: std::result::Result<Value, WorkflowError>,
    ) -> Result<()> {
        self.engine.driver.world_running = self.engine.driver.world_running.saturating_sub(1);
        // The engine has already removed the live entry, so a failed journal write cannot be retried here. It is kept
        // as a deferred error and returned by the next owner call, not dropped.
        if let Err(error) = self.engine.world_read_settled(instance, result) {
            self.engine.driver.deferred_errors.push(error);
        }
        self.after_engine(Ok(()))
    }

    /// The worker's answer to an artifact publish. Called by the mailbox dispatch.
    pub(crate) fn artifact_settled(
        &mut self,
        instance: &Ref,
        result: std::result::Result<Value, WorkflowError>,
    ) -> Result<()> {
        self.engine.driver.world_running = self.engine.driver.world_running.saturating_sub(1);
        if let Err(error) = self.engine.artifact_publish_settled(instance, result) {
            self.engine.driver.deferred_errors.push(error);
        }
        self.after_engine(Ok(()))
    }

    pub fn events(&self) -> Result<Vec<StoredEvent>> {
        self.engine.events()
    }

    /// Every engine call is followed by a pump, even a failed one: a start the engine queued before it failed must
    /// not wait for the next call. The engine's own error is returned first; the pump's error after it.
    fn after_engine<T>(&mut self, result: Result<T>) -> Result<T> {
        let pumped = self.pump();
        let value = result?;
        pumped?;
        Ok(value)
    }

    /// The pump for a call that answers a reply. Its error is logged, not returned: the reply is the engine's, and a
    /// returned error would make the caller retry a call the engine has already settled.
    fn settle_quietly(&mut self) {
        log_settle_error(self.pump());
    }

    /// The reply is the engine's whether or not the pump fails while it settles. A failed engine call returns its
    /// error, since no reply exists; the pump error is logged in that case too, so it is not lost.
    fn reply_after<T>(
        &mut self,
        engine_result: Result<()>,
        reply: impl FnOnce(&mut Self) -> Result<T>,
    ) -> Result<T> {
        log_settle_error(self.pump());
        engine_result?;
        reply(self)
    }

    /// Node `makeSessionSubmitPort`: a `submit_result` call from a session's turn.
    pub fn submit_result(&mut self, session: &str, payload: Value) -> Result<SubmitReply> {
        self.settle_quietly();
        self.reset_unrecognized_streak(session);
        let ask = self.active.get(session).cloned();
        let typed = ask.as_ref().map(|ask| ask.typed).unwrap_or(false);
        match submit_route(ask.is_some(), typed) {
            SubmitRoute::NoActiveAsk => Ok(SubmitReply::Refused(NO_ACTIVE_ASK_MESSAGE.to_owned())),
            SubmitRoute::UntypedAsk => Ok(SubmitReply::Refused(UNTYPED_ASK_MESSAGE.to_owned())),
            SubmitRoute::Engine => {
                // submit_route admits a submit only while an ask is active, so the ask is present here.
                let ask = ask.ok_or_else(|| {
                    anyhow!("submit routing reached the engine with no active ask")
                })?;
                let key = ask.instance.key();
                let engine_result = self.engine.submit_attempted(&ask.instance, payload);
                let verdict = self.engine.driver.verdicts.remove(&key);
                self.reply_after(engine_result, move |owner| match verdict {
                    Some(verdict) => Ok(SubmitReply::Verdict(verdict)),
                    // No verdict and the engine no longer has this ask live: it settled it (repair budget spent).
                    // Node rejects the pending submit with `Cancelled`.
                    None if !owner.engine.is_live_ask(&ask.instance) => {
                        Ok(SubmitReply::Cancelled(CANCELLED_BY_ENGINE_MESSAGE.to_owned()))
                    }
                    // scheduler_submit answers every submit on a live typed ask with a verdict or a settlement.
                    None => Err(anyhow!(
                        "the engine answered neither a verdict nor a settlement to a submit on a live ask"
                    )),
                })
            }
        }
    }

    /// Node `turnEnded`: a turn finished without a submit. The engine answers Nudge, or settles the ask.
    pub fn turn_ended(&mut self, session: &str, final_text: &str) -> Result<TurnEndReply> {
        self.settle_quietly();
        self.reset_unrecognized_streak(session);
        let Some(ask) = self.active.get(session).cloned() else {
            return Ok(TurnEndReply::NoAsk);
        };
        let key = ask.instance.key();
        let engine_result = self.engine.turn_ended(&ask.instance, final_text);
        let verdict = self.engine.driver.verdicts.remove(&key);
        self.reply_after(engine_result, move |owner| match verdict {
            Some(verdict) => Ok(TurnEndReply::Verdict(verdict)),
            // No verdict and the engine no longer has this ask live: it settled it (an untyped text result, or
            // ResultNotSubmitted). No turn runs again.
            None if !owner.engine.is_live_ask(&ask.instance) => Ok(TurnEndReply::AskEnded),
            // scheduler_submit's turn-end path answers every live ask with a nudge or a settlement.
            None => Err(anyhow!(
                "the engine answered neither a nudge nor a settlement to a turn end on a live ask"
            )),
        })
    }

    /// Node `handleModelTurnFailure` (`workflow-driver-model-failure.ts`), for a turn that threw and was not cancelled.
    /// A failure with no model error fails the session's ask with `DriverError`, as Node's `askFailed` does. A model
    /// failure takes the workflow policy table: a permanent one stops the run as `stopped(provider)`, a context
    /// overflow fails only that ask with `ContextLimit`, and anything else is redriven after a backoff. A session with
    /// no ask in flight writes nothing.
    pub fn turn_failed(&mut self, session: &str, failure: &TurnFailure) -> Result<()> {
        self.settle_quietly();
        let Some(ask) = self.active.get(session).cloned() else {
            return Ok(());
        };
        let Some(model) = failure.model.as_ref() else {
            let result = self.engine.ask_failed(
                &ask.instance,
                WorkflowError::new(ErrorCode::DriverError, failure.message.clone()),
            );
            return self.after_engine(result);
        };
        // The streak counts this ask's unrecognized codes across its redrives: one more when this failure is again one.
        let streak = next_unrecognized_streak(ask.unrecognized, model);
        if let Some(active) = self.active.get_mut(session) {
            active.unrecognized = streak;
        }
        match model_failure_policy(model, streak) {
            WorkflowModelFailurePolicy::Stop(kind) => {
                let (subagent, name) = self.subagent_of(session, &ask);
                // Node sets `resetAt` for a quota stop only, and reads the time from the injected clock. Without a clock
                // there is no time to measure from, so no reset time is written.
                let reset_at = match (kind == ProviderStopKind::Quota, self.redrive.as_ref()) {
                    (true, Some(wiring)) => {
                        quota_reset_at(model, &failure.message, wiring.clock.now_ms())
                    }
                    _ => None,
                };
                let error = provider_stop_error(
                    kind,
                    model,
                    &failure.message,
                    &subagent,
                    name.as_deref(),
                    reset_at,
                );
                let result = self.engine.stop(StopReason::Provider, Some(error), None);
                self.after_engine(result)
            }
            WorkflowModelFailurePolicy::ContextExceeded => {
                let (subagent, name) = self.subagent_of(session, &ask);
                let label = name.unwrap_or(subagent);
                let error = WorkflowError::new(
                    ErrorCode::ContextLimit,
                    format!(
                        "Subagent {label} exceeded the model's context window even after compaction. \
                         Give this ask a smaller input or split the work across subagents."
                    ),
                );
                let result = self.engine.ask_failed(&ask.instance, error);
                self.after_engine(result)
            }
            WorkflowModelFailurePolicy::Retry | WorkflowModelFailurePolicy::Cancelled => {
                self.schedule_redrive(session, &ask, model)
            }
        }
    }

    /// The subagent a failure names: its ref and its persona name (Node `subagentLabel`'s inputs).
    fn subagent_of(&self, session: &str, ask: &ActiveAsk) -> (String, Option<String>) {
        match self.engine.driver.identity_of_session.get(session) {
            Some((actor, name)) => (actor.key(), name.clone()),
            None => (ask.instance.key(), None),
        }
    }

    /// Node `scheduleTransientRedrive`: counts the attempt, reports `askWaiting(backoff)`, and schedules the redrive.
    /// Retry-After wins over the backoff. Without a redrive clock the ask fails: a retry that cannot be scheduled
    /// would hang the run silently.
    fn schedule_redrive(
        &mut self,
        session: &str,
        ask: &ActiveAsk,
        model: &ModelError,
    ) -> Result<()> {
        let (slot, clock) = match self.redrive.as_ref() {
            Some(wiring) => (wiring.slot.clone(), wiring.clock.clone()),
            None => {
                let result = self.engine.ask_failed(
                    &ask.instance,
                    WorkflowError::new(
                        ErrorCode::DriverError,
                        "a transient model failure has no redrive clock to retry on",
                    ),
                );
                return self.after_engine(result);
            }
        };
        let attempt = ask.attempts + 1;
        if let Some(active) = self.active.get_mut(session) {
            active.attempts = attempt;
        }
        let retry_after_ms = retry_after_of(model);
        let delay_ms =
            retry_after_ms.unwrap_or_else(|| transient_backoff_ms(attempt, clock.random()));
        let wait = AskWait {
            cause: WaitCause::Backoff,
            reason: Some(facts_of(model).reason.to_owned()),
            attempt: Some(u64::from(attempt)),
            delay_ms: Some(delay_ms),
            retry_after_ms,
        };
        let instance = ask.instance.clone();
        let session_owned = session.to_owned();
        // The job reads the mailbox when it fires. A settled run has cleared the slot, so nothing is posted then.
        let scheduled = clock.after(
            delay_ms,
            Box::new(move || {
                let handle = match slot.lock() {
                    Ok(guard) => guard.clone(),
                    Err(_) => None,
                };
                if let Some(handle) = handle {
                    let _ = handle.post(ActorRequest::RedriveDue {
                        session: session_owned,
                        instance,
                    });
                }
            }),
        );
        // A job the clock refused never runs, so the ask must not wait for it (ocr review, finding 1).
        if !scheduled {
            let result = self.engine.ask_failed(
                &ask.instance,
                WorkflowError::new(
                    ErrorCode::DriverError,
                    format!(
                        "the transient model failure ({}) could not be redriven: the redrive clock refused the job",
                        facts_of(model).reason
                    ),
                ),
            );
            return self.after_engine(result);
        }
        if let Some(active) = self.active.get_mut(session) {
            active.stats_base = active.stats_last;
        }
        let waiting = self.engine.ask_waiting(&ask.instance, wait);
        self.after_engine(waiting)
    }

    /// Node's `turnEnded` and `submitResult` both count a turn that reached the owner as complete: its model requests
    /// finished. The unrecognized streak is a run of failures with no such turn between them (ocr review, finding 3).
    fn reset_unrecognized_streak(&mut self, session: &str) {
        if let Some(active) = self.active.get_mut(session) {
            active.unrecognized = 0;
        }
    }

    /// Release the redrive wiring at settlement: the slot is cleared, so a pending job posts nothing and holds no handle.
    fn release_redrive(&mut self) {
        if let Some(stall) = self.stall.take() {
            stall.dispose();
        }
        if let Some(wiring) = self.redrive.take()
            && let Ok(mut slot) = wiring.slot.lock()
        {
            *slot = None;
        }
    }

    /// Node's redrive, fired (W6b part 3): the ask's next turn starts with the continue prompt, on the same session and
    /// with the same schema. Nothing starts when the ask has settled, was cancelled, or is no longer the session's ask.
    pub fn redrive_due(&mut self, session: &str, instance: &Ref) -> Result<()> {
        self.settle_quietly();
        let Some(ask) = self.active.get(session).cloned() else {
            return Ok(());
        };
        if ask.instance.key() != instance.key()
            || !self.engine.is_live_ask(instance)
            || self.engine.driver.cancelled.contains(&instance.key())
        {
            return Ok(());
        }
        let Some(interaction) = self
            .engine
            .driver
            .interaction_of_session
            .get(session)
            .cloned()
        else {
            // Without its description the turn cannot be named, so the ask fails here rather than waiting (finding 4).
            let result = self.engine.ask_failed(
                instance,
                WorkflowError::new(
                    ErrorCode::DriverError,
                    format!("no interaction description is recorded for session {session}"),
                ),
            );
            return self.after_engine(result);
        };
        let input = TurnInput {
            text: TRANSIENT_CONTINUE_PROMPT.to_owned(),
            epilogue_start: 0,
            submit_schema: ask.schema.clone(),
        };
        match self.engine.driver.sessions.start_turn(
            session,
            instance,
            &ask.message,
            &input,
            &interaction,
        ) {
            Ok(()) => Ok(()),
            Err(error) => {
                let result = self.engine.ask_failed(
                    instance,
                    WorkflowError::new(ErrorCode::DriverError, error.to_string()),
                );
                self.after_engine(result)
            }
        }
    }

    /// Attach the redrive wiring (W6b part 3): the mailbox a redrive posts to, and the clock it waits on. Production
    /// attaches [`crate::model_failure::ThreadClock`]; tests attach a clock they run by hand.
    pub fn attach_redrive(&mut self, handle: ActorHandle, clock: Arc<dyn RedriveClock>) {
        let slot = Arc::new(Mutex::new(Some(handle)));
        // The stall clock's timers post to the same mailbox slot as the redrives, so a settled run posts nothing.
        let due_slot = slot.clone();
        let stall = RunStallClock::new(
            clock.clone(),
            Arc::new(move |generation| {
                let handle = match due_slot.lock() {
                    Ok(guard) => guard.clone(),
                    Err(_) => None,
                };
                if let Some(handle) = handle {
                    let _ = handle.post(ActorRequest::StallDue { generation });
                }
            }),
        );
        if let Some(previous) = self.stall.replace(stall) {
            previous.dispose();
        }
        self.redrive = Some(RedriveWiring { slot, clock });
    }

    /// Node `createRunStallClock`'s `noteSuccess` (W6b part 5): a model request of one of the run's actors succeeded.
    /// The turn side (W7) calls it for each completed request of an actor session.
    pub fn model_request_completed(&mut self) {
        if let Some(stall) = &self.stall {
            stall.note_success();
        }
    }

    /// Node's `model_retry_scheduled` observer (W6b part 5): a retry with this reason is scheduled for one of the run's
    /// actors. The non-failure reasons (`reasoning_signature_repair`, `auth_refresh`) do not arm the clock.
    pub fn model_retry_scheduled(&mut self, reason: &str) {
        if NON_FAILURE_RETRY_REASONS.contains(&reason) {
            return;
        }
        if let Some(stall) = &self.stall {
            stall.note_retry_scheduled(reason);
        }
    }

    /// The stall clock's timer fired for `generation` (W6b part 5): records a `run-stalled` notice when it is real.
    pub fn stall_due(&mut self, generation: u64) -> Result<()> {
        let Some(info) = self.stall.as_ref().and_then(|stall| stall.fire(generation)) else {
            return Ok(());
        };
        let result = self.engine.run_stalled(info);
        self.after_engine(result)
    }

    /// The run's settlement once it has settled (`None` while it runs).
    pub fn settlement(&self) -> Option<&RunSettlement> {
        self.engine.settlement()
    }

    /// Test hook (ocr review): the tool and world-tool counts the owner last reported for the session's ask.
    #[cfg(test)]
    pub(crate) fn reported_stats(&self, session: &str) -> Option<(f64, f64)> {
        self.active.get(session).map(|ask| ask.stats_last)
    }

    /// Test hook (ocr review): removes the session's interaction description, as a session that lost it would.
    #[cfg(test)]
    pub(crate) fn forget_interaction_for_test(&mut self, session: &str) {
        self.engine.driver.interaction_of_session.remove(session);
    }

    /// Node `workflow-driver-transcript.ts`: the ask's message boundary, written on its node row. The turn thread names
    /// the instance it ran, so the boundary lands on that ask even if a newer ask has started since it settled. A
    /// cancelled ask takes none (Node returns early on `state.cancelled`).
    pub fn set_message_boundary(&mut self, instance: &Ref, boundary: u64) -> Result<()> {
        self.pump()?;
        if self.engine.driver.cancelled.contains(&instance.key()) {
            return Ok(());
        }
        let result = self.engine.set_message_boundary(instance, boundary);
        self.after_engine(result)
    }

    /// One turn's ask stats (Node `reportTurnObservations`), written to the instance the turn ran for. The report names
    /// that instance, so it cannot land on a newer ask of the session.
    pub fn ask_stats(&mut self, instance: &Ref, stats: crate::engine::AskStats) -> Result<()> {
        self.pump()?;
        // A redriven turn reports counts from zero, so the earlier turns' counts are added on top of its own (finding 9).
        let key = instance.key();
        // The ask's resolved turns count across its redrives (Node's `turnsResolved` is per ask).
        let mut turn = None;
        let mut last_tool = None;
        let stats = match self
            .active
            .values_mut()
            .find(|ask| ask.instance.key() == key)
        {
            Some(ask) => {
                ask.turns += 1;
                turn = Some(ask.turns);
                last_tool = ask.last_tool.clone();
                let (base_tools, base_world) = ask.stats_base;
                let report = crate::engine::AskStats {
                    tool_calls: base_tools + stats.tool_calls,
                    world_tool_calls: stats.world_tool_calls.map(|world| base_world + world),
                    ..stats
                };
                ask.stats_last = (
                    report.tool_calls,
                    report.world_tool_calls.unwrap_or(base_world),
                );
                report
            }
            None => stats,
        };
        // Node `reportTurnObservations`: the progress of the resolved turn goes first, then its usage.
        if let Some(turn) = turn {
            let progress = self.engine.ask_progress(
                instance,
                AskProgress {
                    turn,
                    tool_calls: stats.tool_calls,
                    last_tool,
                },
            );
            self.after_engine(progress)?;
        }
        let result = self.engine.ask_stats(instance, stats);
        self.after_engine(result)
    }

    /// Node `askMutating`: the session's active ask is about to run a mutating tool. Ignored when no ask is in
    /// flight, as the engine ignores observations after an ask settles.
    pub fn ask_mutating(&mut self, session: &str) -> Result<()> {
        self.pump()?;
        let Some(ask) = self.active.get(session).cloned() else {
            return Ok(());
        };
        let result = self.engine.ask_mutating(&ask.instance);
        self.after_engine(result)
    }

    /// Node `makeSessionEscalatePort`: the book decides, and every write goes through the engine's journal.
    pub fn escalate(
        &mut self,
        session: &str,
        request: EscalationRequest,
    ) -> Result<EscalateOutcome> {
        self.settle_quietly();
        let mut request = request;
        if let Some((actor, name)) = self.engine.driver.identity_of_session.get(session) {
            request.actor = actor.clone();
            request.actor_name = name.clone();
        }
        let engine = &mut self.engine;
        self.book
            .escalate(session, request, |event| engine.record(event.clone()))
    }

    /// The questions parked on a session, oldest first (the book's view; the turn side waits on them by id).
    pub fn parked_questions(&self, session: &str) -> Vec<String> {
        self.book.pending_questions(session)
    }

    /// Node `answerEscalation`: the main agent's answer to a parked question.
    pub fn answer(&mut self, qid: &str, answer: &str) -> Result<Option<AnswerOutcome>> {
        self.settle_quietly();
        // Only a parked question has a session to deliver to. The book answers exactly the questions it parks, so a
        // question found here is accepted below.
        let Some(session) = self.book.session_of_question(qid) else {
            return Ok(None);
        };
        let engine = &mut self.engine;
        let Some(mut outcome) = self
            .book
            .answer(qid, answer, |event| engine.record(event.clone()))
        else {
            return Err(anyhow!(
                "the escalation book lost parked question {qid} between its lookup and its answer"
            ));
        };
        // Node delivers the answer whether or not the resolved event was journaled, so delivery follows the book's
        // acceptance and not the journal write. Node's resolve cannot fail, but the Rust turn can be gone; a refused
        // delivery is reported on the outcome (the question is retired either way) and logged.
        if let Err(error) = self
            .engine
            .driver
            .sessions
            .deliver_answer(&session, qid, answer)
        {
            tracing::warn!(
                session = %session,
                qid = %qid,
                error = ?error,
                "an accepted escalation answer was not delivered to its blocked turn"
            );
            outcome.delivery_warning = Some(format!("{error:#}"));
        }
        Ok(Some(outcome))
    }

    /// Apply what the port queued, until nothing is queued, then reconcile. Every exit path reconciles. Every queued
    /// item is applied even when one fails; the first error is returned at the end. A start is applied to the book
    /// before its turn starts, so a question raised by a turn always finds its ask active.
    fn pump(&mut self) -> Result<()> {
        let mut first: Option<anyhow::Error> = None;
        loop {
            let starts = std::mem::take(&mut self.engine.driver.queued_starts);
            let failures = std::mem::take(&mut self.engine.driver.queued_failures);
            let jobs = std::mem::take(&mut self.engine.driver.queued_world);
            self.engine.driver.world_queue.extend(jobs);
            for job in self.start_world_jobs() {
                // No wiring: the node fails with a typed error rather than waiting for a worker that never starts.
                let settled = match job {
                    WorldJob::Read { instance, .. } => self.engine.world_read_settled(
                        &instance,
                        Err(WorkflowError::new(
                            ErrorCode::DriverError,
                            "world reads are not wired to the actor driver",
                        )),
                    ),
                    WorldJob::Publish { instance, .. } => self.engine.artifact_publish_settled(
                        &instance,
                        Err(WorkflowError::new(
                            ErrorCode::ArtifactStoreUnavailable,
                            "this assembly has no artifact store",
                        )),
                    ),
                };
                if let Err(error) = settled {
                    first.get_or_insert(error);
                }
            }
            if starts.is_empty() && failures.is_empty() {
                break;
            }
            for start in starts {
                self.apply_start(start, &mut first);
            }
            for (instance, error) in failures {
                let key = instance.key();
                self.engine.driver.verdicts.remove(&key);
                self.engine.driver.session_of_instance.remove(&key);
                if let Err(engine_error) = self.engine.ask_failed(&instance, error) {
                    first.get_or_insert(engine_error);
                }
            }
            if let Err(error) = self.reconcile() {
                first.get_or_insert(error);
            }
        }
        if let Err(error) = self.reconcile() {
            first.get_or_insert(error);
        }
        for error in std::mem::take(&mut self.engine.driver.deferred_errors) {
            first.get_or_insert(error);
        }
        // The run has settled and no world job is left: the owner stops holding the mailbox handle, so the owner loop
        // can end once the turns and workers are gone. Nothing new can start after settlement.
        if self.engine.is_settled()
            && self.engine.driver.world_running == 0
            && self.engine.driver.world_queue.is_empty()
        {
            self.engine.driver.world = None;
        }
        // Settlement releases the run from the governor (once: `release_concurrency` takes the link), and the parent
        // session's residency guard (W6b part 6).
        if self.engine.is_settled() {
            self.release_concurrency();
            self.release_redrive();
            self.residency.take();
        }
        match first {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Start queued world jobs while fewer than [`WORLD_JOB_LIMIT`] are running. Returns the jobs that have no wiring.
    fn start_world_jobs(&mut self) -> Vec<WorldJob> {
        let mut unwired = Vec::new();
        loop {
            let port = &mut self.engine.driver;
            if port.world_running >= WORLD_JOB_LIMIT {
                break;
            }
            let Some(job) = port.world_queue.pop_front() else {
                break;
            };
            match &port.world {
                Some(wiring) => {
                    spawn_world_job(wiring, job);
                    port.world_running += 1;
                }
                None => unwired.push(job),
            }
        }
        unwired
    }

    /// One queued start: the book starts the ask (withdrawing the previous one's parked questions), then the turn is
    /// started. A refused turn ends the ask again and fails it with the send error (Node `askFailed`).
    // Withdrawal (here, `reconcile`, and the refused-start path) retires each question in the book before it rejects
    // the turn side's deferred. Node does the same (`withdrawSessionEscalations` retires the registry entry, then
    // rejects), and a promise rejection cannot fail there. So a refused reject is returned by the pump, not retried:
    // the question is gone from the book either way, and the caller sees the error.
    fn apply_start(&mut self, start: QueuedStart, first: &mut Option<anyhow::Error>) {
        // A start queued before the engine cancelled or completed its ask must not start a turn for a dead ask.
        if !self.engine.is_live_ask(&start.instance) {
            tracing::debug!(
                instance = %start.instance.key(),
                session = %start.session,
                "dropped a queued start: its ask is no longer live"
            );
            return;
        }
        // Every session an ask starts on was made by `create_actor_session`, which records its interaction description.
        // A session without one is a broken pairing: the ask fails loudly, and no turn starts with an empty origin.
        let Some(interaction) = self
            .engine
            .driver
            .interaction_of_session
            .get(&start.session)
            .cloned()
        else {
            let error = anyhow!(
                "no interaction description is recorded for session {}",
                start.session
            );
            self.refuse_start(start, error, first);
            return;
        };
        let withdrawn = self.book.start_ask(&start.session);
        for qid in withdrawn {
            if let Err(error) = self
                .engine
                .driver
                .sessions
                .reject_parked(&start.session, &qid)
            {
                first.get_or_insert(error);
            }
        }
        match self.engine.driver.sessions.start_turn(
            &start.session,
            &start.instance,
            &start.message,
            &start.turn,
            &interaction,
        ) {
            Ok(()) => {
                self.active.insert(
                    start.session.clone(),
                    ActiveAsk {
                        instance: start.instance.clone(),
                        typed: start.message.typed,
                        message: start.message.clone(),
                        schema: start.turn.submit_schema.clone(),
                        attempts: 0,
                        unrecognized: 0,
                        turns: 0,
                        stats_base: (0.0, 0.0),
                        stats_last: (0.0, 0.0),
                        last_tool: None,
                    },
                );
                self.engine
                    .driver
                    .session_of_instance
                    .insert(start.instance.key(), start.session.clone());
            }
            Err(error) => self.refuse_start(start, error, first),
        }
    }

    /// A start that could not be made: the ask's parked questions are withdrawn, and the ask fails with the error at
    /// the next drain. Shared by a refused turn and a session with no interaction description.
    fn refuse_start(
        &mut self,
        start: QueuedStart,
        error: anyhow::Error,
        first: &mut Option<anyhow::Error>,
    ) {
        for qid in self.book.end_ask(&start.session) {
            if let Err(reject) = self
                .engine
                .driver
                .sessions
                .reject_parked(&start.session, &qid)
            {
                first.get_or_insert(reject);
            }
        }
        self.engine.driver.queued_failures.push((
            start.instance,
            WorkflowError::new(ErrorCode::DriverError, format!("{error:#}")),
        ));
    }

    /// End every active ask the engine no longer has live: the book withdraws its parked questions and the turn side
    /// rejects them. Every ended ask is processed; the first error is returned.
    fn reconcile(&mut self) -> Result<()> {
        let ended: Vec<String> = self
            .active
            .iter()
            .filter(|(_, ask)| !self.engine.is_live_ask(&ask.instance))
            .map(|(session, _)| session.clone())
            .collect();
        let mut first: Option<anyhow::Error> = None;
        for session in ended {
            if let Some(ask) = self.active.remove(&session) {
                let key = ask.instance.key();
                self.engine.driver.session_of_instance.remove(&key);
                self.engine.driver.verdicts.remove(&key);
            }
            for qid in self.book.end_ask(&session) {
                if let Err(error) = self.engine.driver.sessions.reject_parked(&session, &qid) {
                    first.get_or_insert(error);
                }
            }
        }
        match first {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}
