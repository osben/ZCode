//! The answers to parked questions: the store behind the blocked escalate call (Node `respondToParkedEscalation` resolves
//! the deferred the escalate waits on). The owner delivers an answer or withdraws a question on its own thread, and the
//! turn's thread waits for its question. A delivery that comes before its wait is kept, so the order of the two does not
//! matter: the escalate reply is sent before the owner can serve the answer, but the turn may not be waiting yet.
//!
//! A turn that is blocked in escalate has not ended, so its wait is registered (`wait`) before the first check, under the
//! same lock as the slots. A session's cancel (`discard_session`) withdraws every question its turn is waiting on, and
//! drops the slots nobody waits for. Every state change wakes all waiters.

use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

/// The reason a cancelled turn's waiting question is withdrawn with.
const CANCELLED: &str = "the ask was cancelled";

/// How often a waiter checks its cancel check when nothing has arrived. The cancel check is the backstop for a cancel that
/// reaches the turn before its wait registers; the discard covers every wait that is already registered.
const CANCEL_POLL: Duration = Duration::from_millis(20);

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
struct State {
    slots: HashMap<String, Slot>,
    /// The questions a turn is blocked on, by id, with the session whose turn waits.
    waiting: HashMap<String, String>,
}

#[derive(Default)]
pub struct ParkedAnswers {
    state: Mutex<State>,
    changed: Condvar,
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
    pub fn wait(&self, session: &str, qid: &str) -> Result<String, String> {
        self.wait_until(session, qid, &|| false)
    }

    /// As `wait`, and also gives up with the cancel reason when `cancelled` reports true while nothing has arrived for the
    /// question. An answer that is already there is taken first. `cancelled` runs under this store's lock, on every check:
    /// it must be cheap and non-blocking and must not call back into this store, or every waiter of the run stalls.
    pub fn wait_until(
        &self,
        session: &str,
        qid: &str,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<String, String> {
        let mut state = self.lock();
        // Registered before the first check: a discard after this point finds the wait and withdraws it.
        state.waiting.insert(qid.to_owned(), session.to_owned());
        loop {
            if let Some(slot) = state.slots.remove(qid) {
                state.waiting.remove(qid);
                return match slot.outcome {
                    Outcome::Answer(answer) => Ok(answer),
                    Outcome::Withdrawn(reason) => Err(reason),
                };
            }
            if cancelled() {
                state.waiting.remove(qid);
                return Err(CANCELLED.to_owned());
            }
            let (next, _) = self
                .changed
                .wait_timeout(state, CANCEL_POLL)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
        }
    }

    /// The cancel of `session`'s turn. Every question the turn is blocked on is withdrawn: its waiter wakes with the cancel
    /// reason, unless an answer is already there, which the waiter takes. The slots nobody waits for are dropped, and their
    /// number is returned. Other sessions are untouched.
    pub fn discard_session(&self, session: &str) -> usize {
        let mut state = self.lock();
        let waited: Vec<String> = state
            .waiting
            .iter()
            .filter(|(_, waiting_session)| waiting_session.as_str() == session)
            .map(|(qid, _)| qid.clone())
            .collect();
        let before = state.slots.len();
        state
            .slots
            .retain(|qid, slot| slot.session != session || waited.contains(qid));
        let dropped = before - state.slots.len();
        for qid in waited {
            state.slots.entry(qid).or_insert_with(|| Slot {
                session: session.to_owned(),
                outcome: Outcome::Withdrawn(CANCELLED.to_owned()),
            });
        }
        self.changed.notify_all();
        dropped
    }

    /// How many slots are waiting to be taken.
    pub fn len(&self) -> usize {
        self.lock().slots.len()
    }

    /// Whether no slot is waiting to be taken.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// How many waits are registered: a turn blocked on a question.
    #[cfg(test)]
    pub fn waiters(&self) -> usize {
        self.lock().waiting.len()
    }

    fn put(&self, session: &str, qid: &str, outcome: Outcome) {
        self.lock().slots.insert(
            qid.to_owned(),
            Slot {
                session: session.to_owned(),
                outcome,
            },
        );
        self.changed.notify_all();
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
