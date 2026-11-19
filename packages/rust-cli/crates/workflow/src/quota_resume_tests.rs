//! W6b part 5: quota auto-resume (Node `bootstrap/tests/dynamic-workflow-quota-resume.test.ts`, ported as Rust unit
//! tests). The clock is driven by hand; the port is a fake whose rows the test writes.

use crate::model::{Caps, RunRow, RunStatus, StopReason};
use crate::quota_resume::{
    QuotaAutoResume, QuotaResumePort, Refusal, ResumeAnswer, WORKFLOW_QUOTA_RESUME_MARGIN_MS,
    quota_resume_at,
};
use crate::test_clock::AdvancingClock;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

const MIN: u64 = 60_000;
const HOUR: u64 = 60 * MIN;
/// 2026-10-15T08:00:00Z.
const START: u64 = 1_792_051_200_000;
const SESSION: &str = "session-1";
/// The reset time of the usual quota stop: two hours after the clock starts.
const RESET: u64 = START + 2 * HOUR;

fn row(run: &str, status: RunStatus, stop: Option<StopReason>, failure: Option<Value>) -> RunRow {
    RunRow {
        run_id: run.into(),
        parent_session_id: Some(SESSION.into()),
        cwd: None,
        name: None,
        tool_call_id: None,
        script_text: None,
        script_hash: None,
        args: None,
        resumed_from: None,
        caps: Caps::default(),
        spent_tokens: 0.0,
        status,
        stop_reason: stop,
        superseded_by: None,
        failure,
        result: None,
    }
}

/// A row that stopped on a quota with the given reset time (Node's `providerStop` details).
fn quota_row(run: &str, reset_at: u64) -> RunRow {
    row(
        run,
        RunStatus::Stopped,
        Some(StopReason::Provider),
        Some(json!({
            "code": "ProviderStop",
            "message": "Subagent site@1 hit a permanent model-side error",
            "providerStop": { "kind": "quota", "reason": "rate_limited", "resetAt": reset_at },
        })),
    )
}

#[derive(Default)]
struct FakePort {
    rows: Mutex<HashMap<String, RunRow>>,
    listed: Mutex<Vec<RunRow>>,
    read_error: Mutex<bool>,
    answers: Mutex<VecDeque<Result<ResumeAnswer, String>>>,
    resumes: Mutex<Vec<String>>,
    /// Runs once, after the next row read has returned: the window between a timer's read and its resume.
    read_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// Runs once, inside the next resume call, before it answers.
    resume_hook: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl FakePort {
    fn put(&self, row: RunRow) {
        self.rows
            .lock()
            .expect("rows")
            .insert(row.run_id.clone(), row);
    }

    fn answer(&self, answer: Result<ResumeAnswer, String>) {
        self.answers.lock().expect("answers").push_back(answer);
    }

    fn resumes(&self) -> Vec<String> {
        self.resumes.lock().expect("resumes").clone()
    }
}

impl QuotaResumePort for FakePort {
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>, String> {
        if *self.read_error.lock().expect("read_error") {
            return Err("the journal read failed".into());
        }
        let found = self.rows.lock().expect("rows").get(run_id).cloned();
        let hook = self.read_hook.lock().expect("read_hook").take();
        if let Some(hook) = hook {
            hook();
        }
        Ok(found)
    }

    fn list_session_runs(&self, limit: usize) -> Result<Vec<RunRow>, String> {
        Ok(self
            .listed
            .lock()
            .expect("listed")
            .iter()
            .take(limit)
            .cloned()
            .collect())
    }

    fn resume(&self, run_id: &str) -> Result<ResumeAnswer, String> {
        self.resumes
            .lock()
            .expect("resumes")
            .push(run_id.to_owned());
        let hook = self.resume_hook.lock().expect("resume_hook").take();
        if let Some(hook) = hook {
            hook();
        }
        self.answers
            .lock()
            .expect("answers")
            .pop_front()
            .unwrap_or(Ok(ResumeAnswer::Resumed))
    }
}

struct Rig {
    clock: Arc<AdvancingClock>,
    port: Arc<FakePort>,
    /// Shared, so a port hook can call back into the module under test.
    quota: Arc<QuotaAutoResume>,
}

fn rig() -> Rig {
    let clock = AdvancingClock::new(START);
    let port = Arc::new(FakePort::default());
    let quota = Arc::new(QuotaAutoResume::new(port.clone(), clock.clone()));
    Rig { clock, port, quota }
}

#[test]
fn a_dispose_between_the_row_read_and_the_resume_means_no_resume() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    let module = r.quota.clone();
    *r.port.read_hook.lock().expect("read_hook") = Some(Box::new(move || module.dispose()));
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert!(
        r.port.resumes().is_empty(),
        "a disposed module does not resume the run it had already read"
    );
}

