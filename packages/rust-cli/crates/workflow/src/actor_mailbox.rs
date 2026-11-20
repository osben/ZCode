//! The mailbox between the actor turns and the owner (W6a part 2c-1; spec section 9.8c).
//!
//! Turns run on their own threads and send requests here: a submit, a turn end, an escalate, or an answer. Each request
//! carries its own reply channel, and the sending turn blocks on it. The owner thread is the only one that serves the
//! mailbox, so the owner stays single-threaded.
//!
//! Invariants.
//! - The mailbox keeps no sender. `new` returns the one receiver and one handle, and handles are cloned from that
//!   handle. When every handle is dropped the channel disconnects, and `serve_next` returns `MailboxError::Closed`, so
//!   the owner loop can end.
//! - A request is delivered to the owner only when the send succeeds. A send that fails was not delivered, and a turn
//!   may retry it (`MailboxError::NotDelivered`).
//! - A request the owner took and never answered drops its reply sender. That happens when the owner panics mid-call,
//!   since unwinding drops the request. The turn then gets `MailboxError::NoAnswer`, which says the request may already
//!   have been applied. A retry must not assume it was not.
//! - An owner error crosses unchanged as an `anyhow::Error` (`MailboxError::Owner`), so its context chain survives.
use crate::actor_feed::FeedEvent;
use crate::driver_owner::{
    ActorDriverOwner, ActorSessions, SubmitReply, TicketSettlement, TurnEndReply,
};
use crate::error::WorkflowError;
use crate::escalation::{AnswerOutcome, EscalateOutcome, EscalationRequest};
use crate::journal::JournalPort;
use crate::model::{ConcurrencyChange, Ref};
use crate::model_failure::TurnFailure;
use crate::parked_answers::ParkedAnswers;
use crate::residency::LiveRun;
use anyhow::Result;
use serde_json::Value;
use std::fmt;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};

/// Why a request did not get the owner's reply.
#[derive(Debug)]
pub enum MailboxError {
    /// The owner is gone and the request was not delivered. Safe to retry.
    NotDelivered,
    /// The owner took the request and stopped before it answered. The request may already have been applied.
    NoAnswer,
    /// Every handle is dropped. Seen by the owner loop, which should end.
    Closed,
    /// The owner answered with an error. The error and its context are kept.
    Owner(anyhow::Error),
}

impl fmt::Display for MailboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotDelivered => {
                f.write_str("the owner is gone; the request was not delivered and is safe to retry")
            }
            Self::NoAnswer => f.write_str(
                "the owner stopped before it answered; the request may already have been applied",
            ),
            Self::Closed => f.write_str("every handle to the actor mailbox is dropped"),
            Self::Owner(error) => write!(f, "{error:#}"),
        }
    }
}

/// `Display` already prints the owner error's whole chain, so `source` stays `None` to keep reporters from printing it
/// twice.
impl std::error::Error for MailboxError {}

