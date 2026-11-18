//! The escalation book of the actor driver (W6a): Node `workflow-driver-escalation.ts` with the counters of
//! `workflow-driver-helpers.ts` and `workflow-driver-types.ts`.
//!
//! An actor's `escalate` call parks a question and blocks its turn until the main agent answers. The book
//! holds the parked questions (by question id), the per-ask budget and the registry of question ids in use.
//! It owns no clock and no journal: the driver passes the write in as a closure, and reads `askedAt` once.
//!
//! Two rules of Node are kept as they are. A raise whose write fails is revoked and its error is returned,
//! since nobody could see the question and the actor would block forever. An answer whose resolved write fails
//! is still delivered, with a warning, since the actor is already waiting for it.
use crate::driver_rules::{
    ESCALATION_BUDGET_EXHAUSTED, MAX_ESCALATIONS_PER_ASK, effective_actor_name,
    normalize_escalation_context, question_id_fragments,
};
use crate::event::RunEvent;
use crate::model::Ref;
use anyhow::{Result, anyhow};
use std::collections::{BTreeMap, BTreeSet};

/// What `escalate` needs from the actor: who asks, the question, the optional context, and the clock read.
#[derive(Debug, Clone, PartialEq)]
pub struct EscalationRequest {
    pub actor: Ref,
    /// The persona's effective name (`effectiveActorName`); `None` for an anonymous actor.
    pub actor_name: Option<String>,
    pub question: String,
    pub context: Option<String>,
    /// Epoch milliseconds, read once by the caller.
    pub asked_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalReason {
    /// No ask is in flight for the session, so nobody would answer.
    NoActiveAsk,
    /// The per-ask budget is spent.
    BudgetExhausted,
}

impl RefusalReason {
    /// Node's `reason` string on the refused outcome.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoActiveAsk => "no_active_ask",
            Self::BudgetExhausted => "budget_exhausted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EscalateOutcome {
    /// The question is parked under `qid`. The actor waits until `answer` or `withdraw` releases it.
    Parked { qid: String },
    /// An ordinary result the model reads, not an error. Nothing was parked.
    Refused {
        reason: RefusalReason,
        message: String,
    },
}

/// Node `escalate` refusal text when no ask is in flight (`workflow-driver-escalation.ts`).
pub const NO_ESCALATION_ASK_MESSAGE: &str = "No ask is in flight, so there is nowhere to park this question and nobody would answer it. Escalate only while working on an ask.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnswerOutcome {
    pub answer: String,
    /// Set when the `escalation-resolved` write failed. The answer is still delivered.
    pub journal_warning: Option<String>,
    /// Set by the owner when the accepted answer could not be delivered to the blocked turn (its send failed). The
    /// question is retired either way: the answer cannot be given again.
    pub delivery_warning: Option<String>,
}

#[derive(Debug, Default)]
struct SessionEscalations {
    ask_active: bool,
    used: u32,
    /// Parked question ids in the order they were raised (Node's `pendingEscalations` map order).
    pending: Vec<String>,
}

/// The question id registry and the parked questions of one run's actor driver.
#[derive(Debug)]
pub struct EscalationBook {
    run_id: String,
    next_seq: u64,
    taken: BTreeSet<String>,
    sessions: BTreeMap<String, SessionEscalations>,
    by_qid: BTreeMap<String, String>,
}

