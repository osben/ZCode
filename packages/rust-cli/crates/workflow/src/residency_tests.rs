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