/// One request from a turn to the owner. Crate-internal: only the handle builds these.
pub(crate) enum ActorRequest {
    Submit {
        session: String,
        payload: Value,
        reply: Sender<Result<SubmitReply>>,
    },
    TurnEnded {
        session: String,
        text: String,
        reply: Sender<Result<TurnEndReply>>,
    },
    Escalate {
        session: String,
        request: EscalationRequest,
        reply: Sender<Result<EscalateOutcome>>,
    },
    Answer {
        qid: String,
        answer: String,
        reply: Sender<Result<Option<AnswerOutcome>>>,
    },
    /// A turn threw (not cancelled): the owner applies the model-failure policy (Node `handleModelTurnFailure`), which
    /// stops the run, fails the ask, or schedules a redrive.
    TurnFailed {
        session: String,
        failure: TurnFailure,
        reply: Sender<Result<()>>,
    },
    /// A scheduled redrive is due (W6b part 3). Sent by the redrive clock's job; no answer goes back.
    RedriveDue { session: String, instance: Ref },
    /// The stall clock's timer for `generation` is due (W6b part 5). Sent by the clock's job; no answer goes back.
    StallDue { generation: u64 },
    /// A workspace-mutating call of the session's ask is about to run (Node `askMutating`).
    Mutating {
        session: String,
        reply: Sender<Result<()>>,
    },
    /// The message boundary of a settled ask (Node `journalAskMessageBoundary`), sent after its settlement.
    MessageBoundary {
        instance: Ref,
        boundary: u64,
        reply: Sender<Result<()>>,
    },
    /// One turn's ask stats (Node `reportTurnObservations`), sent before the turn's end.
    AskStats {
        instance: Ref,
        stats: crate::engine::AskStats,
        reply: Sender<Result<()>>,
    },
    /// A worker finished a live world read (Node's `.then` on `executeWorldRead`). No answer goes back.
    WorldSettled {
        instance: Ref,
        result: Result<Value, crate::error::WorkflowError>,
    },
    /// A worker finished an artifact publish (Node's `.then` on `executeArtifactPublish`). No answer goes back.
    ArtifactSettled {
        instance: Ref,
        result: Result<Value, crate::error::WorkflowError>,
    },
    /// The governor changed a cap this run is engaged on (Node's `concurrencyChanged`, from the run's subscription).
    /// No answer goes back.
    ConcurrencyChanged { change: ConcurrencyChange },
    /// One observation of an actor's ask, fed by the turn side (W7-3). No answer goes back.
    Feed { session: String, event: FeedEvent },
    /// The run's stop from the residency ledger (W6b part 6, `LiveRun`). No answer goes back.
    StopInterrupted,
    /// The run's stop by an amendment (9.43): it settles as `stopped(superseded)` naming `successor_run_id`. No answer
    /// goes back; the caller waits for the settlement itself.
    StopSuperseded { successor_run_id: String },
    /// The child's `create-actor` (W7-5a-2). The answer is the engine's actor id, which the child's later requests name.
    CreateActor {
        site_id: String,
        name: Option<String>,
        persona: Option<Value>,
        reply: Sender<Result<String>>,
    },
    /// The child's `ask` (W7-5a-2). The reply waits for the ask's settlement, not for its ticket.
    Ask {
        site_id: String,
        actor: String,
        instructions: String,
        reply: Sender<Result<TicketSettlement>>,
    },
    /// The child's world read (W7-5a-2). The reply waits for the worker's settlement.
    WorldRead {
        site_id: String,
        op: String,
        args: Vec<Value>,
        reply: Sender<Result<TicketSettlement>>,
    },
    /// The child's content artifact publish (W7-5a-2). The reply waits for the store's settlement.
    PublishArtifact {
        site_id: String,
        op: String,
        args: Vec<Value>,
        reply: Sender<Result<TicketSettlement>>,
    },
    /// The child's hole (W7-12, 9.45). The reply waits for the fill, or is answered at once from a fill this lifetime has.
    Hole {
        site_id: String,
        name: String,
        prompt: Option<String>,
        reply: Sender<Result<TicketSettlement>>,
    },
    /// The run service's fill of one hole (W7-12, 9.45). The reply is the engine's answer, not a ticket.
    FillHole {
        fill: crate::engine_holes::HoleFill,
        reply: Sender<Result<crate::engine_holes::FillHoleResult>>,
    },
    /// The child's `complete`: the script's end (W7-5a-2).
    Complete {
        artifact: Value,
        reply: Sender<Result<()>>,
    },
    /// The child's `complete` with an error (W7-5a-3): the script threw, and the run fails with the error (Node `failRun`).
    Fail {
        error: WorkflowError,
        reply: Sender<Result<()>>,
    },
    /// The host's drain after a slice of child calls (W7-5a-2). Starts the turns the calls queued.
    Drain { reply: Sender<Result<()>> },
    /// The child's `log` event (W7-5a-2). No answer goes back.
    Log { message: String },
    /// The child's `report` event (W7-5a-2). No answer goes back.
    Report {
        site_id: String,
        item: Value,
        artifact_id: Option<String>,
    },
    /// The child's `phase-entered` event (W7-5a-2). No answer goes back.
    EnterPhase { name: String },
}

impl ActorHandle {
    /// Post a request without waiting for an answer. False when the owner is gone.
    pub(crate) fn post(&self, request: ActorRequest) -> bool {
        self.tx.send(request).is_ok()
    }
}

/// A child's ticketed call, for [`ActorHandle::send_ticketed`] (W7-5a-3).
#[derive(Debug, Clone, PartialEq)]
pub enum TicketedCall {
    Ask {
        site_id: String,
        actor: String,
        instructions: String,
    },
    WorldRead {
        site_id: String,
        op: String,
        args: Vec<Value>,
    },
    PublishArtifact {
        site_id: String,
        op: String,
        args: Vec<Value>,
    },
    /// A hole with no body (W7-12, 9.45).
    Hole {
        site_id: String,
        name: String,
        prompt: Option<String>,
    },
}

