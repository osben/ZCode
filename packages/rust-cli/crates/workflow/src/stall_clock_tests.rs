//! W6b part 5: the run-level stall clock (Node `workflow-driver-concurrency.test.ts`, the `createRunStallClock` cases).
//! The clock is driven by hand: `serve_due` runs the jobs the clock has due, then calls `fire` for each generation
//! they posted, as the owner does on its own thread.

use crate::stall_clock::{RunStallClock, RunStallInfo, WORKFLOW_STALL_NOTIFY_AFTER_MS};
use crate::test_clock::AdvancingClock;
use std::sync::{Arc, Mutex};

const MIN: u64 = 60_000;
/// 2026-10-15T08:00:00Z, the clock's start.
const START: u64 = 1_792_051_200_000;

struct Harness {
    clock: Arc<AdvancingClock>,
    stall: RunStallClock,
    posted: Arc<Mutex<Vec<u64>>>,
}

fn harness() -> Harness {
    let clock = AdvancingClock::new(START);
    let posted = Arc::new(Mutex::new(Vec::new()));
    let sink = posted.clone();
    let stall = RunStallClock::new(
        clock.clone(),
        Arc::new(move |generation| sink.lock().expect("posted").push(generation)),
    );
    Harness {
        clock,
        stall,
        posted,
    }
}

impl Harness {
    /// Advances the clock to `at`, then serves every posted generation. Returns the notices the owner would record.
    fn serve_until(&self, at: u64) -> Vec<RunStallInfo> {
        self.clock.advance_to(at);
        // The jobs only record their generation; firing them does not post again, so the lock is never re-entered.
        let mut posted = self.posted.lock().expect("posted");
        posted
            .drain(..)
            .filter_map(|generation| self.stall.fire(generation))
            .collect()
    }
}

#[test]
fn the_notify_window_is_twenty_minutes() {
    assert_eq!(WORKFLOW_STALL_NOTIFY_AFTER_MS, 20 * MIN);
}

#[test]
fn a_retry_with_no_success_for_twenty_minutes_fires_once_with_its_reason() {
    let h = harness();
    h.stall.note_retry_scheduled("rate_limited");
    assert!(
        h.serve_until(START + 20 * MIN - 1).is_empty(),
        "nothing before the window closes"
    );
    let notices = h.serve_until(START + 20 * MIN);
    assert_eq!(
        notices,
        vec![RunStallInfo {
            since_ms: 20 * MIN,
            reason: Some("rate_limited".into()),
            cap: None,
        }]
    );
}

#[test]
fn no_retry_armed_means_no_timer_and_no_notice() {
    let h = harness();
    h.clock.advance(60 * MIN);
    assert_eq!(
        h.clock.pending(),
        0,
        "a run that never retried arms nothing"
    );
    assert!(h.serve_until(START + 120 * MIN).is_empty());
}

#[test]
fn a_success_before_the_window_cancels_the_notice() {
    let h = harness();
    h.stall.note_retry_scheduled("rate_limited");
    assert!(h.serve_until(START + 10 * MIN).is_empty());
    h.stall.note_success();
    // The armed timer still wakes at the old window, but its generation is no longer armed.
    assert!(h.serve_until(START + 20 * MIN).is_empty());
}

#[test]
fn a_success_clears_the_period_so_a_later_stall_notifies_again() {
    let h = harness();
    h.stall.note_retry_scheduled("rate_limited");
    assert_eq!(h.serve_until(START + 20 * MIN).len(), 1);
    // The same stall period notifies once: more retries inside it do not arm again.
    h.stall.note_retry_scheduled("rate_limited");
    assert!(h.serve_until(START + 40 * MIN).is_empty());
    // A success starts a new period; the next retry arms and notifies once more.
    h.stall.note_success();
    h.stall.note_retry_scheduled("overloaded");
    let notices = h.serve_until(START + 60 * MIN);
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].reason.as_deref(), Some("overloaded"));
    // Its since is measured from the success, not from the first stall.
    assert_eq!(notices[0].since_ms, 20 * MIN);
}

#[test]
fn the_dominant_reason_is_the_most_frequent_and_the_first_seen_breaks_a_tie() {
    let h = harness();
    h.stall.note_retry_scheduled("a");
    h.stall.note_retry_scheduled("b");
    h.stall.note_retry_scheduled("b");
    h.stall.note_retry_scheduled("a");
    h.stall.note_retry_scheduled("b");
    assert_eq!(
        h.serve_until(START + 20 * MIN)[0].reason.as_deref(),
        Some("b")
    );

    let tie = harness();
    tie.stall.note_retry_scheduled("a");
    tie.stall.note_retry_scheduled("b");
    assert_eq!(
        tie.serve_until(START + 20 * MIN)[0].reason.as_deref(),
        Some("a")
    );
}

#[test]
fn the_last_cap_seen_is_carried_in_the_notice() {
    let h = harness();
    h.stall.note_cap(8);
    h.stall.note_cap(2);
    h.stall.note_retry_scheduled("rate_limited");
    assert_eq!(h.serve_until(START + 20 * MIN)[0].cap, Some(2));
}

#[test]
fn a_timer_that_wakes_early_re_arms_for_the_rest_of_the_window() {
    let h = harness();
    h.stall.note_retry_scheduled("rate_limited");
    let armed = h.stall.armed_for_test().expect("a timer is armed");
    h.clock.advance(MIN);
    // Woken at minute one, before the window: nothing is notified, and the same period waits for the remainder.
    assert!(h.stall.fire(armed).is_none());
    assert_eq!(*h.clock.delays().last().expect("a re-arm"), 19 * MIN);
    let rearmed = h.stall.armed_for_test().expect("re-armed");
    assert_ne!(rearmed, armed, "the re-arm takes a new generation");
    // The old generation is stale now; only the re-armed one notifies, at the window.
    assert!(h.stall.fire(armed).is_none());
    let notices = h.serve_until(START + 20 * MIN);
    assert_eq!(notices.len(), 1, "the notice fires once at the window");
}

#[test]
fn a_refused_timer_leaves_the_clock_unarmed_so_a_later_retry_arms_it() {
    let h = harness();
    h.clock.set_accepting(false);
    h.stall.note_retry_scheduled("rate_limited");
    assert_eq!(h.clock.pending(), 0, "the refused job is not queued");
    h.clock.set_accepting(true);
    h.stall.note_retry_scheduled("rate_limited");
    assert_eq!(h.clock.pending(), 1, "the next retry arms the clock again");
    assert_eq!(h.serve_until(START + 20 * MIN).len(), 1);
}

#[test]
fn dispose_cancels_the_armed_timer_and_nothing_fires_after_it() {
    let h = harness();
    h.stall.note_retry_scheduled("rate_limited");
    h.stall.dispose();
    assert!(h.serve_until(START + 60 * MIN).is_empty());
    // The job armed before the dispose already ran (and posted nothing useful). A disposed clock arms nothing more.
    h.stall.note_retry_scheduled("rate_limited");
    assert_eq!(h.clock.pending(), 0, "a disposed clock arms nothing more");
    assert!(h.serve_until(START + 120 * MIN).is_empty());
}
