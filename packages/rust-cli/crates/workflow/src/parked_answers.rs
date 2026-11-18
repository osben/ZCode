//! The answers to parked questions: the store behind the blocked escalate call (Node `respondToParkedEscalation` resolves
//! the deferred the escalate waits on). The owner delivers an answer or withdraws a question on its own thread, and the
//! turn's thread waits for its question. A delivery that comes before its wait is kept, so the order of the two does not
//! matter: the escalate reply is sent before the owner can serve the answer, but the turn may not be waiting yet.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};

/// What a waiting question receives: its answer, or the reason it was withdrawn.
enum Slot {
    Answer(String),
    Withdrawn(String),
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

    /// The answer to a parked question. Wakes its waiter, or waits for it if it is not waiting yet.
    pub fn deliver(&self, qid: &str, answer: &str) {
        self.put(qid, Slot::Answer(answer.to_owned()));
    }

    /// A parked question that the owner withdrew, with the reason its waiter gets.
    pub fn reject(&self, qid: &str, reason: &str) {
        self.put(qid, Slot::Withdrawn(reason.to_owned()));
    }

    /// Blocks until the question is answered (`Ok`) or withdrawn (`Err`), then takes its slot.
    pub fn wait(&self, qid: &str) -> Result<String, String> {
        let mut slots = self.lock();
        loop {
            if let Some(slot) = slots.remove(qid) {
                return match slot {
                    Slot::Answer(answer) => Ok(answer),
                    Slot::Withdrawn(reason) => Err(reason),
                };
            }
            slots = self
                .arrived
                .wait(slots)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    fn put(&self, qid: &str, slot: Slot) {
        self.lock().insert(qid.to_owned(), slot);
        self.arrived.notify_all();
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Slot>> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
