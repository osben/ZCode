//! Fork: the session's reminder host (specs/fork-rust-workflow-engine.md, 9.41, W7-8e; closes divergence 357 of 9.38 for the
//! host, and 358 to 360 in part). Node's `WorkflowBlockedReminderClock` is driven from the session: the session's turn edges
//! tell it when the session goes idle or busy, the clock's timers come from the runtime, the run snapshot is read for each
//! live run, and the reminder's text is the `blocked` formatter's.
//!
//! The host is synchronous, as the clock's trait is. The run snapshot is therefore read through [`RunDecisions`], which the
//! composition implements over the run service: an async read must be answered from memory or run off the owner thread by
//! that implementation (not here). A read that fails is logged and the run is skipped for this reminder (Node `onReadError`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::dynamic_workflow::DynamicWorkflowGates;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_prompts::workflow_notice::{Blocked, BlockedHole, BlockedQuestion, blocked};
use serde_json::Value;

use super::workflow_progress::WorkflowNotices;
use super::workflow_reminder::{
    BlockedReminderClock, OpenDecisions, OpenHole, OpenQuestion, Reminder, ReminderHost,
};

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

/// Fork (W7-11, 9.44): the run snapshots of every session, read from memory by the composition (the service's per-session
/// projection). The session is named on each read, so one source serves every session's clock.
pub trait RunDecisionsSource: Send + Sync {
    /// The live runs of `session`.
    fn live_run_ids(&self, session: &str) -> Vec<String>;
    /// What one run of `session` still owes; `Ok(None)` when it owes nothing or is unknown.
    fn open(&self, session: &str, run_id: &str) -> Result<Option<OpenDecisions>, String>;
}

/// One session's view of the shared source. Until the source is set it reports no live run, so no reminder is due.
struct Routed {
    source: Arc<OnceLock<Arc<dyn RunDecisionsSource>>>,
    session: String,
}

impl RunDecisions for Routed {
    fn live_run_ids(&self) -> Vec<String> {
        match self.source.get() {
            Some(source) => source.live_run_ids(&self.session),
            None => Vec::new(),
        }
    }

    fn open(&self, run_id: &str) -> Result<Option<OpenDecisions>, String> {
        match self.source.get() {
            Some(source) => source.open(&self.session, run_id),
            None => Ok(None),
        }
    }
}

/// Fork (W7-11, 9.44, closes 412): one reminder clock per session, made on the session's first turn edge or open-set change.
/// The composition builds it before the run service exists (the progress host takes it), so the run source is set later.
/// A session whose gate is not open has no clock and its edges are ignored (no run can be live for it).
pub struct WorkflowReminders {
    gates: Arc<dyn DynamicWorkflowGates>,
    timers: Arc<dyn ReminderTimers>,
    notices: Arc<dyn WorkflowNotices>,
    source: Arc<OnceLock<Arc<dyn RunDecisionsSource>>>,
    sessions: Mutex<HashMap<String, Arc<SessionReminders>>>,
}

