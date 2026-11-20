//! `LiveRunGuard` and session residency (W6b part 6; spec section 9.15). The run is a fake, since the run service that
//! creates guards is W7. The owner tests attach a guard to a real `ActorDriverOwner` and settle it.
use crate::driver_owner::ActorDriverOwner;
use crate::driver_owner_tests::{Recording, config};
use crate::journal::MemoryJournal;
use crate::residency::{LiveRun, SessionResidency};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// A fake live run: counts its stops and signals the test that one arrived.
struct FakeRun {
    stops: AtomicUsize,
    signal: Sender<()>,
}

impl LiveRun for FakeRun {
    fn stop_interrupted(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
        let _ = self.signal.send(());
    }
}

fn fake_run() -> (Arc<FakeRun>, Receiver<()>) {
    let (signal, stops) = channel();
    (
        Arc::new(FakeRun {
            stops: AtomicUsize::new(0),
            signal,
        }),
        stops,
    )
}

#[test]
fn a_live_run_keeps_its_session_from_being_evicted() {
    let residency = SessionResidency::new();
    let (run, _stops) = fake_run();
    let guard = residency
        .acquire("ses_parent", "run_1", run)
        .expect("guard");
    assert!(
        !residency.try_evict("ses_parent"),
        "a live run blocks eviction"
    );
    drop(guard);
    assert!(
        residency.try_evict("ses_parent"),
        "a settled run releases the session"
    );
}

#[test]
fn a_session_with_two_live_runs_stays_resident_until_both_settle() {
    let residency = SessionResidency::new();
    let (first, _s1) = fake_run();
    let (second, _s2) = fake_run();
    let a = residency.acquire("ses_parent", "run_1", first).expect("a");
    let b = residency.acquire("ses_parent", "run_2", second).expect("b");
    drop(a);
    assert!(!residency.try_evict("ses_parent"));
    drop(b);
    assert!(residency.try_evict("ses_parent"));
}

#[test]
fn close_stops_every_live_run_as_interrupted_then_waits_for_their_settlement() {
    let residency = SessionResidency::new();
    let (first, first_stops) = fake_run();
    let (second, second_stops) = fake_run();
    let a = residency
        .acquire("ses_parent", "run_1", first.clone())
        .expect("a");
    let b = residency
        .acquire("ses_parent", "run_2", second.clone())
        .expect("b");
    // The fake runs settle a little after they are stopped, so the close has to wait for them.
    let settler = thread::spawn(move || {
        first_stops.recv().expect("first stop");
        second_stops.recv().expect("second stop");
        thread::sleep(Duration::from_millis(50));
        drop(a);
        drop(b);
    });
    let started = Instant::now();
    residency.close("ses_parent").expect("close");
    assert!(
        started.elapsed() >= Duration::from_millis(40),
        "close returned before the settlements"
    );
    assert_eq!(residency.live_runs("ses_parent"), 0);
    assert_eq!(first.stops.load(Ordering::SeqCst), 1);
    assert_eq!(second.stops.load(Ordering::SeqCst), 1);
    settler.join().expect("settler");
}

#[test]
fn closing_an_idle_session_returns_without_stopping_anything() {
    let residency = SessionResidency::new();
    residency.close("ses_idle").expect("close");
    assert_eq!(residency.live_runs("ses_idle"), 0);
}

#[test]
fn a_closed_session_refuses_a_new_guard() {
    let residency = SessionResidency::new();
    residency.close("ses_closed").expect("close");
    let (run, _stops) = fake_run();
    let error = residency
        .acquire("ses_closed", "run_late", run)
        .expect_err("a launch after close is refused");
    assert!(error.to_string().contains("closed"), "{error}");
}

#[test]
fn an_evicted_session_refuses_a_new_guard() {
    let residency = SessionResidency::new();
    assert!(residency.try_evict("ses_gone"));
    let (run, _stops) = fake_run();
    assert!(residency.acquire("ses_gone", "run_late", run).is_err());
}

#[test]
fn closing_one_session_does_not_wait_for_another_sessions_runs() {
    let residency = Arc::new(SessionResidency::new());
    let (run, _stops) = fake_run();
    let _held = residency
        .acquire("ses_busy", "run_1", run)
        .expect("guard on the other session");
    let (done, finished) = channel();
    thread::spawn(move || {
        residency.close("ses_idle").expect("close");
        let _ = done.send(());
    });
    finished
        .recv_timeout(Duration::from_secs(5))
        .expect("the idle session closes without waiting for the busy one");
}

