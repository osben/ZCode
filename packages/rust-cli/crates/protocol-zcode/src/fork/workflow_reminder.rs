//! Fork: the blocked-run reminder clock (specs/fork-rust-workflow-engine.md, 9.38, W7-7c; Node
//! `runtime-task/workflow-blocked-reminder.ts` and `runtime/methods/dynamic-workflow-blocked-reminder.ts`).
//!
//! A question or hole that a run is still waiting on is announced once when it is raised. If nothing answers it, the
//! idle main agent is reminded: the clock measures how long the session has been idle (not how long the decision has
//! been open), sends at most two reminders per run, and counts a reminder when it is sent. The clock is a state machine
//! over a host: the host holds the time, the timers, the live runs, the open decisions and the send. Only the state
//! machine is built here; the host that the composition would give it (the session's idle edges, a timer, the run
//! snapshot read) is not wired yet (divergence 357 of 9.38).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

pub const MINUTE_MS: u64 = 60_000;

/// Node `WORKFLOW_BLOCKED_REMINDER_DELAYS_MS`: the first reminder after 15 idle minutes, the second 30 minutes after the
/// idle start. The index is the number of reminders the run already has.
pub const REMINDER_DELAYS_MS: [u64; 2] = [15 * MINUTE_MS, 30 * MINUTE_MS];

/// A question a run is parked on (Node `DynamicWorkflowRunPendingQuestion`, the fields a reminder reads).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenQuestion {
    pub qid: String,
    pub subagent: String,
    pub question: String,
    pub context: Option<String>,
    /// Epoch milliseconds when it was asked.
    pub asked_at: Option<u64>,
}

/// A waiting hole of a run (Node `DynamicWorkflowRunHole` in state `waiting`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenHole {
    pub site_id: String,
    pub name: String,
    pub type_name: String,
    pub line: Option<u64>,
    /// Epoch milliseconds when it was reached.
    pub since: Option<u64>,
}

/// What a run still owes a decision on, as read at the moment of the reminder.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OpenDecisions {
    pub questions: Vec<OpenQuestion>,
    pub holes: Vec<OpenHole>,
    pub draft_path: Option<String>,
}

impl OpenDecisions {
    fn is_empty(&self) -> bool {
        self.questions.is_empty() && self.holes.is_empty()
    }
}

/// One reminder to send. `ordinal` starts at 1; `total` is the most reminders a run gets; `now` is the send time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reminder {
    pub run_id: String,
    pub open: OpenDecisions,
    pub ordinal: usize,
    pub total: usize,
    pub now: u64,
}

/// The clock's side of the world. `schedule` returns a cancel. `remind` is called without the clock's lock held, so it
/// may call back into the clock (a turn that starts when a reminder is sent calls `session_busy`).
pub trait ReminderHost: Send + Sync {
    /// The live workflow runs of the session, read at each use.
    fn live_run_ids(&self) -> Vec<String>;
    /// Whether the session has no turn running or queued.
    fn is_idle(&self) -> bool;
    /// The open decisions of one run now, or `None` when it has none.
    fn read_open(&self, run_id: &str) -> Option<OpenDecisions>;
    fn remind(&self, reminder: Reminder);
    fn now_ms(&self) -> u64;
    /// Runs `fire` after `delay_ms` and returns the cancel of that timer.
    fn schedule(&self, delay_ms: u64, fire: Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send>;
}

type Cancel = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct State {
    /// Reminders sent so far per run. The only state the clock keeps across idle periods.
    sent: HashMap<String, usize>,
    /// The start of the current idle period; `None` when the session is busy or has never been idle.
    idle_since: Option<u64>,
    cancel: Option<Cancel>,
    /// Bumped on every disarm and re-arm; a timer that fires with an older epoch does nothing.
    epoch: u64,
    stopped: bool,
}

pub struct BlockedReminderClock {
    host: Arc<dyn ReminderHost>,
    delays: Vec<u64>,
    me: Weak<Self>,
    state: Mutex<State>,
}

impl BlockedReminderClock {
    pub fn new(host: Arc<dyn ReminderHost>) -> Arc<Self> {
        Self::with_delays(host, REMINDER_DELAYS_MS.to_vec())
    }

