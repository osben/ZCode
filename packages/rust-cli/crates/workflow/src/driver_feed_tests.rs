//! The turn side's feed into the owner, and the run's `LiveRun` over the mailbox (W7-3; spec 9.12 item 2, 9.14
//! divergences 36 and 39, 9.15 item 1).
use crate::actor_feed::FeedEvent;
use crate::actor_mailbox::{ActorMailbox, MailboxRun};
use crate::driver_owner::ActorDriverOwner;
use crate::driver_owner_tests::{Recording, config};
use crate::engine::{AskStats, RunSettlement};
use crate::event::LastTool;
use crate::journal::MemoryJournal;
use crate::model::{AskWait, Ref, StopReason};
use crate::residency::LiveRun;
use crate::residency::SessionResidency;
use serde_json::json;
use std::sync::Arc;

type Owner = ActorDriverOwner<MemoryJournal, Recording>;

pub(crate) fn new_owner() -> (Owner, Recording) {
    let sessions = Recording::default();
    let owner =
        ActorDriverOwner::new(config(), MemoryJournal::new(), sessions.clone()).expect("owner");
    (owner, sessions)
}

/// Creates an actor, asks it once and leaves its turn running. Returns the session and the ask's instance.
pub(crate) fn start_ask(owner: &mut Owner, sessions: &Recording) -> (String, Ref) {
    let actor = owner
        .create_actor("plain", Some("worker"), None)
        .expect("actor");
    owner.ask("plain", &actor, "go").expect("ask");
    owner.drain().expect("drain");
    let session = owner
        .session_of(&actor)
        .expect("the ask created the session");
    let instance = sessions
        .0
        .borrow()
        .turns
        .iter()
        .find(|turn| turn.0 == session)
        .map(|turn| turn.1.clone())
        .expect("the ask's turn started");
    (session, instance)
}

fn payloads(owner: &Owner) -> Vec<String> {
    owner
        .events()
        .expect("events")
        .into_iter()
        .map(|event| event.payload_json)
        .collect()
}

pub(crate) fn count_of(owner: &Owner, kind: &str) -> usize {
    payloads(owner)
        .iter()
        .filter(|payload| payload.contains(&format!("\"{kind}\"")))
        .count()
}

/// Node `askWaiting`: a fed wait on a live ask is journaled as `node-waiting`.
#[test]
fn a_fed_wait_is_journaled_for_the_live_ask() {
    let (mut owner, sessions) = new_owner();
    let (session, _) = start_ask(&mut owner, &sessions);
    owner
        .feed(&session, FeedEvent::Waiting(AskWait::slot()))
        .expect("feed");
    assert_eq!(count_of(&owner, "node-waiting"), 1);
}

/// Node `askExecuting`: the executing transition is journaled as `node-executing`.
#[test]
fn a_fed_execution_is_journaled_for_the_live_ask() {
    let (mut owner, sessions) = new_owner();
    let (session, _) = start_ask(&mut owner, &sessions);
    owner.feed(&session, FeedEvent::Executing).expect("feed");
    assert_eq!(count_of(&owner, "node-executing"), 1);
}

/// Node `lastTool`: the last tool the ask started is carried on the next `node-progress` of the ask.
#[test]
fn the_last_fed_tool_is_on_the_next_node_progress() {
    let (mut owner, sessions) = new_owner();
    let (session, instance) = start_ask(&mut owner, &sessions);
    owner
        .feed(
            &session,
            FeedEvent::LastTool(LastTool {
                name: "Read".to_owned(),
                target: Some("a.rs".to_owned()),
            }),
        )
        .expect("feed");
    owner
        .ask_stats(
            &instance,
            AskStats {
                tokens: 1.0,
                tool_calls: 2.0,
                turns: 1.0,
                world_tool_calls: None,
            },
        )
        .expect("stats");
    let progress = payloads(&owner)
        .into_iter()
        .find(|payload| payload.contains("\"node-progress\""))
        .expect("a node-progress event");
    assert!(progress.contains("\"lastTool\""), "{progress}");
    assert!(progress.contains("Read"), "{progress}");
    assert!(progress.contains("a.rs"), "{progress}");
}

/// A feed for a session with no ask in flight changes nothing and is not an error.
#[test]
fn a_feed_for_a_session_without_an_ask_is_ignored() {
    let (mut owner, sessions) = new_owner();
    start_ask(&mut owner, &sessions);
    let before = payloads(&owner).len();
    owner
        .feed("sess_unknown", FeedEvent::Executing)
        .expect("feed");
    assert_eq!(payloads(&owner).len(), before);
}

