//! The session close chain after a run settles (W6b part 6; Node driver tests rows 31-36 in
//! `apps/zcode-cli/packages/bootstrap/tests/workflow-driver.test.ts`). Each owner session is handed to the close port
//! once, when the engine disposes the driver. Waiting for an in-flight turn is the turn side's job: the
//! `actor_turns_close_tests` cases cover it.
//!
//! A session exists once its actor has asked (Rust creates it at the first ask, as Node does). An untyped `plain` ask
//! ends its turn with a text result, so the session is idle; a turn left running is in flight.
use crate::driver_owner::ActorDriverOwner;
use crate::driver_owner_tests::{Recording, config};
use crate::engine::{RunSettlement, WorkflowDriver};
use crate::journal::MemoryJournal;
use crate::model::Ref;
use serde_json::json;

fn owner_with(sessions: &Recording) -> ActorDriverOwner<MemoryJournal, Recording> {
    ActorDriverOwner::new(config(), MemoryJournal::new(), sessions.clone()).expect("owner")
}

/// Creates an actor and asks it once, returning its session. With `finish`, the turn ends with its text, so the ask
/// settles and the session is idle.
fn start_actor(
    owner: &mut ActorDriverOwner<MemoryJournal, Recording>,
    sessions: &Recording,
    name: &str,
    finish: bool,
) -> String {
    let actor = owner
        .create_actor("plain", Some(name), None)
        .expect("actor");
    owner.ask("plain", &actor, "go").expect("ask");
    owner.drain().expect("drain");
    let session = owner
        .session_of(&actor)
        .expect("the ask created the session");
    assert!(
        sessions
            .0
            .borrow()
            .turns
            .iter()
            .any(|turn| turn.0 == session),
        "the ask's turn started"
    );
    if finish {
        owner
            .turn_ended(&session, "finished")
            .expect("the untyped ask settles on its text");
    }
    session
}

/// Row 31: an idle session is closed at once, before the settlement returns.
#[test]
fn row_31_an_idle_session_is_closed_at_once_when_the_run_settles() {
    let sessions = Recording::default();
    let mut owner = owner_with(&sessions);
    let session = start_actor(&mut owner, &sessions, "worker", true);
    owner.complete(json!("done")).expect("complete");
    assert_eq!(sessions.0.borrow().closed, vec![session]);
}

/// Row 32 (owner side): a session whose turn the settlement cancelled is still handed to the close port. The turn side
/// holds the close until the turn lands.
#[test]
fn row_32_a_session_with_a_turn_in_flight_is_handed_to_the_close_port_after_its_cancel() {
    let sessions = Recording::default();
    let mut owner = owner_with(&sessions);
    let session = start_actor(&mut owner, &sessions, "worker", false);
    owner.complete(json!("done")).expect("complete");
    assert_eq!(
        sessions.0.borrow().cancelled.len(),
        1,
        "settlement cancelled the turn"
    );
    assert_eq!(sessions.0.borrow().closed, vec![session]);
}

/// Row 33: nothing new is accepted once the driver is disposed, and nothing is created for the refused actor. (Node's
/// late instance cannot arise here: the Rust create is synchronous on the owner's thread.)
#[test]
fn row_33_a_disposed_driver_refuses_a_session_and_creates_nothing() {
    let sessions = Recording::default();
    let mut owner = owner_with(&sessions);
    start_actor(&mut owner, &sessions, "first", true);
    owner.complete(json!("done")).expect("complete");
    let created_before = sessions.0.borrow().created.len();
    let late = Ref::new("plain", 2);
    let error = owner
        .driver_for_test()
        .create_actor_session(&late, &json!({}), None)
        .expect_err("a closed driver refuses a session");
    assert!(error.to_string().contains("closed"), "{error}");
    assert_eq!(sessions.0.borrow().created.len(), created_before);
}

/// Row 34: disposing twice closes each runtime once.
#[test]
fn row_34_disposing_twice_closes_each_session_once() {
    let sessions = Recording::default();
    let mut owner = owner_with(&sessions);
    start_actor(&mut owner, &sessions, "worker", true);
    owner.complete(json!("done")).expect("complete");
    owner.driver_for_test().dispose();
    owner.driver_for_test().dispose();
    assert_eq!(sessions.0.borrow().closed.len(), 1);
}

/// Row 35: a failed close is recorded, and the settlement does not fail.
#[test]
fn row_35_a_failed_close_is_recorded_and_the_settlement_does_not_throw() {
    let sessions = Recording::default();
    let mut owner = owner_with(&sessions);
    let session = start_actor(&mut owner, &sessions, "worker", true);
    sessions.0.borrow_mut().fail_next_close = true;
    owner
        .complete(json!("done"))
        .expect("settlement does not throw on a failed close");
    assert!(matches!(
        owner.settlement(),
        Some(RunSettlement::Completed { .. })
    ));
    let failures = owner.take_close_failures();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(failures[0].0, session);
    assert!(
        failures[0].1.contains("close refused"),
        "the cause is kept: {}",
        failures[0].1
    );
    assert!(
        owner.take_close_failures().is_empty(),
        "taking the failures drains them"
    );
}

/// Row 36: in the pipeline each actor's runtime is closed exactly once after settlement. (The GC half has no Rust
/// counterpart and is not carried.)
#[test]
fn row_36_the_pipeline_closes_each_actor_session_exactly_once() {
    let sessions = Recording::default();
    let mut owner = owner_with(&sessions);
    let mut expected = vec![
        start_actor(&mut owner, &sessions, "first", true),
        start_actor(&mut owner, &sessions, "second", true),
    ];
    owner.complete(json!("done")).expect("complete");
    let mut closed = sessions.0.borrow().closed.clone();
    closed.sort();
    expected.sort();
    assert_eq!(closed, expected);
}