    pub fn with_delays(host: Arc<dyn ReminderHost>, delays: Vec<u64>) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            host,
            delays,
            me: me.clone(),
            state: Mutex::new(State::default()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A turn started (any origin): the clock stops and the idle time is forgotten.
    pub fn session_busy(&self) {
        let cancel = {
            let mut state = self.lock();
            state.idle_since = None;
            state.epoch += 1;
            state.cancel.take()
        };
        if let Some(cancel) = cancel {
            cancel();
        }
    }

    /// The command queue drained. Already idle is a no-op: an empty drain is not a turn and must not reset the clock.
    pub fn session_idle(&self) {
        let now = self.host.now_ms();
        {
            let mut state = self.lock();
            if state.stopped || state.idle_since.is_some() {
                return;
            }
            state.idle_since = Some(now);
        }
        self.arm(0);
    }

    /// The user wrote a message: every run gets a fresh pair of reminders.
    pub fn user_spoke(&self) {
        self.lock().sent.clear();
    }

    /// A run's open set changed (raised, resolved, reached, filled): the run gets a fresh pair. An idle session restarts
    /// its idle clock from now, so a pair that is new does not wait behind a long idle period.
    pub fn open_set_changed(&self, run_id: &str) {
        let now = self.host.now_ms();
        {
            let mut state = self.lock();
            state.sent.remove(run_id);
            if state.stopped || state.idle_since.is_none() {
                return;
            }
            state.idle_since = Some(now);
        }
        self.arm(0);
    }

    /// The session closed: nothing is armed or sent from now on.
    pub fn stop(&self) {
        let cancel = {
            let mut state = self.lock();
            state.stopped = true;
            state.idle_since = None;
            state.epoch += 1;
            state.cancel.take()
        };
        if let Some(cancel) = cancel {
            cancel();
        }
    }

    /// Cancels the timer and computes the next one. The timer is scheduled outside the lock.
    fn arm(&self, reached: u64) {
        // The host is asked before the lock is taken: a host call may call back into the clock.
        let live = self.host.live_run_ids();
        let now = self.host.now_ms();
        let (cancel, plan) = {
            let mut state = self.lock();
            state.epoch += 1;
            let cancel = state.cancel.take();
            (cancel, self.plan_locked(&mut state, &live, now, reached))
        };
        if let Some(cancel) = cancel {
            cancel();
        }
        let Some((epoch, target, wait)) = plan else {
            return;
        };
        let weak = self.me.clone();
        let cancel = self.host.schedule(
            wait,
            Box::new(move || {
                if let Some(clock) = weak.upgrade() {
                    clock.expire(epoch, target);
                }
            }),
        );
        let stale = {
            let mut state = self.lock();
            if state.epoch == epoch {
                state.cancel = Some(cancel);
                None
            } else {
                Some(cancel)
            }
        };
        if let Some(cancel) = stale {
            cancel();
        }
    }

    /// The next timer: the smallest delay above `reached` among the live runs that still have one. `None` when no run
    /// has a reminder left or the session is busy.
    fn plan_locked(
        &self,
        state: &mut State,
        live: &[String],
        now: u64,
        reached: u64,
    ) -> Option<(u64, u64, u64)> {
        let idle_since = state.idle_since?;
        prune_locked(state, live);
        let mut next: Option<u64> = None;
        for run_id in live {
            let Some(delay) = self.delay_for_locked(state, run_id) else {
                continue;
            };
            if delay <= reached {
                continue;
            }
            next = Some(next.map_or(delay, |best| best.min(delay)));
        }
        let target = next?;
        let wait = (idle_since + target).saturating_sub(now);
        Some((state.epoch, target, wait))
    }

    /// The idle time `reached` has come: each run whose delay is due and that still has an open decision gets one
    /// reminder, and the next timer is armed if no turn started because of them.
    fn expire(&self, epoch: u64, reached: u64) {
        {
            let state = self.lock();
            if state.epoch != epoch || state.stopped {
                return;
            }
        }
        if !self.host.is_idle() {
            return;
        }
        // No lock is held while the host is asked: its reads may call back into the clock (review of #596).
        let live = self.host.live_run_ids();
        let candidates: Vec<String> = {
            let mut state = self.lock();
            prune_locked(&mut state, &live);
            live.iter()
                .filter(|run_id| {
                    self.delay_for_locked(&state, run_id)
                        .is_some_and(|delay| delay <= reached)
                })
                .cloned()
                .collect()
        };
        let mut due: Vec<(String, OpenDecisions)> = Vec::new();
        for run_id in candidates {
            if let Some(open) = self.host.read_open(&run_id)
                && !open.is_empty()
            {
                due.push((run_id, open));
            }
        }
        let now = self.host.now_ms();
        if self.lock().epoch != epoch {
            return;
        }
        for (run_id, open) in due {
            // Counted when it is queued: the reminder may start a turn, which calls `session_busy` synchronously.
            let ordinal = {
                let mut state = self.lock();
                let count = state.sent.get(&run_id).copied().unwrap_or(0) + 1;
                state.sent.insert(run_id.clone(), count);
                count
            };
            self.host.remind(Reminder {
                run_id,
                open,
                ordinal,
                total: self.delays.len(),
                now,
            });
        }
        let current = self.lock().epoch == epoch;
        if current {
            self.arm(reached);
        }
    }

    /// The delay the run's next reminder needs, or `None` when its reminders are used up.
    fn delay_for_locked(&self, state: &State, run_id: &str) -> Option<u64> {
        let count = state.sent.get(run_id).copied().unwrap_or(0);
        self.delays.get(count).copied()
    }
}

/// The counts of a run that is no longer live are dropped: a run resumed later under the same id starts its reminders
/// again from the first. Membership is a set, as Node's check is (review of #596).
fn prune_locked(state: &mut State, live: &[String]) {
    if state.sent.is_empty() {
        return;
    }
    let alive: HashSet<&str> = live.iter().map(String::as_str).collect();
    state
        .sent
        .retain(|run_id, _| alive.contains(run_id.as_str()));
}

#[cfg(test)]
#[path = "workflow_reminder_tests.rs"]
mod tests;