/// The owner's side of the channel. Only the owner thread receives from it.
pub struct ActorMailbox {
    rx: Receiver<ActorRequest>,
}

/// A turn's side of the channel. Cheap to clone; each turn or main-agent caller holds one.
#[derive(Clone)]
pub struct ActorHandle {
    tx: Sender<ActorRequest>,
    parked: Arc<ParkedAnswers>,
}

impl ActorMailbox {
    /// The owner's receiver and the first handle. Clone the handle for each turn.
    pub fn new() -> (Self, ActorHandle) {
        let (tx, rx) = channel();
        let parked = Arc::new(ParkedAnswers::new());
        (Self { rx }, ActorHandle { tx, parked })
    }

    /// Wait for the next request, without answering it. Crate-internal, so tests can take a request and drop it.
    pub(crate) fn take(&self) -> Result<ActorRequest, MailboxError> {
        self.rx.recv().map_err(|_| MailboxError::Closed)
    }

    /// The next request if one is queued. Crate-internal, for tests that assert nothing was sent.
    #[cfg(test)]
    pub(crate) fn try_take(&self) -> Option<ActorRequest> {
        self.rx.try_recv().ok()
    }

    /// Wait for one request and answer it on the owner. The reply goes back on the request's own channel; a turn that
    /// has gone away is not an error for the owner.
    pub fn serve_next<J: JournalPort, S: ActorSessions>(
        &self,
        owner: &mut ActorDriverOwner<J, S>,
    ) -> Result<(), MailboxError> {
        let request = self.take()?;
        dispatch(request, owner);
        Ok(())
    }
}

fn dispatch<J: JournalPort, S: ActorSessions>(
    request: ActorRequest,
    owner: &mut ActorDriverOwner<J, S>,
) {
    dispatch_request(request, owner);
    // Every settlement this request produced reaches its ticket's reply, or is kept for `take_outcomes`.
    owner.route_outcomes();
}