#[test]
fn a_settle_between_the_row_read_and_the_resume_defers_to_the_newer_timer() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    let moved = RESET + HOUR;
    let module = r.quota.clone();
    let port = r.port.clone();
    *r.port.read_hook.lock().expect("read_hook") = Some(Box::new(move || {
        // The run stops again on a later reset time while the timer holds the old row.
        port.put(quota_row("run_a", moved));
        module.on_run_settled("run_a");
    }));
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert!(
        r.port.resumes().is_empty(),
        "the timer that read the old row is stale once the run settled again"
    );
    r.clock.advance_to(moved + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(r.port.resumes(), vec!["run_a".to_owned()]);
}

#[test]
fn a_retry_that_finds_the_run_started_meanwhile_leaves_it_alone() {
    let r = rig();
    r.port
        .answer(Ok(ResumeAnswer::Refused(Refusal::AlreadyRunning)));
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    // The user resumed the run by hand at the same moment: it is running when the retry looks at it.
    let port = r.port.clone();
    *r.port.resume_hook.lock().expect("resume_hook") = Some(Box::new(move || {
        port.put(row("run_a", RunStatus::Running, None, None));
    }));
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(r.port.resumes().len(), 1);
    r.clock.advance(10 * HOUR);
    assert_eq!(
        r.port.resumes().len(),
        1,
        "the retry re-read the row and left the run alone"
    );
}

#[test]
fn a_pending_retry_is_withdrawn_when_the_run_settles_again_on_the_same_reset_time() {
    let r = rig();
    r.port
        .answer(Ok(ResumeAnswer::Refused(Refusal::AlreadyRunning)));
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(r.port.resumes().len(), 1);
    // A retry is pending. The run stops again on the same reset time, before the retry is due.
    r.quota.on_run_settled("run_a");
    r.clock.advance(10 * HOUR);
    assert_eq!(
        r.port.resumes().len(),
        1,
        "the pending retry is dropped: this reset time was already resumed"
    );
}

#[test]
fn a_journal_read_that_throws_when_the_timer_fires_is_survived() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    *r.port.read_error.lock().expect("read_error") = true;
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert!(r.port.resumes().is_empty(), "a failed read does not resume");
}

#[test]
fn a_dispose_while_a_resume_is_in_flight_schedules_no_retry() {
    let r = rig();
    r.port
        .answer(Ok(ResumeAnswer::Refused(Refusal::AlreadyRunning)));
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    let module = r.quota.clone();
    *r.port.resume_hook.lock().expect("resume_hook") = Some(Box::new(move || module.dispose()));
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(r.port.resumes().len(), 1);
    assert_eq!(r.clock.pending(), 0, "no retry is scheduled after dispose");
    r.clock.advance(10 * HOUR);
    assert_eq!(r.port.resumes().len(), 1);
}

