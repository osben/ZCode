//! `LiveRunGuard` and session residency (W6b part 6; spec section 9.15). The run is a fake, since the run service that
//! creates guards is W7. The owner tests attach a guard to a real `ActorDriverOwner` and settle it.
use crate::driver_owner::ActorDriverOwner;
use crate::driver_owner_tests::{Recording, config};
use crate::journal::MemoryJournal;
use crate::residency::{LiveRun, SessionResidency};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
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