fn dispatch_request<J: JournalPort, S: ActorSessions>(
    request: ActorRequest,
    owner: &mut ActorDriverOwner<J, S>,
) {
    match request {
        ActorRequest::CreateActor {
            site_id,
            name,
            persona,
            reply,
        } => {
            let _ = reply.send(owner.create_actor(&site_id, name.as_deref(), persona.as_ref()));
        }
        ActorRequest::Ask {
            site_id,
            actor,
            instructions,
            reply,
        } => {
            let ticket = owner.ask(&site_id, &actor, &instructions);
            answer_with_ticket(owner, ticket, reply);
        }
        ActorRequest::WorldRead {
            site_id,
            op,
            args,
            reply,
        } => {
            let ticket = owner.world_read(&site_id, &op, args);
            answer_with_ticket(owner, ticket, reply);
        }
        ActorRequest::PublishArtifact {
            site_id,
            op,
            args,
            reply,
        } => {
            let ticket = owner.publish_artifact(&site_id, &op, &args);
            answer_with_ticket(owner, ticket, reply);
        }
        ActorRequest::Hole {
            site_id,
            name,
            prompt,
            reply,
        } => {
            let ticket = owner.hole(&site_id, &name, prompt.as_deref());
            answer_with_ticket(owner, ticket, reply);
        }
        ActorRequest::FillHole { fill, reply } => {
            let _ = reply.send(owner.fill_hole(fill));
        }
        ActorRequest::Complete { artifact, reply } => {
            let _ = reply.send(owner.complete(artifact));
        }
        ActorRequest::Fail { error, reply } => {
            let _ = reply.send(owner.fail(error));
        }
        ActorRequest::Drain { reply } => {
            let _ = reply.send(owner.drain());
        }
        ActorRequest::Log { message } => {
            if let Err(error) = owner.log(&message) {
                tracing::warn!("the owner failed to record a workflow log: {error:#}");
            }
        }
        ActorRequest::Report {
            site_id,
            item,
            artifact_id,
        } => {
            if let Err(error) = owner.report(&site_id, item, artifact_id.as_deref()) {
                tracing::warn!("the owner failed to record a workflow report: {error:#}");
            }
        }
        ActorRequest::EnterPhase { name } => {
            if let Err(error) = owner.enter_phase(&name) {
                tracing::warn!("the owner failed to enter a workflow phase: {error:#}");
            }
        }
        ActorRequest::Submit {
            session,
            payload,
            reply,
        } => {
            let _ = reply.send(owner.submit_result(&session, payload));
        }
        ActorRequest::TurnEnded {
            session,
            text,
            reply,
        } => {
            let _ = reply.send(owner.turn_ended(&session, &text));
        }
        ActorRequest::Escalate {
            session,
            request,
            reply,
        } => {
            let _ = reply.send(owner.escalate(&session, request));
        }
        ActorRequest::Answer { qid, answer, reply } => {
            let _ = reply.send(owner.answer(&qid, &answer));
        }
        ActorRequest::TurnFailed {
            session,
            failure,
            reply,
        } => {
            let _ = reply.send(owner.turn_failed(&session, &failure));
        }
        ActorRequest::RedriveDue { session, instance } => {
            if let Err(error) = owner.redrive_due(&session, &instance) {
                tracing::warn!(%session, error = %error, "a workflow redrive could not start its turn");
            }
        }
        ActorRequest::StallDue { generation } => {
            if let Err(error) = owner.stall_due(generation) {
                tracing::warn!("the owner failed to record a run stall: {error:#}");
            }
        }
        ActorRequest::MessageBoundary {
            instance,
            boundary,
            reply,
        } => {
            let _ = reply.send(owner.set_message_boundary(&instance, boundary));
        }
        ActorRequest::AskStats {
            instance,
            stats,
            reply,
        } => {
            let _ = reply.send(owner.ask_stats(&instance, stats));
        }
        ActorRequest::WorldSettled { instance, result } => {
            if let Err(error) = owner.world_settled(&instance, result) {
                tracing::warn!("the owner failed to settle a world read: {error:#}");
            }
        }
        ActorRequest::ArtifactSettled { instance, result } => {
            if let Err(error) = owner.artifact_settled(&instance, result) {
                tracing::warn!("the owner failed to settle an artifact publish: {error:#}");
            }
        }
        ActorRequest::ConcurrencyChanged { change } => {
            if let Err(error) = owner.concurrency_changed(&change) {
                tracing::warn!("the owner failed to journal a concurrency change: {error:#}");
            }
        }
        ActorRequest::Mutating { session, reply } => {
            let _ = reply.send(owner.ask_mutating(&session));
        }
        ActorRequest::Feed { session, event } => {
            if let Err(error) = owner.feed(&session, event) {
                tracing::warn!(%session, error = %error, "the owner failed to record an actor's observation");
            }
        }
        ActorRequest::StopInterrupted => {
            if let Err(error) = owner.stop_interrupted() {
                tracing::warn!("the owner failed to settle an interrupted run: {error:#}");
            }
        }
        ActorRequest::StopSuperseded { successor_run_id } => {
            if let Err(error) = owner.stop_superseded(&successor_run_id) {
                tracing::warn!("the owner failed to settle a superseded run: {error:#}");
            }
        }
    }
}

/// A ticketed call's reply: the owner's own error (outer), or the ticket's settlement (inner). The ticket is answered
/// when it settles; a stop or shutdown answers it with an error.
fn answer_with_ticket<J: JournalPort, S: ActorSessions>(
    owner: &mut ActorDriverOwner<J, S>,
    ticket: Result<u64>,
    reply: Sender<Result<TicketSettlement>>,
) {
    match ticket {
        Ok(ticket) => owner.await_ticket(ticket, reply),
        Err(error) => {
            let _ = reply.send(Err(error));
        }
    }
}

impl ActorHandle {
    fn call<T>(
        &self,
        build: impl FnOnce(Sender<Result<T>>) -> ActorRequest,
    ) -> Result<T, MailboxError> {
        let (reply, answer) = channel();
        self.tx
            .send(build(reply))
            .map_err(|_| MailboxError::NotDelivered)?;
        match answer.recv() {
            Ok(result) => result.map_err(MailboxError::Owner),
            Err(_) => Err(MailboxError::NoAnswer),
        }
    }

    /// The answers to parked questions, shared by every handle of this mailbox. A turn waits on its question here after
    /// the owner has parked it, and the owner's answer or withdrawal wakes the wait.
    pub fn parked(&self) -> Arc<ParkedAnswers> {
        self.parked.clone()
    }

    pub fn submit(&self, session: &str, payload: Value) -> Result<SubmitReply, MailboxError> {
        self.call(|reply| ActorRequest::Submit {
            session: session.to_owned(),
            payload,
            reply,
        })
    }

    pub fn turn_ended(&self, session: &str, text: &str) -> Result<TurnEndReply, MailboxError> {
        self.call(|reply| ActorRequest::TurnEnded {
            session: session.to_owned(),
            text: text.to_owned(),
            reply,
        })
    }

