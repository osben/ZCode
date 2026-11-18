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
use crate::driver_rules::{
    NO_ACTIVE_ASK_MESSAGE, ProfileFit, SubmitProfile, SubmitRoute, UNTYPED_ASK_MESSAGE,
    actor_session_title, actor_task_link_path, profile_fit, submit_route,
};
use crate::engine::{
    AskMessage, AskOutcome, EngineConfig, SubmitVerdict, WorkflowDriver, WorkflowEngine,
};
use crate::error::{ErrorCode, WorkflowError};
use crate::escalation::{AnswerOutcome, EscalateOutcome, EscalationBook, EscalationRequest};
use crate::event::RunEvent;
use crate::journal::JournalPort;
use crate::model::{Ref, StoredEvent};
use anyhow::{Result, anyhow};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

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
    fn start_turn(&mut self, session: &str, instance: &Ref, message: &AskMessage) -> Result<()>;
    /// Stop the session's turn for an ask the engine cancelled.
    fn cancel_turn(&mut self, session: &str, instance: &Ref) -> Result<()>;
    /// Reject the deferred of a parked question that was withdrawn with its ask.
    fn reject_parked(&mut self, session: &str, qid: &str) -> Result<()>;
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
    /// Session of each ask whose turn has started and not ended, keyed by instance. Removed when the ask ends.
    session_of_instance: HashMap<String, String>,
    queued_starts: Vec<QueuedStart>,
    queued_failures: Vec<(Ref, WorkflowError)>,
    /// Errors the engine cannot receive (its trait methods return nothing); the owner returns them.
    deferred_errors: Vec<anyhow::Error>,
    /// The engine's verdict for each instance, taken by the owner right after the engine call that made it.
    verdicts: HashMap<String, SubmitVerdict>,
}

impl<S: ActorSessions> WorkflowDriver for ActorPort<S> {
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
        if message.typed {
            let profile = self
                .profiles
                .get(&actor_key)
                .cloned()
                .unwrap_or(SubmitProfile::Generic);
            let schema = message.schema.clone().unwrap_or(Value::Null);
            // A failed fit fails the ask before any turn starts (Node `ensureSubmitProfileFits` throws inside the
            // ask's promise, so the engine sees `askFailed`).
            if let ProfileFit::Fail { message: text } =
                profile_fit(&profile, &schema, &instance.key(), session)
            {
                self.queued_failures.push((
                    instance.clone(),
                    WorkflowError::new(ErrorCode::DriverError, text),
                ));
                return;
            }
        }
        self.queued_starts.push(QueuedStart {
            session: session.to_owned(),
            instance: instance.clone(),
            message: message.clone(),
        });
    }

    fn respond_to_submit(&mut self, instance: &Ref, verdict: &SubmitVerdict) {
        self.verdicts.insert(instance.key(), verdict.clone());
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

    fn start_world_read(&mut self, instance: &Ref, _op: &str, _args: &Value) {
        // World reads are W6b. Until then an ask that reaches one fails as a driver fault.
        self.queued_failures.push((
            instance.clone(),
            WorkflowError::new(
                ErrorCode::DriverError,
                "world reads are not wired to the actor driver yet",
            ),
        ));
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
            session_of_instance: HashMap::new(),
            queued_starts: Vec::new(),
            queued_failures: Vec::new(),
            deferred_errors: Vec::new(),
            verdicts: HashMap::new(),
        };
        let book = EscalationBook::new(config.run_id.clone());
        let engine = WorkflowEngine::new(config, journal, port)?;
        Ok(Self {
            engine,
            book,
            active: BTreeMap::new(),
        })
    }

    /// Queue a start as the engine's dispatch would, for a test of the liveness check at apply time.
    #[cfg(test)]
    pub(crate) fn queue_start_for_test(
        &mut self,
        session: &str,
        instance: &Ref,
        message: AskMessage,
    ) {
        self.engine.driver.queued_starts.push(QueuedStart {
            session: session.to_owned(),
            instance: instance.clone(),
            message,
        });
    }

    /// The journal behind the engine, for tests that read what the owner wrote.
    #[cfg(test)]
    pub(crate) fn journal(&self) -> &J {
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

    /// Node `workflow-driver-transcript.ts`: the ask's message boundary, written on its node row. A session with no
    /// ask in flight writes nothing.
    pub fn set_message_boundary(&mut self, session: &str, boundary: u64) -> Result<()> {
        self.pump()?;
        let Some(ask) = self.active.get(session).cloned() else {
            return Ok(());
        };
        let result = self.engine.set_message_boundary(&ask.instance, boundary);
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
        let engine = &mut self.engine;
        self.book
            .escalate(session, request, |event| engine.record(event.clone()))
    }

    /// Node `answerEscalation`: the main agent's answer to a parked question.
    pub fn answer(&mut self, qid: &str, answer: &str) -> Result<Option<AnswerOutcome>> {
        self.settle_quietly();
        let engine = &mut self.engine;
        Ok(self
            .book
            .answer(qid, answer, |event| engine.record(event.clone())))
    }

    /// Apply what the port queued, until nothing is queued, then reconcile. Every exit path reconciles. Every queued
    /// item is applied even when one fails; the first error is returned at the end. A start is applied to the book
    /// before its turn starts, so a question raised by a turn always finds its ask active.
    fn pump(&mut self) -> Result<()> {
        let mut first: Option<anyhow::Error> = None;
        loop {
            let starts = std::mem::take(&mut self.engine.driver.queued_starts);
            let failures = std::mem::take(&mut self.engine.driver.queued_failures);
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
        match first {
            Some(error) => Err(error),
            None => Ok(()),
        }
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
            Err(error) => {
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
        }
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
