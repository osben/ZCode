//! The answers to parked questions: the store behind the blocked escalate call (Node `respondToParkedEscalation` resolves
//! the deferred the escalate waits on). The owner delivers an answer or withdraws a question on its own thread, and the
//! turn's thread waits for its question. A delivery that comes before its wait is kept, so the order of the two does not
//! matter: the escalate reply is sent before the owner can serve the answer, but the turn may not be waiting yet.
//!
//! A slot is tagged with its session, so a session's slots can be dropped when its turn is cancelled. A slot nobody waits for
//! is the only kind that can be dropped, because a waiter takes its slot when it wakes.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};

/// What a waiting question receives: its answer, or the reason it was withdrawn.
enum Outcome {
    Answer(String),
    Withdrawn(String),
}

struct Slot {
    session: String,
    outcome: Outcome,
}

#[derive(Default)]
pub struct ParkedAnswers {
    slots: Mutex<HashMap<String, Slot>>,
    arrived: Condvar,
}

impl ParkedAnswers {
    pub fn new() -> Self {
        Self::default()
    }

    /// The answer to a parked question of `session`. Wakes its waiter, or waits for it if it is not waiting yet.
    pub fn deliver(&self, session: &str, qid: &str, answer: &str) {
        self.put(session, qid, Outcome::Answer(answer.to_owned()));
    }

    /// A parked question of `session` that the owner withdrew, with the reason its waiter gets.
    pub fn reject(&self, session: &str, qid: &str, reason: &str) {
        self.put(session, qid, Outcome::Withdrawn(reason.to_owned()));
    }

    /// Blocks until the question is answered (`Ok`) or withdrawn (`Err`), then takes its slot.
    pub fn wait(&self, qid: &str) -> Result<String, String> {
        let mut slots = self.lock();
        loop {
            if let Some(slot) = slots.remove(qid) {
                return match slot.outcome {
                    Outcome::Answer(answer) => Ok(answer),
                    Outcome::Withdrawn(reason) => Err(reason),
                };
            }
            slots = self
                .arrived
                .wait(slots)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Drops the slots of `session` that nobody took, and returns how many. Waiters are not woken: a session's waiter is
    /// the turn that ended, and it has nothing left to wait for.
    pub fn discard_session(&self, session: &str) -> usize {
        let mut slots = self.lock();
        let before = slots.len();
        slots.retain(|_, slot| slot.session != session);
        before - slots.len()
    }

    /// How many slots are waiting to be taken.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// Whether no slot is waiting to be taken.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn put(&self, session: &str, qid: &str, outcome: Outcome) {
        self.lock().insert(
            qid.to_owned(),
            Slot {
                session: session.to_owned(),
                outcome,
            },
        );
        self.arrived.notify_all();
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Slot>> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