    pub fn escalate(
        &self,
        session: &str,
        request: EscalationRequest,
    ) -> Result<EscalateOutcome, MailboxError> {
        self.call(|reply| ActorRequest::Escalate {
            session: session.to_owned(),
            request,
            reply,
        })
    }

    pub fn answer(&self, qid: &str, answer: &str) -> Result<Option<AnswerOutcome>, MailboxError> {
        self.call(|reply| ActorRequest::Answer {
            qid: qid.to_owned(),
            answer: answer.to_owned(),
            reply,
        })
    }

    pub fn turn_failed(&self, session: &str, failure: &TurnFailure) -> Result<(), MailboxError> {
        self.call(|reply| ActorRequest::TurnFailed {
            session: session.to_owned(),
            failure: failure.clone(),
            reply,
        })
    }

    /// The message boundary of the ask instance the turn ran for. The owner writes it to that exact node.
    pub fn message_boundary(&self, instance: &Ref, boundary: u64) -> Result<(), MailboxError> {
        self.call(|reply| ActorRequest::MessageBoundary {
            instance: instance.clone(),
            boundary,
            reply,
        })
    }

    /// The session's ask is about to run a workspace-mutating call. The owner forwards the first one of the ask.
    pub fn mutating(&self, session: &str) -> Result<(), MailboxError> {
        self.call(|reply| ActorRequest::Mutating {
            session: session.to_owned(),
            reply,
        })
    }

    /// One observation of an actor's ask (W7-3). Posted without an answer: it is false only when the owner is gone.
    pub fn feed(&self, session: &str, event: FeedEvent) -> bool {
        self.post(ActorRequest::Feed {
            session: session.to_owned(),
            event,
        })
    }

    /// Asks the owner to settle its run as interrupted (W6b part 6). Posted without an answer.
    pub fn stop_interrupted(&self) -> bool {
        self.post(ActorRequest::StopInterrupted)
    }

    /// Asks the owner to settle its run as superseded by `successor_run_id` (9.43). Posted without an answer.
    pub fn stop_superseded(&self, successor_run_id: &str) -> bool {
        self.post(ActorRequest::StopSuperseded {
            successor_run_id: successor_run_id.to_owned(),
        })
    }

    /// The run service's fill of one hole (W7-12, 9.45): the engine's answer, after the fill's own step on the owner.
    pub fn fill_hole(
        &self,
        fill: crate::engine_holes::HoleFill,
    ) -> Result<crate::engine_holes::FillHoleResult, MailboxError> {
        self.call(|reply| ActorRequest::FillHole { fill, reply })
    }

    /// The child's `create-actor` (W7-5a-2): the engine's id for the new actor.
    pub fn create_actor(
        &self,
        site_id: &str,
        name: Option<&str>,
        persona: Option<&Value>,
    ) -> Result<String, MailboxError> {
        self.call(|reply| ActorRequest::CreateActor {
            site_id: site_id.to_owned(),
            name: name.map(str::to_owned),
            persona: persona.cloned(),
            reply,
        })
    }

    /// The child's `ask` (W7-5a-2). Blocks until the ask settles: `Ok` carries the ask's value, and an `Err` inside it
    /// is the ask's own error (a refusal, a failure, or the run's stop).
    pub fn ask(
        &self,
        site_id: &str,
        actor: &str,
        instructions: &str,
    ) -> Result<TicketSettlement, MailboxError> {
        self.call(|reply| ActorRequest::Ask {
            site_id: site_id.to_owned(),
            actor: actor.to_owned(),
            instructions: instructions.to_owned(),
            reply,
        })
    }

    /// The child's world read (W7-5a-2). Blocks until the worker settles the read.
    pub fn world_read(
        &self,
        site_id: &str,
        op: &str,
        args: Vec<Value>,
    ) -> Result<TicketSettlement, MailboxError> {
        self.call(|reply| ActorRequest::WorldRead {
            site_id: site_id.to_owned(),
            op: op.to_owned(),
            args,
            reply,
        })
    }

    /// The child's content artifact publish (W7-5a-2). Blocks until the publish settles.
    pub fn publish_artifact(
        &self,
        site_id: &str,
        op: &str,
        args: Vec<Value>,
    ) -> Result<TicketSettlement, MailboxError> {
        self.call(|reply| ActorRequest::PublishArtifact {
            site_id: site_id.to_owned(),
            op: op.to_owned(),
            args,
            reply,
        })
    }

