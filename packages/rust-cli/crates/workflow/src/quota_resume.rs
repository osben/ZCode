//! Quota auto-resume (W6b part 5; Node `bootstrap/src/app/dynamic-workflow-quota-resume.ts`, spec
//! `docs/dynamic-workflow/` "Resuming after a quota reset" in `apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md`).
//!
//! A run stopped as `stopped(provider)` with kind `quota` and a `resetAt` resumes once, at `resetAt + 1 min`.
//!
//! - The run row is the only source of truth. The timer only wakes the module; when it fires the row is read again,
//!   and the resume happens only if it is still the same quota stop.
//! - Two entries: a run settling in this process ([`QuotaAutoResume::on_run_settled`]), and a session scan at open
//!   ([`QuotaAutoResume::scan`]). A stopped run does not keep its session resident, so the scan is the catch-up.
//! - No loop: a resume that finds the same (or an earlier) reset time is not resumed again in this process.
//! - Repeated resumes are spaced: 10 minutes after the previous start, doubling, at most one hour.
//! - A transient refusal (`already_running`) or a thrown resume is retried at the margin, at most twice.
//! - A failed journal read ends that attempt; nothing escapes a timer job.
//!
//! The resume itself is the port's job: production (W7) resumes through the session's run service, the same path as
//! the app's Resume. Timers come from the redrive clock, with a generation per arming, as the stall clock does.

use crate::model::{RunRow, RunStatus, StopReason};
use crate::model_failure::RedriveClock;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Node `WORKFLOW_QUOTA_RESUME_MARGIN_MS`: the reset time plus one minute.
pub const WORKFLOW_QUOTA_RESUME_MARGIN_MS: u64 = 60_000;
/// Node `WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS`: the first gap between two auto-resumes of one run.
pub const WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS: u64 = 10 * 60_000;
/// Node `WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS`: the gap stops doubling here.
pub const WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS: u64 = 60 * 60_000;
/// Node `WORKFLOW_QUOTA_RESUME_RETRY_LIMIT`: transient refusals retried, one margin apart.
pub const WORKFLOW_QUOTA_RESUME_RETRY_LIMIT: u32 = 2;
/// Node `COLD_START_SCAN_LIMIT`: the session scan reads at most this many recent runs.
pub const COLD_START_SCAN_LIMIT: usize = 64;

/// Node's `setTimeout` ceiling (about 24.8 days). A later wake re-reads the row and re-arms.
const MAX_TIMER_DELAY_MS: u64 = 2_147_483_647;

/// What the resume port answers: resumed, or refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeAnswer {
    Resumed,
    Refused(Refusal),
}

/// A refusal of the resume. Node's `DynamicWorkflowRunResumeErrorReason` union: only `already_running` passes on its
/// own (Node `TRANSIENT_RESUME_REFUSALS`); every other reason says the run cannot be resumed as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The run is in flight in this process (the user pressed Resume at the same moment). Retried.
    AlreadyRunning,
    /// Any other reason, by Node's name for it. Logged, not retried.
    Other(String),
}

impl Refusal {
    fn is_transient(&self) -> bool {
        matches!(self, Self::AlreadyRunning)
    }

    fn reason(&self) -> &str {
        match self {
            Self::AlreadyRunning => "already_running",
            Self::Other(reason) => reason,
        }
    }
}

/// What the module needs from the world. Every method may fail with a message (a journal or execution error).
/// `resume` runs on a timer's thread and blocks until the resume answers.
pub trait QuotaResumePort: Send + Sync {
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>, String>;
    /// The session's recent runs, newest first, at most `limit`.
    fn list_session_runs(&self, limit: usize) -> Result<Vec<RunRow>, String>;
    fn resume(&self, run_id: &str) -> Result<ResumeAnswer, String>;
}

/// Node `quotaResumeAt`: when a row is a quota stop with a reset time, the time to resume at; otherwise `None`. Pure:
/// the timer and the settlement both decide with it.
pub fn quota_resume_at(row: &RunRow) -> Option<u64> {
    if row.status != RunStatus::Stopped || row.stop_reason != Some(StopReason::Provider) {
        return None;
    }
    let stop = row.failure.as_ref()?.get("providerStop")?;
    if stop.get("kind")?.as_str()? != "quota" {
        return None;
    }
    let reset_at = stop.get("resetAt")?.as_u64()?;
    reset_at.checked_add(WORKFLOW_QUOTA_RESUME_MARGIN_MS)
}