impl EscalationBook {
    pub fn new(run_id: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            next_seq: 0,
            taken: BTreeSet::new(),
            sessions: BTreeMap::new(),
            by_qid: BTreeMap::new(),
        }
    }

    /// Node `startAsk`: withdraw what the previous ask left parked, reset the budget, and mark the ask active.
    /// Returns the withdrawn question ids (the driver rejects their deferreds).
    pub fn start_ask(&mut self, session: &str) -> Vec<String> {
        let withdrawn = self.withdraw(session);
        let state = self.sessions.entry(session.to_owned()).or_default();
        state.used = 0;
        state.ask_active = true;
        withdrawn
    }

    /// Node `cancelAsk`, a turn that rejected, and the start of the next ask: withdraw the session's parked
    /// questions. The ask is no longer active, so a later `escalate` is refused. Returns the withdrawn ids.
    pub fn end_ask(&mut self, session: &str) -> Vec<String> {
        let withdrawn = self.withdraw(session);
        if let Some(state) = self.sessions.get_mut(session) {
            state.ask_active = false;
        }
        withdrawn
    }

    /// The session's parked question ids, in raise order.
    pub fn pending_questions(&self, session: &str) -> Vec<String> {
        self.sessions
            .get(session)
            .map(|state| state.pending.clone())
            .unwrap_or_default()
    }

    /// Node `makeSessionEscalatePort`. Refusals are returned, never thrown: an exception would look like a
    /// retryable failure and the model would spin on it. The raise is written before the question is treated as
    /// parked. A failed write revokes the park and returns the error, and the budget stays spent (as in Node).
    pub fn escalate(
        &mut self,
        session: &str,
        request: EscalationRequest,
        mut write: impl FnMut(&RunEvent) -> Result<()>,
    ) -> Result<EscalateOutcome> {
        let state = self.sessions.entry(session.to_owned()).or_default();
        if !state.ask_active {
            return Ok(EscalateOutcome::Refused {
                reason: RefusalReason::NoActiveAsk,
                message: NO_ESCALATION_ASK_MESSAGE.to_owned(),
            });
        }
        if state.used >= MAX_ESCALATIONS_PER_ASK {
            return Ok(EscalateOutcome::Refused {
                reason: RefusalReason::BudgetExhausted,
                message: ESCALATION_BUDGET_EXHAUSTED.to_owned(),
            });
        }
        state.used += 1;

        let seq = self.next_seq;
        self.next_seq += 1;
        let qid = mint_question_id(&self.run_id, seq, &self.taken)?;
        self.taken.insert(qid.clone());
        self.by_qid.insert(qid.clone(), session.to_owned());
        if let Some(state) = self.sessions.get_mut(session) {
            state.pending.push(qid.clone());
        }

        let actor_name = effective_actor_name(request.actor_name.as_deref()).map(str::to_owned);
        let context = normalize_escalation_context(request.context.as_deref());
        let event = RunEvent::EscalationRaised {
            qid: qid.clone(),
            actor: request.actor,
            actor_name,
            question: request.question,
            context,
            asked_at: request.asked_at,
        };
        if let Err(error) = write(&event) {
            self.release(session, &qid);
            return Err(error);
        }
        Ok(EscalateOutcome::Parked { qid })
    }

    /// Node `respondToParkedEscalation`: retire the question, write `escalation-resolved`, and deliver the answer.
    /// `None` when no driver holds the question (wrong session, or already withdrawn).
    pub fn answer(
        &mut self,
        qid: &str,
        answer: &str,
        mut write: impl FnMut(&RunEvent) -> Result<()>,
    ) -> Option<AnswerOutcome> {
        let session = self.by_qid.get(qid).cloned()?;
        self.release(&session, qid);
        let event = RunEvent::EscalationResolved {
            qid: qid.to_owned(),
            answer: answer.to_owned(),
        };
        let journal_warning = write(&event).err().map(|error| error.to_string());
        Some(AnswerOutcome {
            answer: answer.to_owned(),
            journal_warning,
            delivery_warning: None,
        })
    }

    /// The session a parked question belongs to, while it is parked.
    pub fn session_of_question(&self, qid: &str) -> Option<String> {
        self.by_qid.get(qid).cloned()
    }

    /// Withdraw every parked question of a session and retire its ids (Node `withdrawSessionEscalations`).
    fn withdraw(&mut self, session: &str) -> Vec<String> {
        let Some(state) = self.sessions.get_mut(session) else {
            return Vec::new();
        };
        let withdrawn = std::mem::take(&mut state.pending);
        for qid in &withdrawn {
            self.by_qid.remove(qid);
            self.taken.remove(qid);
        }
        withdrawn
    }

    /// Remove one parked question from the session and from both registries.
    fn release(&mut self, session: &str, qid: &str) {
        self.by_qid.remove(qid);
        self.taken.remove(qid);
        if let Some(state) = self.sessions.get_mut(session) {
            state.pending.retain(|pending| pending != qid);
        }
    }
}

/// Node `mintEscalationQuestionId`: `dwfq-<fragment>-<seq>`, with the first fragment that is not taken.
/// The last fragment is the whole run segment, so the loop ends with a free id unless two drivers share a run id.
pub fn mint_question_id(run_id: &str, seq: u64, taken: &BTreeSet<String>) -> Result<String> {
    for fragment in question_id_fragments(run_id) {
        let candidate = format!("dwfq-{fragment}-{seq}");
        if !taken.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(anyhow!(
        "Cannot mint a free escalation question id for run {run_id} (seq={seq}): every candidate is already taken in the registry. Two drivers may be sharing one runId."
    ))
}