#[test]
fn an_owner_run_holds_its_parent_session_until_it_settles() {
    let residency = SessionResidency::new();
    let sessions = Recording::default();
    let mut owner = ActorDriverOwner::new(config(), MemoryJournal::new(), sessions).expect("owner");
    let (run, _stops) = fake_run();
    owner.attach_residency(&residency, run).expect("attach");
    assert!(
        !residency.try_evict("ses_parent"),
        "the launch is residency-blocking work"
    );
    owner.complete(json!("done")).expect("complete");
    assert!(
        residency.try_evict("ses_parent"),
        "settlement releases the parent session"
    );
}

#[test]
fn a_run_that_settled_before_it_attached_takes_no_guard() {
    let residency = SessionResidency::new();
    let sessions = Recording::default();
    let mut owner = ActorDriverOwner::new(config(), MemoryJournal::new(), sessions).expect("owner");
    owner.complete(json!("done")).expect("complete");
    let (run, _stops) = fake_run();
    owner.attach_residency(&residency, run).expect("attach");
    assert!(residency.try_evict("ses_parent"));
}

#[test]
fn a_run_without_a_parent_session_cannot_attach() {
    let residency = SessionResidency::new();
    let sessions = Recording::default();
    let mut cfg = config();
    cfg.parent_session_id = None;
    let mut owner = ActorDriverOwner::new(cfg, MemoryJournal::new(), sessions).expect("owner");
    let (run, _stops) = fake_run();
    let error = owner
        .attach_residency(&residency, run)
        .expect_err("no parent, nothing to keep resident");
    assert!(error.to_string().contains("parent"), "{error}");
}

/// A run that never settles: the test holds its guard, so the close must give up at its bound and say what is stuck.
#[test]
fn a_close_that_cannot_finish_returns_an_error_naming_the_session_and_the_run() {
    let residency = SessionResidency::with_close_wait(Duration::from_millis(50));
    let (run, _stops) = fake_run();
    let _held = residency
        .acquire("ses_stuck", "run_stuck", run)
        .expect("guard");
    let error = residency
        .close("ses_stuck")
        .expect_err("the run never settles, so the close is bounded");
    let text = error.to_string();
    assert!(text.contains("ses_stuck"), "{text}");
    assert!(text.contains("run_stuck"), "{text}");
}

/// Repeated closes of a stuck session stop its run once: the ledger remembers which guards it has stopped.
#[test]
fn a_run_is_stopped_at_most_once_however_often_its_session_is_closed() {
    let residency = SessionResidency::with_close_wait(Duration::from_millis(20));
    let (run, _stops) = fake_run();
    let _held = residency
        .acquire("ses_once", "run_once", run.clone())
        .expect("guard");
    assert!(residency.close("ses_once").is_err());
    assert!(residency.close("ses_once").is_err());
    assert_eq!(run.stops.load(Ordering::SeqCst), 1);
}

/// A run whose stop asks the ledger to close its own session.
struct ReentrantRun {
    residency: Arc<SessionResidency>,
    outcome: Mutex<Option<String>>,
}

impl LiveRun for ReentrantRun {
    fn stop_interrupted(&self) {
        let outcome = match self.residency.close("ses_loop") {
            Ok(()) => "closed".to_owned(),
            Err(error) => error.to_string(),
        };
        *self.outcome.lock().expect("outcome") = Some(outcome);
    }
}

/// A stop cannot close its own session: the nested close is refused at once instead of waiting on itself.
#[test]
fn a_stop_cannot_close_its_own_session() {
    let residency = Arc::new(SessionResidency::with_close_wait(Duration::from_millis(20)));
    let run = Arc::new(ReentrantRun {
        residency: residency.clone(),
        outcome: Mutex::new(None),
    });
    let _held = residency
        .acquire("ses_loop", "run_loop", run.clone())
        .expect("guard");
    assert!(residency.close("ses_loop").is_err());
    let outcome = run
        .outcome
        .lock()
        .expect("outcome")
        .clone()
        .expect("the stop ran");
    assert!(outcome.contains("stop"), "{outcome}");
}

