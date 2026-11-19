//! The owner's side of the process-level governor (W6b part 2b): the run's bound (Node `setRunBound` at launch and on a
//! retune), its subscription to cap changes (Node `subscribe`, journaled as `concurrency-changed`), and the release at
//! settlement (Node `clearRunBound` and the unsubscribe at dispose). The port is a recording fake: the governor itself is
//! tested in the model crate.
use crate::actor_mailbox::ActorMailbox;
use crate::driver_owner_tests::owner;
use crate::model::ConcurrencyChange;
use crate::run_concurrency::{ConcurrencyListener, RunConcurrency};
use serde_json::json;
use std::sync::{Arc, Mutex};

/// What the port was asked, in order, and the listener the owner subscribed.
#[derive(Default)]
struct Calls {
    log: Mutex<Vec<String>>,
    listener: Mutex<Option<ConcurrencyListener>>,
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
        *self.0.listener.lock().expect("listener") = Some(listener);
        let calls = self.0.clone();
        Box::new(move || {
            calls
                .log
                .lock()
                .expect("log")
                .push("unsubscribe".to_owned());
        })
    }
}

fn log(calls: &Calls) -> Vec<String> {
    calls.log.lock().expect("log").clone()
}

/// The governor fans a change out to the listener on its own thread; the test calls it directly.
fn fire(calls: &Calls, change: &ConcurrencyChange) {
    let listener = calls.listener.lock().expect("listener");
    let listener = listener.as_ref().expect("the owner subscribed");
    listener(change);
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

fn concurrency_events(events: &[crate::model::StoredEvent]) -> Vec<String> {
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

    // A change that still arrives after settlement is taken off the mailbox and journals nothing.
    fire(&calls, &change());
    mailbox
        .serve_next(&mut owner)
        .expect("serve the late change");
    assert!(concurrency_events(&owner.events().expect("events")).is_empty());
    assert_eq!(log(&calls).len(), 4, "a settled run is not released twice");
}
