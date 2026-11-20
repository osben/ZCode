//! Fork: the session's reminder host (specs/fork-rust-workflow-engine.md, 9.41, W7-8e; closes divergence 357 of 9.38 for the
//! host, and 358 to 360 in part). Node's `WorkflowBlockedReminderClock` is driven from the session: the session's turn edges
//! tell it when the session goes idle or busy, the clock's timers come from the runtime, the run snapshot is read for each
//! live run, and the reminder's text is the `blocked` formatter's.
//!
//! The host is synchronous, as the clock's trait is. The run snapshot is therefore read through [`RunDecisions`], which the
//! composition implements over the run service: an async read must be answered from memory or run off the owner thread by
//! that implementation (not here). A read that fails is logged and the run is skipped for this reminder (Node `onReadError`).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rust_cli_kernel_api::clock::Clock;
use rust_cli_prompts::workflow_notice::{Blocked, BlockedHole, BlockedQuestion, blocked};

use super::workflow_progress::WorkflowNotices;
use super::workflow_reminder::{BlockedReminderClock, OpenDecisions, Reminder, ReminderHost};

/// The clock's time and timers. Production: the tokio runtime ([`TokioTimers`]); tests: a fake clock.
///
/// `now_ms` and `schedule` share one time base: `schedule(delay)` means "`delay` after the `now_ms` I report now". The
/// clock computes its waits from `now_ms` (the idle start plus the delay, minus now), so both must come from the same clock.
/// [`TokioTimers`] pairs with a wall clock (`SystemClock`), whose `now_ms` can step backwards; a backward step lengthens a
/// wait, a forward step shortens it. The tokio sleep itself is monotonic.
pub trait ReminderTimers: Send + Sync {
    /// Epoch milliseconds now.
    fn now_ms(&self) -> u64;
    /// Runs `fire` after `delay_ms` (on the `now_ms` base above) and returns the cancel of that timer (a cancelled timer never
    /// fires).
    fn schedule(&self, delay_ms: u64, fire: Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send>;
}

/// The run snapshot of one session, read at each use.
pub trait RunDecisions: Send + Sync {
    /// The live runs of the session.
    fn live_run_ids(&self) -> Vec<String>;
    /// What one run still owes: `Ok(None)` when it owes nothing, `Err` when its snapshot could not be read.
    fn open(&self, run_id: &str) -> Result<Option<OpenDecisions>, String>;
}

/// The production timers: the runtime's sleep, with the time from the injected clock. `fire` runs on a runtime task after
/// the delay, and a cancel aborts it, so a pending reminder does not keep the process alive.
pub struct TokioTimers {
    handle: tokio::runtime::Handle,
    clock: Arc<dyn Clock>,
}

impl TokioTimers {
    pub fn new(handle: tokio::runtime::Handle, clock: Arc<dyn Clock>) -> Self {
        Self { handle, clock }
    }
}

impl ReminderTimers for TokioTimers {
    fn now_ms(&self) -> u64 {
        self.clock.now_ms()
    }

    fn schedule(&self, delay_ms: u64, fire: Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send> {
        let task = self.handle.spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            fire();
        });
        Box::new(move || task.abort())
    }
}

/// The clock's side of one session: the parent session's id, the run snapshot, the timers, the notice sink and the idle
/// flag that the turn edges keep.
struct Host {
    session: String,
    runs: Arc<dyn RunDecisions>,
    timers: Arc<dyn ReminderTimers>,
    notices: Arc<dyn WorkflowNotices>,
    idle: AtomicBool,
}

impl ReminderHost for Host {
    fn live_run_ids(&self) -> Vec<String> {
        self.runs.live_run_ids()
    }

    fn is_idle(&self) -> bool {
        self.idle.load(Ordering::SeqCst)
    }