#[test]
fn a_reset_past_the_timer_ceiling_wakes_at_the_ceiling_then_resumes_once_at_the_true_time() {
    const CEILING_MS: u64 = 2_147_483_647;
    let r = rig();
    let far = START + 30 * 24 * HOUR;
    r.port.put(quota_row("run_a", far));
    r.quota.on_run_settled("run_a");
    assert_eq!(
        r.clock.delays(),
        vec![CEILING_MS],
        "the first wait is capped"
    );
    r.clock.advance_to(START + CEILING_MS);
    assert!(
        r.port.resumes().is_empty(),
        "the ceiling wake re-reads the row and re-arms, it does not resume"
    );
    r.clock
        .advance_to(far + WORKFLOW_QUOTA_RESUME_MARGIN_MS - 1);
    assert!(r.port.resumes().is_empty());
    r.clock.advance_to(far + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(
        r.port.resumes(),
        vec!["run_a".to_owned()],
        "once, at the true time"
    );
}

#[test]
fn a_row_changed_before_the_first_wake_resumes_once_at_the_new_time() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    // The row moves to a later reset time without a settlement: the timer armed for the old one wakes first.
    let moved = RESET + 3 * HOUR;
    r.port.put(quota_row("run_a", moved));
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert!(r.port.resumes().is_empty(), "no resume at the old time");
    r.clock
        .advance_to(moved + WORKFLOW_QUOTA_RESUME_MARGIN_MS - 1);
    assert!(r.port.resumes().is_empty());
    r.clock.advance_to(moved + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(r.port.resumes().len(), 1, "one resume, at the new time");
}

#[test]
fn a_quota_stop_with_a_reset_time_resumes_at_reset_plus_one_minute() {
    assert_eq!(
        quota_resume_at(&quota_row("run_a", RESET)),
        Some(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS)
    );
}

#[test]
fn only_a_provider_quota_stop_with_a_reset_time_has_a_resume_time() {
    // Not stopped on the provider.
    let running = row("run_a", RunStatus::Running, None, None);
    assert_eq!(quota_resume_at(&running), None);
    // Stopped by the user.
    let user = row(
        "run_a",
        RunStatus::Stopped,
        Some(StopReason::User),
        quota_row("run_a", RESET).failure,
    );
    assert_eq!(quota_resume_at(&user), None);
    // A provider stop of another kind (an exhausted balance has no reset time and is never resumed).
    let other = row(
        "run_a",
        RunStatus::Stopped,
        Some(StopReason::Provider),
        Some(json!({ "providerStop": { "kind": "other" } })),
    );
    assert_eq!(quota_resume_at(&other), None);
    // A quota stop without a reset time.
    let no_reset = row(
        "run_a",
        RunStatus::Stopped,
        Some(StopReason::Provider),
        Some(json!({ "providerStop": { "kind": "quota" } })),
    );
    assert_eq!(quota_resume_at(&no_reset), None);
}

#[test]
fn a_quota_stop_resumes_once_at_reset_plus_one_minute() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    r.clock
        .advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS - 1);
    assert!(r.port.resumes().is_empty(), "not a moment early");
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(r.port.resumes(), vec!["run_a".to_owned()]);
    r.clock.advance(10 * HOUR);
    assert_eq!(r.port.resumes().len(), 1, "one resume, not a loop");
}

#[test]
fn a_run_resumed_by_hand_before_its_timer_is_left_alone() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    // The user resumed it, and it is running again: the row is no longer a quota stop.
    r.port.put(row("run_a", RunStatus::Running, None, None));
    r.clock.advance_to(RESET + HOUR);
    assert!(r.port.resumes().is_empty());
}

#[test]
fn a_reset_time_that_moved_is_armed_again_at_the_new_time() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    let moved = RESET + HOUR;
    r.port.put(quota_row("run_a", moved));
    r.quota.on_run_settled("run_a");
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert!(
        r.port.resumes().is_empty(),
        "the first timer is replaced; the new time is the one that counts"
    );
    r.clock.advance_to(moved + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(r.port.resumes(), vec!["run_a".to_owned()]);
}

#[test]
fn a_reset_time_that_does_not_move_is_not_resumed_again() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(r.port.resumes().len(), 1);
    // The resumed run stops again on the same reset time: this process does not resume it for that window again.
    r.quota.on_run_settled("run_a");
    r.clock.advance(5 * HOUR);
    assert_eq!(
        r.port.resumes().len(),
        1,
        "no loop on an unmoved reset time"
    );
    assert_eq!(r.clock.pending(), 0, "nothing is armed");
}