    /// The child's `complete` (W7-5a-2): the script's end.
    pub fn complete(&self, artifact: Value) -> Result<(), MailboxError> {
        self.call(|reply| ActorRequest::Complete { artifact, reply })
    }

    /// The child's failed `complete` (W7-5a-3): the run fails with `error`.
    pub fn fail(&self, error: WorkflowError) -> Result<(), MailboxError> {
        self.call(|reply| ActorRequest::Fail { error, reply })
    }

    /// Posts a failure without waiting for the owner (W7-5a-3, review round 2). The request keeps its place in the
    /// owner's queue, so a request sent after it is served after it. False when the owner is gone.
    pub fn fail_posted(&self, error: WorkflowError) -> bool {
        let (reply, _) = channel();
        self.post(ActorRequest::Fail { error, reply })
    }

    /// Sends one ticketed child call without waiting for its settlement (W7-5a-3). The caller drains the owner after
    /// the send, which starts the turns the call queued, and then waits on the returned receiver with
    /// [`ActorHandle::await_ticketed`]. The send is ordered before any later request from this handle.
    pub fn send_ticketed(
        &self,
        call: TicketedCall,
    ) -> Result<Receiver<Result<TicketSettlement>>, MailboxError> {
        let (reply, answer) = channel();
        let request = match call {
            TicketedCall::Ask {
                site_id,
                actor,
                instructions,
            } => ActorRequest::Ask {
                site_id,
                actor,
                instructions,
                reply,
            },
            TicketedCall::WorldRead { site_id, op, args } => ActorRequest::WorldRead {
                site_id,
                op,
                args,
                reply,
            },
            TicketedCall::PublishArtifact { site_id, op, args } => ActorRequest::PublishArtifact {
                site_id,
                op,
                args,
                reply,
            },
            TicketedCall::Hole {
                site_id,
                name,
                prompt,
            } => ActorRequest::Hole {
                site_id,
                name,
                prompt,
                reply,
            },
        };
        self.tx
            .send(request)
            .map_err(|_| MailboxError::NotDelivered)?;
        Ok(answer)
    }

    /// Waits for a ticketed call's settlement (W7-5a-3). `Ok` carries the settlement, whose `Err` is the call's own error.
    pub fn await_ticketed(
        answer: Receiver<Result<TicketSettlement>>,
    ) -> Result<TicketSettlement, MailboxError> {
        match answer.recv() {
            Ok(result) => result.map_err(MailboxError::Owner),
            Err(_) => Err(MailboxError::NoAnswer),
        }
    }

    /// The host's drain after a slice of child calls (W7-5a-2): starts the turns the calls queued.
    pub fn drain(&self) -> Result<(), MailboxError> {
        self.call(|reply| ActorRequest::Drain { reply })
    }

    /// The child's `log` event (W7-5a-2). Posted without an answer: false only when the owner is gone.
    pub fn log(&self, message: &str) -> bool {
        self.post(ActorRequest::Log {
            message: message.to_owned(),
        })
    }

    /// The child's `report` event (W7-5a-2). Posted without an answer.
    pub fn report(&self, site_id: &str, item: Value, artifact_id: Option<&str>) -> bool {
        self.post(ActorRequest::Report {
            site_id: site_id.to_owned(),
            item,
            artifact_id: artifact_id.map(str::to_owned),
        })
    }

    /// The child's `phase-entered` event (W7-5a-2). Posted without an answer.
    pub fn enter_phase(&self, name: &str) -> bool {
        self.post(ActorRequest::EnterPhase {
            name: name.to_owned(),
        })
    }

    /// One turn's ask stats, before the turn's end. The owner writes them to the ask's node.
    pub fn ask_stats(
        &self,
        instance: &Ref,
        stats: crate::engine::AskStats,
    ) -> Result<(), MailboxError> {
        self.call(|reply| ActorRequest::AskStats {
            instance: instance.clone(),
            stats,
            reply,
        })
    }
}

/// A run's `LiveRun` over its owner's mailbox (W7-3). The residency ledger calls `stop_interrupted` from any thread; the
/// stop is posted, and the owner's thread settles the run, which then releases the guard the close waits on.
#[derive(Clone)]
pub struct MailboxRun {
    handle: ActorHandle,
}

impl MailboxRun {
    pub fn new(handle: ActorHandle) -> Self {
        Self { handle }
    }
}

impl LiveRun for MailboxRun {
    fn stop_interrupted(&self) {
        // A post fails only when the owner is gone, and then there is no run left to stop.
        let _ = self.handle.stop_interrupted();
    }
}