/// The module for one session. Call [`QuotaAutoResume::dispose`] at close: dropping it does not cancel the timers.
///
/// Staging: no production code constructs this yet. The run service (W7) builds it per session with its port and the
/// production clock, and wires `on_run_settled`, `scan` and `dispose` (spec section 9.14). Until then only the tests
/// exercise it.
pub struct QuotaAutoResume {
    inner: Arc<Inner>,
}

struct Inner {
    port: Arc<dyn QuotaResumePort>,
    clock: Arc<dyn RedriveClock>,
    state: Mutex<State>,
    /// Test seam: runs once, after a timer has taken its slot and before it records and resumes.
    #[cfg(test)]
    between_take_and_record: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

#[derive(Default)]
struct State {
    disposed: bool,
    next_generation: u64,
    /// The armed timer of each run, by generation. A job whose generation is not the run's current one does nothing.
    timers: HashMap<String, u64>,
    /// The reset time each run last auto-resumed for (Node `lastResumedAt`).
    last_resumed_at: HashMap<String, u64>,
    /// When each run's last auto-resume started, and how many there have been (Node `resumeStarts`).
    resume_starts: HashMap<String, (u64, u32)>,
}

/// What a timer does when it fires.
#[derive(Clone, Copy)]
enum Fire {
    /// Read the row and resume it if it is still the quota stop at `expected_at`. `retries_left` bounds the transient
    /// retries (Node `fire`'s `retriesLeft`).
    Resume { expected_at: u64, retries_left: u32 },
}

impl QuotaAutoResume {
    pub fn new(port: Arc<dyn QuotaResumePort>, clock: Arc<dyn RedriveClock>) -> Self {
        Self {
            inner: Arc::new(Inner {
                port,
                clock,
                state: Mutex::new(State::default()),
                #[cfg(test)]
                between_take_and_record: Mutex::new(None),
            }),
        }
    }

    /// Test seam: the hook runs once, after the next timer takes its slot and before it records and resumes.
    #[cfg(test)]
    pub(crate) fn set_hook_between_take_and_record(&self, hook: Box<dyn FnOnce() + Send>) {
        *self
            .inner
            .between_take_and_record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(hook);
    }

    /// Node's run-settled subscription: a run of this session settled in this process.
    pub fn on_run_settled(&self, run_id: &str) {
        if self.inner.lock().disposed {
            return;
        }
        let row = read_row(&self.inner, run_id);
        consider(&self.inner, run_id, row.as_ref());
    }

    /// Node's cold-start scan: the session's recent runs, the due ones resumed now and the others armed.
    pub fn scan(&self) {
        match self.inner.port.list_session_runs(COLD_START_SCAN_LIMIT) {
            Ok(rows) => {
                for row in rows {
                    consider(&self.inner, &row.run_id, Some(&row));
                }
            }
            Err(error) => tracing::warn!(
                event = "dynamic_workflow.quota_resume.scan_failed",
                error = %clipped(&error),
                "Dynamic workflow quota auto-resume scan failed"
            ),
        }
    }

