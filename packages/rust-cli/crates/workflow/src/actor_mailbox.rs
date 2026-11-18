//! The mailbox between the actor turns and the owner (W6a part 2c-1; spec section 9.8c).
//!
//! Turns run on their own threads and send requests here: a submit, a turn end, an escalate, or an answer. Each request
//! carries its own reply channel, and the sending turn blocks on it. The owner thread is the only one that serves the
//! mailbox, so the owner stays single-threaded. The mailbox holds no state of its own beyond the channel.
//!
//! Errors cross the channel as text: an `anyhow::Error` is not cloneable, and a turn needs only its message.
use crate::driver_owner::{ActorDriverOwner, ActorSessions, SubmitReply, TurnEndReply};
use crate::escalation::{AnswerOutcome, EscalateOutcome, EscalationRequest};
use crate::journal::JournalPort;
use anyhow::{Result, anyhow};
use serde_json::Value;
use std::sync::mpsc::{Receiver, Sender, channel};

const CLOSED: &str = "the actor mailbox is closed; the owner no longer serves it";

/// One request from a turn to the owner.
pub enum ActorRequest {
    Submit {
        session: String,
        payload: Value,
        reply: Sender<Result<SubmitReply, String>>,
    },
    TurnEnded {
        session: String,
        text: String,
        reply: Sender<Result<TurnEndReply, String>>,
    },
    Escalate {
        session: String,
        request: EscalationRequest,
        reply: Sender<Result<EscalateOutcome, String>>,
    },
    Answer {
        qid: String,
        answer: String,
        reply: Sender<Result<Option<AnswerOutcome>, String>>,
    },
}

/// The owner's side of the channel. Only the owner thread calls `serve_next`.
pub struct ActorMailbox {
    tx: Sender<ActorRequest>,
    rx: Receiver<ActorRequest>,
}

/// A turn's side of the channel. Cheap to clone; one per turn or per main-agent caller.
#[derive(Clone)]
pub struct ActorHandle {
    tx: Sender<ActorRequest>,
}

impl Default for ActorMailbox {
    fn default() -> Self {
        Self::new()
    }
}

impl ActorMailbox {
    pub fn new() -> Self {
        let (tx, rx) = channel();
        Self { tx, rx }
    }

    pub fn handle(&self) -> ActorHandle {
        ActorHandle {
            tx: self.tx.clone(),
        }
    }

    /// Wait for one request and answer it on the owner. The reply goes back on the request's own channel; a turn that
    /// has gone away is not an error for the owner. The owner's error is sent to that turn as text.
    pub fn serve_next<J: JournalPort, S: ActorSessions>(
        &self,
        owner: &mut ActorDriverOwner<J, S>,
    ) -> Result<()> {
        let request = self.rx.recv().map_err(|_| anyhow!(CLOSED))?;
        match request {
            ActorRequest::Submit {
                session,
                payload,
                reply,
            } => {
                let _ = reply.send(owner.submit_result(&session, payload).map_err(text));
            }
            ActorRequest::TurnEnded {
                session,
                text: final_text,
                reply,
            } => {
                let _ = reply.send(owner.turn_ended(&session, &final_text).map_err(text));
            }
            ActorRequest::Escalate {
                session,
                request,
                reply,
            } => {
                let _ = reply.send(owner.escalate(&session, request).map_err(text));
            }
            ActorRequest::Answer { qid, answer, reply } => {
                let _ = reply.send(owner.answer(&qid, &answer).map_err(text));
            }
        }
        Ok(())
    }
}

fn text(error: anyhow::Error) -> String {
    format!("{error:#}")
}

impl ActorHandle {
    fn call<T>(
        &self,
        request: impl FnOnce(Sender<Result<T, String>>) -> ActorRequest,
    ) -> Result<T, String> {
        let (reply, answer) = channel();
        self.tx
            .send(request(reply))
            .map_err(|_| CLOSED.to_owned())?;
        answer.recv().map_err(|_| CLOSED.to_owned())?
    }

    pub fn submit(&self, session: &str, payload: Value) -> Result<SubmitReply, String> {
        self.call(|reply| ActorRequest::Submit {
            session: session.to_owned(),
            payload,
            reply,
        })
    }

    pub fn turn_ended(&self, session: &str, text: &str) -> Result<TurnEndReply, String> {
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
    ) -> Result<EscalateOutcome, String> {
        self.call(|reply| ActorRequest::Escalate {
            session: session.to_owned(),
            request,
            reply,
        })
    }

    pub fn answer(&self, qid: &str, answer: &str) -> Result<Option<AnswerOutcome>, String> {
        self.call(|reply| ActorRequest::Answer {
            qid: qid.to_owned(),
            answer: answer.to_owned(),
            reply,
        })
    }
}