/// Node drops observations after settlement: a late wait journals nothing.
#[test]
fn a_feed_after_settlement_is_dropped() {
    let (mut owner, sessions) = new_owner();
    let (session, _) = start_ask(&mut owner, &sessions);
    owner
        .turn_ended(&session, "finished")
        .expect("the untyped ask settles");
    owner.complete(json!("done")).expect("complete");
    let before = payloads(&owner).len();
    owner
        .feed(&session, FeedEvent::Waiting(AskWait::slot()))
        .expect("feed after settlement");
    assert_eq!(payloads(&owner).len(), before);
}

/// The run's stop (W6b part 6, the `LiveRun` port): the owner settles the run as `stopped(interrupted)`.
#[test]
fn stop_interrupted_settles_the_run_as_interrupted() {
    let (mut owner, sessions) = new_owner();
    start_ask(&mut owner, &sessions);
    owner.stop_interrupted().expect("stop");
    assert!(matches!(
        owner.settlement(),
        Some(RunSettlement::Stopped {
            reason: StopReason::Interrupted,
            ..
        })
    ));
}

/// The amendment's stop (9.43, Node `controller.abort({ superseded })`): the run settles as `stopped(superseded)` and
/// names its successor, which is what the journal and the resume gate read.
#[test]
fn stop_superseded_settles_the_run_as_superseded_by_its_successor() {
    let (mut owner, sessions) = new_owner();
    start_ask(&mut owner, &sessions);
    owner
        .stop_superseded("dwfrun-successor")
        .expect("stop as superseded");
    assert!(matches!(
        owner.settlement(),
        Some(RunSettlement::Stopped {
            reason: StopReason::Superseded,
            superseded_by: Some(successor),
            ..
        }) if successor == "dwfrun-successor"
    ));
}

/// A run's `LiveRun` that stops nothing by itself: only the owner's own stop settles the run here.
struct QuietRun;

impl LiveRun for QuietRun {
    fn stop_interrupted(&self) {}
}

/// Review finding 8: a pump error at the stop does not keep the run from settling. The stop runs regardless, so the run
/// settles and its guard is released, and a later close of the parent session returns at once.
#[test]
fn a_pump_error_at_the_stop_still_settles_the_run_and_releases_its_guard() {
    let (mut owner, sessions) = new_owner();
    let residency = SessionResidency::with_close_wait(std::time::Duration::from_millis(200));
    owner
        .attach_residency(&residency, Arc::new(QuietRun))
        .expect("the run is made resident");
    start_ask(&mut owner, &sessions);
    // The next pump fails, as a deferred driver error makes it.
    owner.fail_next_pump_for_test("the pump failed");
    let stopped = owner.stop_interrupted();
    assert!(stopped.is_err(), "the pump error is carried to the caller");
    assert!(
        matches!(
            owner.settlement(),
            Some(RunSettlement::Stopped {
                reason: StopReason::Interrupted,
                ..
            })
        ),
        "the run settles as interrupted even though the pump failed"
    );
    residency
        .close("ses_parent")
        .expect("the settled run released its guard, so the close does not wait");
}

/// The residency's stop goes through the mailbox: the owner's thread serves it and settles the run.
#[test]
fn a_mailbox_run_stop_settles_the_run_on_the_owner_thread() {
    let (mut owner, sessions) = new_owner();
    start_ask(&mut owner, &sessions);
    let (mailbox, handle) = ActorMailbox::new();
    MailboxRun::new(handle).stop_interrupted();
    mailbox.serve_next(&mut owner).expect("serve the stop");
    assert!(matches!(
        owner.settlement(),
        Some(RunSettlement::Stopped {
            reason: StopReason::Interrupted,
            ..
        })
    ));
}

/// A feed posted through a handle reaches the owner when the owner serves it.
#[test]
fn a_feed_posted_through_a_handle_reaches_the_owner() {
    let (mut owner, sessions) = new_owner();
    let (session, _) = start_ask(&mut owner, &sessions);
    let (mailbox, handle) = ActorMailbox::new();
    assert!(handle.feed(&session, FeedEvent::Executing));
    mailbox.serve_next(&mut owner).expect("serve the feed");
    assert_eq!(count_of(&owner, "node-executing"), 1);
}
