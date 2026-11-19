//! The owner's side of the process-level governor (W6b part 2b): the run's bound (Node `setRunBound` at launch and on a
//! retune), its subscription to cap changes (Node `subscribe`, journaled as `concurrency-changed`), and the release when
//! the link ends (settlement, a re-attach, or the owner being dropped). The port is a recording fake: the governor itself
//! is tested in the model crate.
use crate::actor_mailbox::ActorMailbox;
use crate::driver_owner::ActorDriverOwner;
use crate::driver_owner_tests::{Recording as Sessions, config, owner};
use crate::journal::MemoryJournal;
use crate::model::{ConcurrencyChange, StoredEvent};
use crate::run_concurrency::{ConcurrencyListener, RunConcurrency};
use serde_json::json;
use std::sync::{Arc, Mutex};

/// What the port was asked, in order, and the listeners still subscribed (by subscription number).
#[derive(Default)]
struct Calls {
    log: Mutex<Vec<String>>,
    listeners: Mutex<Vec<(u64, ConcurrencyListener)>>,
    next: Mutex<u64>,
}

struct Recording(Arc<Calls>);

impl RunConcurrency for Recording {
    fn set_run_bound(&self, run_id: &str, bound: u64) {
        self.0
            .log
            .lock()
            .expect("log")
            .push(format!("bound {run_id} {bound}"));
    }

    fn clear_run_bound(&self, run_id: &str) {
        self.0
            .log
            .lock()
            .expect("log")
            .push(format!("clear {run_id}"));
    }

    fn subscribe(&self, run_id: &str, listener: ConcurrencyListener) -> Box<dyn FnOnce() + Send> {
        self.0
            .log
            .lock()
            .expect("log")
            .push(format!("subscribe {run_id}"));
        let id = {
            let mut next = self.0.next.lock().expect("next");
            *next += 1;
            *next
        };
        self.0
            .listeners
            .lock()
            .expect("listeners")
            .push((id, listener));
        let calls = self.0.clone();
        Box::new(move || {
            calls
                .log
                .lock()
                .expect("log")
                .push("unsubscribe".to_owned());
            calls
                .listeners
                .lock()
                .expect("listeners")
                .retain(|(kept, _)| *kept != id);
        })
    }
}

fn log(calls: &Calls) -> Vec<String> {
    calls.log.lock().expect("log").clone()
}

/// The governor fans a change out to every listener still subscribed, on its own thread; the test calls them directly.
fn fire(calls: &Calls, change: &ConcurrencyChange) {
    for (_, listener) in calls.listeners.lock().expect("listeners").iter() {
        listener(change);
    }
}

fn change() -> ConcurrencyChange {
    ConcurrencyChange {
        key: "p/m".into(),
        previous: 8,
        next: 4,
        reason: "rate_limited".into(),
        last_good: Some(4),
        last_bad: None,
        cooldown_ms: Some(20_000),
    }
}

