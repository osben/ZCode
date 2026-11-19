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
use crate::driver_owner::{ActorDriverOwner, ActorSessions, SubmitReply, TurnEndReply};
use crate::escalation::{AnswerOutcome, EscalateOutcome, EscalationRequest};
use crate::journal::JournalPort;
use crate::model::{ConcurrencyChange, Ref};
use crate::parked_answers::ParkedAnswers;
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
    /// A turn threw (not cancelled): the owner fails the ask (Node `askFailed`).
    TurnFailed {
        session: String,
        message: String,
        reply: Sender<Result<()>>,
    },
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
}

impl ActorHandle {
    /// Post a request without waiting for an answer. False when the owner is gone.
    pub(crate) fn post(&self, request: ActorRequest) -> bool {
        self.tx.send(request).is_ok()
    }
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
    match request {
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
            message,
            reply,
        } => {
            let _ = reply.send(owner.turn_failed(&session, &message));
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

    pub fn turn_failed(&self, session: &str, message: &str) -> Result<(), MailboxError> {
        self.call(|reply| ActorRequest::TurnFailed {
            session: session.to_owned(),
            message: message.to_owned(),
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
