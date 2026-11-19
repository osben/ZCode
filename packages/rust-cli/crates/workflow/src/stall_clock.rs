//! The run-level stall clock (W6b part 5; Node `createRunStallClock` in `workflow-driver-concurrency.ts`).
//!
//! One clock per run, shared by every actor. Any successful model request resets it. A scheduled retry arms it; when
//! [`WORKFLOW_STALL_NOTIFY_AFTER_MS`] pass after the last success while a retry is armed, it reports once per stall
//! period, as a `run-stalled` event. It observes and never decides: the run keeps going.
//!
//! Time and timers come from the redrive clock ([`RedriveClock`]), so tests are exact. A timer cannot be cancelled
//! through that port, so each arming takes a generation: a job runs its fire only when its generation is still the
//! armed one. A stale job wakes, posts, and is ignored.

use crate::model_failure::RedriveClock;
use std::sync::{Arc, Mutex};

/// Node `WORKFLOW_STALL_NOTIFY_AFTER_MS`: twenty minutes without a successful request while a retry is armed.
pub const WORKFLOW_STALL_NOTIFY_AFTER_MS: u64 = 20 * 60_000;

/// What a `run-stalled` event carries (Node `RunStallInfo`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunStallInfo {
    pub since_ms: u64,
    pub reason: Option<String>,
    pub cap: Option<u64>,
}

/// Called with a generation when a timer's job runs. The owner posts it to its own thread, where it calls `fire`.
pub type OnDue = Arc<dyn Fn(u64) + Send + Sync>;

pub struct RunStallClock {
    inner: Arc<Inner>,
}

struct Inner {
    clock: Arc<dyn RedriveClock>,
    after_ms: u64,
    on_due: OnDue,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    last_success_at: u64,
    /// Set once a notice fired in this stall period; cleared by a success.
    notified: bool,
    /// The generation of the armed timer, if one is armed.
    armed: Option<u64>,
    generation: u64,
    cap: Option<u64>,
    /// Retry reasons seen in this period, in first-seen order (the dominant reason breaks ties by it).
    reasons: Vec<(String, u64)>,
    disposed: bool,
}

impl RunStallClock {
    pub fn new(clock: Arc<dyn RedriveClock>, on_due: OnDue) -> Self {
        Self::with_after(clock, on_due, WORKFLOW_STALL_NOTIFY_AFTER_MS)
    }

    pub fn with_after(clock: Arc<dyn RedriveClock>, on_due: OnDue, after_ms: u64) -> Self {
        let last_success_at = clock.now_ms();
        Self {
            inner: Arc::new(Inner {
                clock,
                after_ms,
                on_due,
                state: Mutex::new(State {
                    last_success_at,
                    ..State::default()
                }),
            }),
        }
    }

    /// Node `noteSuccess`: a model request succeeded. Resets the clock and cancels the armed timer.
    pub fn note_success(&self) {
        let mut state = self.lock();
        if state.disposed {
            return;
        }
        state.last_success_at = self.inner.clock.now_ms();
        state.notified = false;
        state.reasons.clear();
        // Cancel: the armed generation is forgotten, so its job wakes to a stale generation and does nothing.
        state.armed = None;
        state.generation += 1;
    }

    /// Node `noteRetryScheduled`: a retry with this reason is scheduled. Arms the timer when none is armed.
    pub fn note_retry_scheduled(&self, reason: &str) {
        let (generation, delay_ms) = {
            let mut state = self.lock();
            if state.disposed || state.notified {
                return;
            }
            match state.reasons.iter_mut().find(|(seen, _)| seen == reason) {
                Some((_, count)) => *count += 1,
                None => state.reasons.push((reason.to_owned(), 1)),
            }
            if state.armed.is_some() {
                return;
            }
            state.generation += 1;
            state.armed = Some(state.generation);
            (state.generation, self.delay_until_window(&state))
        };
        // The clock is called without the lock: a clock that runs its job at once must not find the lock held.
        self.arm(generation, delay_ms);
    }

    /// Node `noteCap`: the cap the run last fanned out. Carried in the notice when it has been seen.
    pub fn note_cap(&self, cap: u64) {
        self.lock().cap = Some(cap);
    }

    /// Node's timer callback, run by the owner for the generation the job posted. Returns the notice to record, if
    /// this generation is the armed one and the stall is real. A timer that wakes early re-arms for the rest.
    pub fn fire(&self, generation: u64) -> Option<RunStallInfo> {
        let rearm = {
            let mut state = self.lock();
            if state.disposed || state.armed != Some(generation) {
                return None;
            }
            state.armed = None;
            if state.notified {
                return None;
            }
            let now = self.inner.clock.now_ms();
            let since_ms = now.saturating_sub(state.last_success_at);
            if since_ms < self.inner.after_ms {
                // Woken early (a clock that is not monotonic): wait for the rest of the window.
                state.generation += 1;
                state.armed = Some(state.generation);
                Some((state.generation, self.inner.after_ms - since_ms))
            } else {
                if state.reasons.is_empty() {
                    return None;
                }
                state.notified = true;
                let info = RunStallInfo {
                    since_ms,
                    reason: dominant_reason(&state.reasons),
                    cap: state.cap,
                };
                return Some(info);
            }
        };
        if let Some((generation, delay)) = rearm {
            self.arm(generation, delay);
        }
        None
    }

    /// Node `dispose`: the run settled. Cancels the armed timer; nothing fires afterwards.
    pub fn dispose(&self) {
        let mut state = self.lock();
        state.disposed = true;
        state.armed = None;
        state.generation += 1;
    }

    /// The generation of the armed timer, for tests that wake it by hand.
    #[cfg(test)]
    pub(crate) fn armed_for_test(&self) -> Option<u64> {
        self.lock().armed
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // A panic inside a timer job must not wedge the clock: the state is plain data, so the poisoned guard is used.
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The delay until the window closes, measured from the last success.
    fn delay_until_window(&self, state: &State) -> u64 {
        let elapsed = self
            .inner
            .clock
            .now_ms()
            .saturating_sub(state.last_success_at);
        self.inner.after_ms.saturating_sub(elapsed)
    }

    /// Schedules the job for `generation`. A refused job leaves nothing armed, so a later retry arms again. Node's
    /// `setTimeout` cannot refuse; the Rust clock can, and the stall is then not observed until the next retry.
    fn arm(&self, generation: u64, delay_ms: u64) {
        let on_due = self.inner.on_due.clone();
        let scheduled = self
            .inner
            .clock
            .after(delay_ms, Box::new(move || on_due(generation)));
        if !scheduled {
            tracing::warn!("the run stall clock could not schedule its timer");
            let mut state = self.lock();
            if state.armed == Some(generation) {
                state.armed = None;
            }
        }
    }
}

/// Node's dominant reason: the most frequent one; on a tie, the one seen first (Node's `Map` order, with a strict `>`).
fn dominant_reason(reasons: &[(String, u64)]) -> Option<String> {
    let mut best: Option<&(String, u64)> = None;
    for entry in reasons {
        if best.is_none_or(|current| entry.1 > current.1) {
            best = Some(entry);
        }
    }
    best.map(|(reason, _)| reason.clone())
}