fn concurrency_events(events: &[StoredEvent]) -> Vec<String> {
    events
        .iter()
        .map(|event| event.payload_json.clone())
        .filter(|text| text.starts_with(r#"{"type":"concurrency-changed""#))
        .collect()
}

#[test]
fn attaching_binds_the_run_to_its_cap_and_subscribes_once() {
    let (mut owner, _sessions) = owner();
    let calls = Arc::new(Calls::default());
    let (_mailbox, handle) = ActorMailbox::new();
    owner.attach_concurrency(Arc::new(Recording(calls.clone())), handle);
    assert_eq!(log(&calls), vec!["bound run_1 4", "subscribe run_1"]);
}

#[test]
fn a_retune_rebinds_the_run_with_the_new_cap() {
    let (mut owner, _sessions) = owner();
    let calls = Arc::new(Calls::default());
    let (_mailbox, handle) = ActorMailbox::new();
    owner.attach_concurrency(Arc::new(Recording(calls.clone())), handle);
    owner.set_max_concurrency(6.0).expect("retune");
    assert_eq!(
        log(&calls),
        vec!["bound run_1 4", "subscribe run_1", "bound run_1 6"]
    );
}

#[test]
fn a_cap_change_reaches_the_journal_through_the_mailbox() {
    let (mut owner, _sessions) = owner();
    let calls = Arc::new(Calls::default());
    let (mailbox, handle) = ActorMailbox::new();
    owner.attach_concurrency(Arc::new(Recording(calls.clone())), handle);
    fire(&calls, &change());
    mailbox.serve_next(&mut owner).expect("serve the change");
    let events = owner.events().expect("events");
    assert_eq!(
        concurrency_events(&events),
        vec![
            r#"{"type":"concurrency-changed","key":"p/m","previous":8,"next":4,"reason":"rate_limited","lastGood":4,"cooldownMs":20000}"#
                .to_owned()
        ]
    );
}

#[test]
fn settling_releases_the_subscription_and_the_bound_and_later_changes_are_ignored() {
    let (mut owner, _sessions) = owner();
    let calls = Arc::new(Calls::default());
    let (mailbox, handle) = ActorMailbox::new();
    owner.attach_concurrency(Arc::new(Recording(calls.clone())), handle);
    owner.complete(json!("done")).expect("complete");
    assert_eq!(
        log(&calls),
        vec![
            "bound run_1 4",
            "subscribe run_1",
            "unsubscribe",
            "clear run_1"
        ],
        "the subscription ends before the bound is cleared, and both happen once"
    );

    // The subscription is gone, so a change after settlement reaches no listener and journals nothing.
    fire(&calls, &change());
    assert!(
        mailbox.try_take().is_none(),
        "no listener is left to post a late change"
    );
    assert!(concurrency_events(&owner.events().expect("events")).is_empty());
    assert_eq!(log(&calls).len(), 4, "a settled run is not released twice");
}

/// The owner ends without settling (a closed mailbox, a host teardown): dropping it still ends the subscription and clears
/// the bound, so the governor does not keep the run's bound or listener.
#[test]
fn dropping_the_owner_without_settling_releases_the_run() {
    let calls = Arc::new(Calls::default());
    {
        let (mut owner, _sessions) = owner();
        let (_mailbox, handle) = ActorMailbox::new();
        owner.attach_concurrency(Arc::new(Recording(calls.clone())), handle);
    }
    assert_eq!(
        log(&calls),
        vec![
            "bound run_1 4",
            "subscribe run_1",
            "unsubscribe",
            "clear run_1"
        ]
    );
    assert!(
        calls.listeners.lock().expect("listeners").is_empty(),
        "no listener is left subscribed"
    );
}

/// Attaching again releases the first link: its subscription ends and its bound is cleared before the new bound is set,
/// so a change is heard by one listener only and journaled once.
#[test]
fn attaching_again_releases_the_first_link_and_a_change_is_journaled_once() {
    let (mut owner, _sessions) = owner();
    let calls = Arc::new(Calls::default());
    let (mailbox, handle) = ActorMailbox::new();
    owner.attach_concurrency(Arc::new(Recording(calls.clone())), handle.clone());
    owner.attach_concurrency(Arc::new(Recording(calls.clone())), handle);
    assert_eq!(
        log(&calls),
        vec![
            "bound run_1 4",
            "subscribe run_1",
            "unsubscribe",
            "clear run_1",
            "bound run_1 4",
            "subscribe run_1",
        ]
    );

    fire(&calls, &change());
    mailbox.serve_next(&mut owner).expect("serve the change");
    assert!(
        mailbox.try_take().is_none(),
        "the first listener posted nothing"
    );
    assert_eq!(
        concurrency_events(&owner.events().expect("events")).len(),
        1
    );
}

/// Node's bound is the cap floored, and a run is never bound below 1 (the engine floors and raises its cap the same way).
#[test]
fn a_fractional_cap_binds_its_floor_and_never_less_than_one() {
    let mut cfg = config();
    cfg.caps.max_concurrency = 0.5;
    let mut owner =
        ActorDriverOwner::new(cfg, MemoryJournal::new(), Sessions::default()).expect("owner");
    let calls = Arc::new(Calls::default());
    let (_mailbox, handle) = ActorMailbox::new();
    owner.attach_concurrency(Arc::new(Recording(calls.clone())), handle);
    assert_eq!(log(&calls), vec!["bound run_1 1", "subscribe run_1"]);
}