/// W7-6: a retire refuses a new guard at once, before any close has started to wait.
#[test]
fn retiring_a_session_refuses_a_new_guard_without_waiting() {
    let residency = SessionResidency::new();
    let _ticket = residency.begin_close("ses_retiring");
    let (run, _stops) = fake_run();
    assert!(residency.acquire("ses_retiring", "run_late", run).is_err());
}

/// W7-6: the sessions that hold a live run are listed in id order; a settled one is not.
#[test]
fn live_sessions_are_listed_in_id_order_and_settled_ones_are_not() {
    let residency = SessionResidency::new();
    let (b_run, _b) = fake_run();
    let (a_run, _a) = fake_run();
    let (settled, _s) = fake_run();
    let _b_guard = residency.acquire("ses_b", "run_b", b_run).expect("b");
    let _a_guard = residency.acquire("ses_a", "run_a", a_run).expect("a");
    let settled_guard = residency.acquire("ses_c", "run_c", settled).expect("c");
    drop(settled_guard);
    assert_eq!(residency.sessions_with_live_runs(), vec!["ses_a", "ses_b"]);
}

/// W7-6: the shutdown drain closes every session that holds a live run. The runs settle a little after their stop.
#[test]
fn drain_closes_every_session_with_a_live_run() {
    let residency = SessionResidency::with_close_wait(Duration::from_secs(5));
    let (first, first_stops) = fake_run();
    let (second, second_stops) = fake_run();
    let a = residency
        .acquire("ses_one", "run_1", first.clone())
        .expect("a");
    let b = residency
        .acquire("ses_two", "run_2", second.clone())
        .expect("b");
    // The drain closes one session at a time, so the second run is stopped only after the first has settled.
    let settler = thread::spawn(move || {
        first_stops.recv().expect("first stop");
        drop(a);
        second_stops.recv().expect("second stop");
        drop(b);
    });
    let errors = residency.drain();
    settler.join().expect("settler");
    assert!(errors.is_empty(), "{errors:?}");
    assert!(residency.sessions_with_live_runs().is_empty());
    assert_eq!(first.stops.load(Ordering::SeqCst), 1);
    assert_eq!(second.stops.load(Ordering::SeqCst), 1);
}

/// W7-6 (divergence 63): a closed session that is resumed in the same process accepts guards again.
#[test]
fn a_closed_session_accepts_guards_again_once_reopened() {
    let residency = SessionResidency::new();
    residency.close("ses_resumed").expect("close");
    assert!(residency.reopen("ses_resumed"), "no close is in flight");
    let (run, _stops) = fake_run();
    residency
        .acquire("ses_resumed", "run_resumed", run)
        .expect("a run attaches after the reopen");
    residency
        .close("ses_resumed")
        .expect("a later close retires it again");
    let (late, _late_stops) = fake_run();
    assert!(residency.acquire("ses_resumed", "run_late", late).is_err());
}

/// W7-6 (divergence 63): a reopen that arrives while a close is still waiting does not block and does not resurrect
/// the session early: it takes effect when that close ends. Until then the session refuses guards.
#[test]
fn a_reopen_during_an_in_flight_close_takes_effect_when_the_close_ends() {
    let residency = Arc::new(SessionResidency::with_close_wait(Duration::from_secs(5)));
    let (run, stops) = fake_run();
    let guard = residency.acquire("ses_busy", "run_1", run).expect("guard");
    let closer = residency.clone();
    let closing = thread::spawn(move || closer.close("ses_busy"));
    stops.recv().expect("the close stops the run");
    assert!(
        !residency.reopen("ses_busy"),
        "a reopen during a close is pending, not immediate"
    );
    let (early, _early_stops) = fake_run();
    assert!(
        residency.acquire("ses_busy", "run_early", early).is_err(),
        "the session still refuses guards while its close is in flight"
    );
    drop(guard);
    closing
        .join()
        .expect("close thread")
        .expect("the close finishes once the run settles");
    let (after, _after_stops) = fake_run();
    residency
        .acquire("ses_busy", "run_after", after)
        .expect("the pending reopen took effect when the close ended");
}