impl WorkflowReminders {
    pub fn new(
        gates: Arc<dyn DynamicWorkflowGates>,
        timers: Arc<dyn ReminderTimers>,
        notices: Arc<dyn WorkflowNotices>,
    ) -> Self {
        Self {
            gates,
            timers,
            notices,
            source: Arc::new(OnceLock::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Sets the run source. A second set is refused and keeps the first.
    pub fn set_runs(&self, source: Arc<dyn RunDecisionsSource>) -> bool {
        self.source.set(source).is_ok()
    }

    /// A turn started in `session`: the session is busy.
    pub fn turn_started(&self, session: &str) {
        if let Some(reminders) = self.session(session) {
            reminders.turn_started();
        }
    }

    /// The session's turn ended: the session is idle.
    pub fn turn_finished(&self, session: &str) {
        if let Some(reminders) = self.session(session) {
            reminders.turn_finished();
        }
    }

    /// A run of `session` changed what it owes (Node `noteWorkflowReminderRunEvent`).
    pub fn open_set_changed(&self, session: &str, run_id: &str) {
        if let Some(reminders) = self.session(session) {
            reminders.clock().open_set_changed(run_id);
        }
    }

    /// The session's clock, made if absent. `None` when the session's gate is not open. A new clock starts idle, so a clock
    /// first seen at an open-set change (no turn edge in this process) is idle, and a turn edge moves it from there.
    fn session(&self, session: &str) -> Option<Arc<SessionReminders>> {
        if !self
            .gates
            .gate(&SessionId::new(session))
            .is_some_and(|gate| gate.enabled)
        {
            return None;
        }
        if let Some(existing) = self.lock_sessions().get(session) {
            return Some(existing.clone());
        }
        // Made outside the lock: the first turn-finished arms the clock, which calls the run source and the timers, and
        // those must not run under the map's lock (every session's edges wait on it).
        let made = self.make(session);
        let mut sessions = self.lock_sessions();
        match sessions.get(session) {
            Some(winner) => {
                let winner = winner.clone();
                drop(sessions);
                // Another edge made the session's clock first; this one never joins the map, so its timers stop here.
                made.clock().stop();
                Some(winner)
            }
            None => {
                sessions.insert(session.to_owned(), made.clone());
                Some(made)
            }
        }
    }

    /// A new session clock, idle (its first turn-finished arms the idle clock).
    fn make(&self, session: &str) -> Arc<SessionReminders> {
        let runs = Arc::new(Routed {
            source: self.source.clone(),
            session: session.to_owned(),
        });
        let reminders =
            SessionReminders::new(session, runs, self.timers.clone(), self.notices.clone());
        reminders.turn_finished();
        reminders
    }

    fn lock_sessions(&self) -> MutexGuard<'_, HashMap<String, Arc<SessionReminders>>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The user wrote a prompt (Node `userSpoke`): every run of the session gets a fresh pair of reminders.
    pub fn user_spoke(&self, session: &str) {
        if let Some(reminders) = self.session(session) {
            reminders.clock().user_spoke();
        }
    }

    /// The session was deleted (Node: its reminders go with it): its clock stops, so a due reminder does not fire for a
    /// dead session, and its entry is dropped, so the map does not grow with deleted sessions.
    pub fn forget(&self, session: &str) {
        let removed = self.lock_sessions().remove(session);
        if let Some(reminders) = removed {
            reminders.clock().stop();
        }
    }
}

/// Fork (W7-11, 9.44): what a run owes, read from its run object in the projection (the reducer's shape): the pending
/// questions, and the holes in state `waiting`. A question's subagent is its actor's name, else `siteId@ordinal` (Node
/// `actorRefLabel`). The projection keeps no hole line and no draft path, so those are `None` (divergences 487 and 488).
pub fn open_decisions_of(run: &Value) -> OpenDecisions {
    let questions = run
        .get("pendingQuestions")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(open_question_of).collect())
        .unwrap_or_default();
    let holes = run
        .get("holes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|hole| text_of(hole, "state") == Some("waiting"))
                .filter_map(open_hole_of)
                .collect()
        })
        .unwrap_or_default();
    OpenDecisions {
        questions,
        holes,
        draft_path: None,
    }
}

fn open_question_of(item: &Value) -> Option<OpenQuestion> {
    Some(OpenQuestion {
        qid: text_of(item, "qid")?.to_owned(),
        subagent: subagent_of(item),
        question: text_of(item, "question")?.to_owned(),
        context: text_of(item, "context").map(str::to_owned),
        asked_at: epoch_of(item.get("askedAt")),
    })
}

fn open_hole_of(item: &Value) -> Option<OpenHole> {
    Some(OpenHole {
        site_id: text_of(item, "siteId")?.to_owned(),
        name: text_of(item, "name")?.to_owned(),
        type_name: text_of(item, "type").unwrap_or_default().to_owned(),
        line: None,
        since: epoch_of(item.get("since")),
    })
}

/// Node `actorRefLabel` for a pending question: its actor's name, else `siteId@ordinal`, else the fixed fallback.
fn subagent_of(item: &Value) -> String {
    if let Some(name) = text_of(item, "actorName") {
        return name.to_owned();
    }
    match (
        text_of(item, "actorSiteId"),
        item.get("actorOrdinal").and_then(Value::as_u64),
    ) {
        (Some(site), Some(ordinal)) => format!("{site}@{ordinal}"),
        _ => "unknown actor".to_owned(),
    }
}

/// A non-empty string field.
fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// An epoch in milliseconds, from a whole number or a finite, non-negative float.
fn epoch_of(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|at| at.is_finite() && *at >= 0.0)
            .map(|at| at.floor() as u64)
    })
}

#[cfg(test)]
#[path = "workflow_reminder_host_tests.rs"]
mod tests;