    /// Node's `dispose`: cancels every timer; nothing resumes afterwards.
    pub fn dispose(&self) {
        let mut state = self.inner.lock();
        state.disposed = true;
        state.timers.clear();
    }
}

impl Inner {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // A panic inside a timer job must not wedge the module: the state is plain data, so the poisoned guard is used.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Reads a row; a failed read is logged and counts as no row, so the attempt ends without resuming.
fn read_row(inner: &Arc<Inner>, run_id: &str) -> Option<RunRow> {
    match inner.port.get_run(run_id) {
        Ok(row) => row,
        Err(error) => {
            tracing::warn!(
                event = "dynamic_workflow.quota_resume.read_failed",
                run_id,
                error = %clipped(&error),
                "Dynamic workflow quota auto-resume could not read the run"
            );
            None
        }
    }
}

/// Node `consider`: arms the run when its row is a quota stop with a reset time.
fn consider(inner: &Arc<Inner>, run_id: &str, row: Option<&RunRow>) {
    if let Some(resume_at) = row.and_then(quota_resume_at) {
        arm(inner, run_id, resume_at);
    }
}

/// Node `arm`: the timer for a reset time, delayed by the spacing rule. Replaces the run's timer.
fn arm(inner: &Arc<Inner>, run_id: &str, resume_at: u64) {
    let now = inner.clock.now_ms();
    let (generation, delay_ms, start_at) = {
        let mut state = inner.lock();
        if state.disposed {
            return;
        }
        if let Some(previous) = state.last_resumed_at.get(run_id).copied()
            && resume_at <= previous
        {
            // The reset time did not move: this run is not resumed again for it. Any retry still pending goes too.
            state.timers.remove(run_id);
            tracing::warn!(
                event = "dynamic_workflow.quota_resume.not_advancing",
                run_id,
                resume_at,
                previous_resume_at = previous,
                "Dynamic workflow quota auto-resume skipped: reset time did not move"
            );
            return;
        }
        // Replaces whatever timer the run had: its generation is no longer current.
        state.timers.remove(run_id);
        let start_at = resume_at.max(earliest_next_start(&state, run_id));
        let delay = start_at.saturating_sub(now).min(MAX_TIMER_DELAY_MS);
        let generation = next_generation(&mut state);
        state.timers.insert(run_id.to_owned(), generation);
        (generation, delay, start_at)
    };
    let armed = schedule(
        inner,
        run_id,
        generation,
        delay_ms,
        Fire::Resume {
            expected_at: resume_at,
            retries_left: WORKFLOW_QUOTA_RESUME_RETRY_LIMIT,
        },
    );
    // Logged only when the timer is really armed; a spaced start is named as Node names it.
    if armed {
        let spaced_until = (start_at > resume_at).then_some(start_at);
        tracing::info!(
            event = "dynamic_workflow.quota_resume.scheduled",
            run_id,
            resume_at,
            spaced_until,
            "Dynamic workflow quota auto-resume scheduled"
        );
    }
}

/// Node `earliestNextStart`: the first start allowed for a run's next auto-resume. Nothing before its first.
fn earliest_next_start(state: &State, run_id: &str) -> u64 {
    match state.resume_starts.get(run_id) {
        None => 0,
        Some(&(at, count)) => {
            let doublings = count.saturating_sub(1).min(32);
            let spacing = WORKFLOW_QUOTA_RESUME_MIN_SPACING_MS
                .saturating_mul(1u64 << doublings)
                .min(WORKFLOW_QUOTA_RESUME_MAX_SPACING_MS);
            at.saturating_add(spacing)
        }
    }
}

fn next_generation(state: &mut State) -> u64 {
    state.next_generation += 1;
    state.next_generation
}

/// Schedules a job on the clock and returns whether it was armed. The lock is not held: a clock may run its job at once.
/// A refused job leaves no timer armed for the run, and is logged as a schedule failure, apart from a port refusal.
fn schedule(inner: &Arc<Inner>, run_id: &str, generation: u64, delay_ms: u64, fire: Fire) -> bool {
    let job_inner = inner.clone();
    let job_run = run_id.to_owned();
    let scheduled = inner.clock.after(
        delay_ms,
        Box::new(move || fire_job(&job_inner, &job_run, generation, fire)),
    );
    if !scheduled {
        tracing::warn!(
            event = "dynamic_workflow.quota_resume.schedule_failed",
            run_id,
            "Dynamic workflow quota auto-resume could not schedule its timer"
        );
        let mut state = inner.lock();
        if state.timers.get(run_id) == Some(&generation) {
            state.timers.remove(run_id);
        }
    }
    scheduled
}

/// Node `fire`: the timer wakes. A timer whose generation is no longer the run's does nothing.
fn fire_job(inner: &Arc<Inner>, run_id: &str, generation: u64, fire: Fire) {
    let Fire::Resume {
        expected_at,
        retries_left,
    } = fire;
    if !is_armed(inner, run_id, generation) {
        return;
    }
    // The row is read without the lock, so a settle or a dispose can land during the read. The generation is checked
    // again under the lock once the read has returned: a timer that was replaced or cleared in the meantime stops here.
    let row = read_row(inner, run_id);
    if !take_timer(inner, run_id, generation) {
        return;
    }
    #[cfg(test)]
    {
        let hook = inner
            .between_take_and_record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(hook) = hook {
            hook();
        }
    }
    let Some(resume_at) = row.as_ref().and_then(quota_resume_at) else {
        // The row is no longer a quota stop: resumed by hand, superseded, or stopped elsewhere.
        return;
    };
    let now = inner.clock.now_ms();
    if resume_at != expected_at || resume_at > now {
        // The row names another reset time, or the wake came at the timer ceiling: arm by the row, unless a newer
        // timer has been armed since this one took its slot.
        if !slot_is_free(inner, run_id) {
            return;
        }
        arm(inner, run_id, resume_at);
        return;
    }
    {
        // Checked and recorded in one critical section: a newer timer armed since the slot was taken, or a dispose,
        // means this stale job resumes nothing.
        let mut state = inner.lock();
        if state.disposed || state.timers.contains_key(run_id) {
            return;
        }
        state.last_resumed_at.insert(run_id.to_owned(), resume_at);
        let count = state
            .resume_starts
            .get(run_id)
            .map_or(0, |&(_, count)| count);
        state
            .resume_starts
            .insert(run_id.to_owned(), (now, count + 1));
    }
    tracing::info!(
        event = "dynamic_workflow.quota_resume.started",
        run_id,
        resume_at,
        "Dynamic workflow run auto-resuming after quota reset"
    );
    match inner.port.resume(run_id) {
        Ok(ResumeAnswer::Resumed) => {}
        Ok(ResumeAnswer::Refused(refusal)) => {
            tracing::warn!(
                event = "dynamic_workflow.quota_resume.refused",
                run_id,
                reason = refusal.reason(),
                "Dynamic workflow quota auto-resume was refused"
            );
            if refusal.is_transient() {
                retry_later(inner, run_id, resume_at, retries_left);
            }
        }
        Err(error) => {
            tracing::warn!(
                event = "dynamic_workflow.quota_resume.failed",
                run_id,
                error = %clipped(&error),
                "Dynamic workflow quota auto-resume failed"
            );
            retry_later(inner, run_id, resume_at, retries_left);
        }
    }
}

/// Whether `generation` is the run's armed timer, and the module is live.
fn is_armed(inner: &Arc<Inner>, run_id: &str, generation: u64) -> bool {
    let state = inner.lock();
    !state.disposed && state.timers.get(run_id) == Some(&generation)
}

/// Whether the module is live and no timer is armed for the run: the job that took the slot still owns the run.
fn slot_is_free(inner: &Arc<Inner>, run_id: &str) -> bool {
    let state = inner.lock();
    !state.disposed && !state.timers.contains_key(run_id)
}

/// Takes the run's timer for `generation` out of the table, if it is still armed and the module is live. False when a
/// settle replaced it or a dispose cleared it, so the job must do nothing.
fn take_timer(inner: &Arc<Inner>, run_id: &str, generation: u64) -> bool {
    let mut state = inner.lock();
    if state.disposed || state.timers.get(run_id) != Some(&generation) {
        return false;
    }
    state.timers.remove(run_id);
    true
}

/// Node `retryLater`: a transient refusal is retried one margin later, at most the retry limit; a timer already armed
/// for the run (a settlement armed a newer one) wins.
fn retry_later(inner: &Arc<Inner>, run_id: &str, resume_at: u64, retries_left: u32) {
    let generation = {
        let mut state = inner.lock();
        if state.disposed || state.timers.contains_key(run_id) {
            return;
        }
        if retries_left == 0 {
            tracing::warn!(
                event = "dynamic_workflow.quota_resume.gave_up",
                run_id,
                resume_at,
                "Dynamic workflow quota auto-resume gave up after retries"
            );
            return;
        }
        let generation = next_generation(&mut state);
        state.timers.insert(run_id.to_owned(), generation);
        generation
    };
    let armed = schedule(
        inner,
        run_id,
        generation,
        WORKFLOW_QUOTA_RESUME_MARGIN_MS,
        Fire::Resume {
            expected_at: resume_at,
            retries_left: retries_left - 1,
        },
    );
    if armed {
        tracing::info!(
            event = "dynamic_workflow.quota_resume.retry_scheduled",
            run_id,
            resume_at,
            retries_left,
            "Dynamic workflow quota auto-resume retry scheduled"
        );
    }
}

/// Log text is bounded: a storage error may carry a whole statement or a path.
fn clipped(message: &str) -> String {
    const MAX_CHARS: usize = 500;
    if message.chars().count() > MAX_CHARS {
        let head: String = message.chars().take(MAX_CHARS).collect();
        format!("{head}…")
    } else {
        message.to_owned()
    }
}