/// W7-6: the drain has one bound for the whole shutdown. A run that never settles is reported by name, and a session
/// after it in the drain does not get a second full wait.
#[test]
fn drain_is_bounded_as_a_whole_and_names_the_stuck_runs() {
    let residency = SessionResidency::with_close_wait(Duration::from_millis(100));
    let (stuck, _s1) = fake_run();
    let (also_stuck, _s2) = fake_run();
    let _held = residency
        .acquire("ses_stuck", "run_stuck", stuck)
        .expect("a");
    let _held_too = residency
        .acquire("ses_later", "run_later", also_stuck)
        .expect("b");
    let started = Instant::now();
    let errors = residency.drain();
    assert!(
        started.elapsed() < Duration::from_millis(400),
        "the drain waited more than its bound: {:?}",
        started.elapsed()
    );
    let text = errors
        .iter()
        .map(|error| format!("{error:#}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("run_stuck"), "{text}");
    assert!(text.contains("run_later"), "{text}");
    // W7-6 review D: the drain visits sessions in id order, so `ses_stuck` is reached after `ses_later` has spent the
    // bound. It did not wait at all, and the message says so instead of reporting a wait of the full bound.
    let reached_late = errors
        .iter()
        .map(|error| format!("{error:#}"))
        .find(|text| text.contains("run_stuck"))
        .expect("the session reached after the bound is reported");
    assert!(reached_late.contains("bound was spent"), "{reached_late}");
    assert!(!reached_late.contains("still live after"), "{reached_late}");
}

/// W7-6 review A: a close begun on the async thread is registered with its retire, so a reopen before the close's job
/// runs is pending, and the session stays refused until that close ends.
#[test]
fn a_reopen_before_a_begun_close_runs_is_pending() {
    let residency = SessionResidency::new();
    let ticket = residency.begin_close("ses_gap");
    assert!(
        !residency.reopen("ses_gap"),
        "the close is registered, so the reopen waits"
    );
    let (run, _stops) = fake_run();
    assert!(residency.acquire("ses_gap", "run_gap", run).is_err());
    ticket.run().expect("the close finishes");
    let (after, _after_stops) = fake_run();
    residency
        .acquire("ses_gap", "run_after", after)
        .expect("the pending reopen applies when the close ends");
}

/// W7-6 review A: a delayed close job that runs after a full close and reopen cycle does not re-retire the session.
#[test]
fn a_delayed_close_job_does_not_retire_a_session_reopened_after_it_began() {
    let residency = SessionResidency::new();
    let delayed = residency.begin_close("ses_cycle");
    residency
        .begin_close("ses_cycle")
        .run()
        .expect("the second close finishes");
    assert!(
        !residency.reopen("ses_cycle"),
        "the delayed close is still in flight"
    );
    delayed.run().expect("the delayed job finishes");
    let (run, _stops) = fake_run();
    residency
        .acquire("ses_cycle", "run_cycle", run)
        .expect("the session stays open after the delayed job");
}

/// W7-6 review B: a close begun after a pending reopen supersedes it, so the reopen is not applied at the end.
#[test]
fn a_close_begun_after_a_pending_reopen_supersedes_it() {
    let residency = SessionResidency::new();
    let first = residency.begin_close("ses_super");
    assert!(!residency.reopen("ses_super"));
    let second = residency.begin_close("ses_super");
    drop(first);
    second.run().expect("the close finishes");
    let (run, _stops) = fake_run();
    assert!(residency.acquire("ses_super", "run_super", run).is_err());
}

/// W7-6 review C: a close that gives up on stuck runs still lets a reopen in flight take effect. The user's resume
/// wins; the stuck runs are reported by the close's error.
#[test]
fn a_reopen_during_a_close_that_gives_up_takes_effect_when_it_ends() {
    let residency = Arc::new(SessionResidency::with_close_wait(Duration::from_millis(
        100,
    )));
    let (run, stops) = fake_run();
    let _held = residency
        .acquire("ses_gave_up", "run_stuck", run)
        .expect("guard");
    let closer = residency.clone();
    let closing = thread::spawn(move || closer.close("ses_gave_up"));
    stops.recv().expect("the close stops the run");
    assert!(
        !residency.reopen("ses_gave_up"),
        "pending while the close runs"
    );
    let error = closing
        .join()
        .expect("close thread")
        .expect_err("the run never settles");
    assert!(format!("{error:#}").contains("run_stuck"));
    let (after, _after_stops) = fake_run();
    residency
        .acquire("ses_gave_up", "run_after", after)
        .expect("the reopen applies even though the close gave up");
}