#[test]
fn repeated_auto_resumes_are_spaced_ten_minutes_then_doubling_to_an_hour() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    let first = RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS;
    r.clock.advance_to(first);
    assert_eq!(r.port.resumes().len(), 1);

    // The run stops again, with a reset time a few seconds away (a wrong Retry-After): the second resume waits for the
    // ten-minute spacing, not for the reset.
    r.port.put(quota_row("run_a", first + 5_000));
    r.quota.on_run_settled("run_a");
    r.clock.advance_to(first + 10 * MIN - 1);
    assert_eq!(
        r.port.resumes().len(),
        1,
        "spaced ten minutes after the first start"
    );
    r.clock.advance_to(first + 10 * MIN);
    assert_eq!(r.port.resumes().len(), 2);

    // The third waits twenty minutes after the second start.
    let second = first + 10 * MIN;
    r.port.put(quota_row("run_a", second + 5_000));
    r.quota.on_run_settled("run_a");
    r.clock.advance_to(second + 20 * MIN - 1);
    assert_eq!(r.port.resumes().len(), 2);
    r.clock.advance_to(second + 20 * MIN);
    assert_eq!(r.port.resumes().len(), 3);
}

#[test]
fn a_transient_refusal_is_retried_one_margin_later_at_most_twice() {
    let r = rig();
    for _ in 0..3 {
        r.port
            .answer(Ok(ResumeAnswer::Refused(Refusal::AlreadyRunning)));
    }
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    let first = RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS;
    r.clock.advance_to(first);
    assert_eq!(r.port.resumes().len(), 1);
    r.clock.advance(MIN);
    assert_eq!(r.port.resumes().len(), 2, "retried one margin later");
    r.clock.advance(MIN);
    assert_eq!(r.port.resumes().len(), 3, "the second retry");
    r.clock.advance(10 * HOUR);
    assert_eq!(r.port.resumes().len(), 3, "gave up after two retries");
}

#[test]
fn a_refusal_that_is_not_transient_is_not_retried() {
    let r = rig();
    r.port.answer(Ok(ResumeAnswer::Refused(Refusal::Other(
        "not_resumable".into(),
    ))));
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    r.clock.advance_to(RESET + HOUR);
    assert_eq!(r.port.resumes().len(), 1);
}

#[test]
fn a_thrown_resume_is_retried_at_the_margin() {
    let r = rig();
    r.port.answer(Err("the execution boundary closed".into()));
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(r.port.resumes().len(), 1);
    r.clock.advance(MIN);
    assert_eq!(
        r.port.resumes().len(),
        2,
        "the second attempt succeeded and stopped the retries"
    );
    r.clock.advance(10 * HOUR);
    assert_eq!(r.port.resumes().len(), 2);
}

#[test]
fn a_failed_journal_read_ends_the_attempt_without_resuming() {
    let r = rig();
    *r.port.read_error.lock().expect("read_error") = true;
    r.quota.on_run_settled("run_a");
    assert_eq!(
        r.clock.pending(),
        0,
        "nothing is armed when the row cannot be read"
    );
    r.clock.advance_to(RESET + HOUR);
    assert!(r.port.resumes().is_empty());
}

#[test]
fn dispose_cancels_the_pending_timer() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.quota.on_run_settled("run_a");
    r.quota.dispose();
    r.clock.advance_to(RESET + HOUR);
    assert!(r.port.resumes().is_empty(), "nothing resumes after dispose");
}

#[test]
fn the_session_scan_resumes_a_due_stop_now_and_arms_a_future_one() {
    let r = rig();
    let due = quota_row("run_due", START - HOUR);
    let later = quota_row("run_later", START + 3 * HOUR);
    // The session lists the rows, and the journal reads them back by run id.
    r.port.put(due.clone());
    r.port.put(later.clone());
    r.port.listed.lock().expect("listed").extend([due, later]);
    r.quota.scan();
    r.clock.advance_to(START);
    assert_eq!(r.port.resumes(), vec!["run_due".to_owned()]);
    r.clock
        .advance_to(START + 3 * HOUR + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(
        r.port.resumes(),
        vec!["run_due".to_owned(), "run_later".to_owned()]
    );
}

#[test]
fn a_refused_timer_is_not_waited_for_and_a_later_settlement_arms_again() {
    let r = rig();
    r.port.put(quota_row("run_a", RESET));
    r.clock.set_accepting(false);
    r.quota.on_run_settled("run_a");
    assert_eq!(r.clock.pending(), 0);
    r.clock.set_accepting(true);
    r.quota.on_run_settled("run_a");
    r.clock.advance_to(RESET + WORKFLOW_QUOTA_RESUME_MARGIN_MS);
    assert_eq!(r.port.resumes().len(), 1);
}
