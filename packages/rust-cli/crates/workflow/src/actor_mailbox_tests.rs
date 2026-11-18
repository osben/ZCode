//! The mailbox between the actor turns and the owner (W6a part 2c-1). Turns run on their own threads and block on their
//! reply; the owner thread serves the mailbox. These tests serve it from the test thread.
use crate::actor_mailbox::ActorMailbox;
use crate::driver_owner::{SubmitReply, TurnEndReply};
use crate::driver_owner_tests::{request, running_ask};
use crate::engine::SubmitVerdict;
use crate::escalation::EscalateOutcome;
use serde_json::json;
use std::thread;

#[test]
fn a_submit_through_the_mailbox_gets_the_engine_verdict() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let mailbox = ActorMailbox::new();
    let handle = mailbox.handle();
    let turn = thread::spawn(move || handle.submit(&session, json!({"ok": true})));
    mailbox.serve_next(&mut owner).expect("serve");
    let reply = turn.join().expect("turn thread").expect("reply");
    assert_eq!(reply, SubmitReply::Verdict(SubmitVerdict::Accept));
}

#[test]
fn a_turn_end_through_the_mailbox_gets_the_nudge() {
    let (mut owner, _sessions, _actor, session) = running_ask();
    let mailbox = ActorMailbox::new();
    let handle = mailbox.handle();
    let turn = thread::spawn(move || handle.turn_ended(&session, "done"));
    mailbox.serve_next(&mut owner).expect("serve");
    let reply = turn.join().expect("turn thread").expect("reply");
    assert_eq!(reply, TurnEndReply::Verdict(SubmitVerdict::Nudge));
}

#[test]
fn an_escalation_through_the_mailbox_parks_and_the_answer_is_delivered_to_its_session() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let mailbox = ActorMailbox::new();

    let handle = mailbox.handle();
    let asking = session.clone();
    let turn = thread::spawn(move || handle.escalate(&asking, request("which?")));
    mailbox.serve_next(&mut owner).expect("serve the escalate");
    let qid = match turn.join().expect("turn thread").expect("reply") {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a park, got {other:?}"),
    };

    let handle = mailbox.handle();
    let answering = qid.clone();
    let main_agent = thread::spawn(move || handle.answer(&answering, "the second one"));
    mailbox.serve_next(&mut owner).expect("serve the answer");
    let answered = main_agent
        .join()
        .expect("main agent thread")
        .expect("reply")
        .expect("the question was parked");
    assert_eq!(answered.answer, "the second one");
    assert_eq!(
        sessions.0.borrow().answered,
        vec![(session, qid, "the second one".to_owned())]
    );
}

#[test]
fn a_request_after_the_owner_is_gone_is_an_error_for_the_turn_not_a_hang() {
    let mailbox = ActorMailbox::new();
    let handle = mailbox.handle();
    // Nothing serves the mailbox here, so the request is never answered; dropping the mailbox must release the turn.
    drop(mailbox);
    let error = handle
        .submit("sess_x", json!({}))
        .expect_err("no owner serves a dropped mailbox");
    assert!(error.contains("mailbox"), "{error}");
}