    fn read_open(&self, run_id: &str) -> Option<OpenDecisions> {
        match self.runs.open(run_id) {
            Ok(open) => open,
            Err(error) => {
                tracing::warn!(
                    event = "dynamic_workflow.reminder.read_failed",
                    run_id,
                    error = %error,
                    "Dynamic workflow blocked reminder skipped: the run snapshot could not be read"
                );
                None
            }
        }
    }

    fn remind(&self, reminder: Reminder) {
        self.notices.post(&self.session, reminder_text(&reminder));
    }

    fn now_ms(&self) -> u64 {
        self.timers.now_ms()
    }

    fn schedule(&self, delay_ms: u64, fire: Box<dyn FnOnce() + Send>) -> Box<dyn FnOnce() + Send> {
        self.timers.schedule(delay_ms, fire)
    }
}

/// The blocked reminder's text (Node `formatWorkflowBlockedNotification`): each open question and hole with how long it has
/// waited at the send. The run label is the run id (the progress path has no registry, as 9.38 divergence 352).
fn reminder_text(reminder: &Reminder) -> String {
    let questions: Vec<BlockedQuestion> = reminder
        .open
        .questions
        .iter()
        .map(|question| BlockedQuestion {
            qid: question.qid.clone(),
            subagent: question.subagent.clone(),
            question: question.question.clone(),
            context: question.context.clone(),
            waited_ms: reminder
                .now
                .saturating_sub(question.asked_at.unwrap_or(reminder.now)),
        })
        .collect();
    let holes: Vec<BlockedHole> = reminder
        .open
        .holes
        .iter()
        .map(|hole| BlockedHole {
            site_id: hole.site_id.clone(),
            name: hole.name.clone(),
            type_name: hole.type_name.clone(),
            line: hole.line,
            waited_ms: reminder
                .now
                .saturating_sub(hole.since.unwrap_or(reminder.now)),
        })
        .collect();
    blocked(&Blocked {
        run_label: &reminder.run_id,
        run_id: &reminder.run_id,
        ordinal: reminder.ordinal,
        total: reminder.total,
        questions: &questions,
        holes: &holes,
        draft_path: reminder.open.draft_path.as_deref(),
    })
}

/// One session's reminder clock with its host. The session's turn edges go through here, so the idle flag and the clock
/// change together.
pub struct SessionReminders {
    host: Arc<Host>,
    clock: Arc<BlockedReminderClock>,
}

impl SessionReminders {
    pub fn new(
        session: &str,
        runs: Arc<dyn RunDecisions>,
        timers: Arc<dyn ReminderTimers>,
        notices: Arc<dyn WorkflowNotices>,
    ) -> Arc<Self> {
        let host = Arc::new(Host {
            session: session.to_owned(),
            runs,
            timers,
            notices,
            idle: AtomicBool::new(false),
        });
        let clock = BlockedReminderClock::new(host.clone());
        Arc::new(Self { host, clock })
    }

    /// The clock, for the progress host's open-set changes (`WorkflowProgressHost::with_reminder`).
    pub fn clock(&self) -> Arc<BlockedReminderClock> {
        self.clock.clone()
    }

    /// A turn started (any origin): the session is busy and the clock stops.
    ///
    /// The two edges must arrive serially and in order, from the session's actor. The idle flag and the clock are two
    /// writes, and they are not atomic together: a concurrent edge could leave them disagreeing. A lock around both is not
    /// used, because the clock may call `turn_started` back from inside `remind` (a reminder that starts a turn).
    pub fn turn_started(&self) {
        self.host.idle.store(false, Ordering::SeqCst);
        self.clock.session_busy();
    }

    /// The session's queue drained: the session is idle and the idle clock starts. Serial with `turn_started`, as above.
    pub fn turn_finished(&self) {
        self.host.idle.store(true, Ordering::SeqCst);
        self.clock.session_idle();
    }
}

#[cfg(test)]
#[path = "workflow_reminder_host_tests.rs"]
mod tests;
