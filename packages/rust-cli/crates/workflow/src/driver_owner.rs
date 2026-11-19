//! The driver owner of an actor run (W6a part 2; spec section 9.8).
//!
//! `ActorDriverOwner` is the only caller of the engine on the driver side and the only holder of the escalation
//! book and the active-ask table. Turns (the async side, on each actor's child session) reach it through
//! `submit_result`, `turn_ended`, `escalate`, and `answer`, one message at a time. The engine reaches the turn side
//! through `ActorPort`, the engine's `WorkflowDriver`, which only queues work and records verdicts: it never touches
//! the book, and it never blocks.
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
use crate::actor_mailbox::{ActorHandle, ActorRequest};
use crate::actor_turns::TurnInput;
use crate::driver_rules::{
    NO_ACTIVE_ASK_MESSAGE, ProfileFit, SubmitProfile, SubmitRoute, UNTYPED_ASK_MESSAGE,
    actor_interaction_description, actor_session_title, actor_task_link_path, ask_input,
    profile_fit, submit_route,
};
use crate::engine::{
    AskMessage, AskOutcome, EngineConfig, SubmitVerdict, WorkflowDriver, WorkflowEngine,
};
use crate::engine_artifacts::ArtifactPublishRequest;
use crate::error::{ErrorCode, WorkflowError};
use crate::escalation::{AnswerOutcome, EscalateOutcome, EscalationBook, EscalationRequest};
use crate::event::RunEvent;
use crate::journal::JournalPort;
use crate::model::{ConcurrencyChange, Ref, StoredEvent};
use crate::persona::persona_name;
use crate::run_concurrency::RunConcurrency;
use crate::world_host::{WORLD_JOB_LIMIT, WorldJob, WorldWiring, spawn_world_job};
use anyhow::{Result, anyhow};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;

/// Node `cancelAsk`'s rejection of a pending submit: the text the submit's caller reads.
pub const CANCELLED_BY_ENGINE_MESSAGE: &str = "The ask was cancelled by the engine.";

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
}

impl<S: ActorSessions> WorkflowDriver for ActorPort<S> {
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
        _seed: Option<&crate::imported_cache::ActorSessionSeed>,
    ) -> Result<String> {
        let request = ActorSessionRequest {
            run_id: self.run_id.clone(),
            parent_session_id: self.parent_session_id.clone(),
            actor: actor.clone(),
            title: actor_session_title(&actor.site_id, actor.ordinal),
            link_path: actor_task_link_path(&self.run_id, &actor.site_id, actor.ordinal),
            persona: persona.clone(),
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
        // The journal is the record (the engine appends before it emits). The fan-out to the Host is W7; until
        // then nothing reads events here, so the port keeps none.
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
        };
        let book = EscalationBook::new(config.run_id.clone());
        let engine = WorkflowEngine::new(config, journal, port)?;
        Ok(Self {
            engine,
            book,
            active: BTreeMap::new(),
            concurrency: None,
        })
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

    pub fn take_outcomes(&mut self) -> Vec<AskOutcome> {
        self.engine.take_outcomes()
    }

    /// Attach the host's world wiring. Until it is attached, world reads fail with a driver fault.
    pub fn with_world(mut self, wiring: WorldWiring) -> Self {
        self.engine.driver.world = Some(wiring);
        self
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

    /// Node `askFailed` for a turn that threw and was not cancelled (`workflow-driver.ts` `onTurnRejected`): the
    /// engine settles the session's active ask as failed with the turn's text. A session with no ask in flight
    /// writes nothing.
    pub fn turn_failed(&mut self, session: &str, message: &str) -> Result<()> {
        self.settle_quietly();
        let Some(ask) = self.active.get(session).cloned() else {
            return Ok(());
        };
        let result = self.engine.ask_failed(
            &ask.instance,
            WorkflowError::new(ErrorCode::DriverError, message),
        );
        self.after_engine(result)
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
        // Settlement releases the run from the governor (once: `release_concurrency` takes the link).
        if self.engine.is_settled() {
            self.release_concurrency();
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
