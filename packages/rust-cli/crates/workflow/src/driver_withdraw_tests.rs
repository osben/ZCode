//! Divergence 607: a parked question is withdrawn when its ask ends on a path other than the user's stop, as Node's
//! `withdrawSessionEscalations` does from `onTurnRejected` (the turn throws) and from `cancelAsk`. The two other Node
//! call sites are covered where they live: an accepted ask and a completed run (driver_owner_tests), the user's stop
//! (row 69), and the next ask on a session (`escalation_tests`).

use crate::driver_owner_tests::{request, running_ask};
use crate::escalation::EscalateOutcome;
use crate::model_failure::TurnFailure;

#[test]
fn a_turn_that_fails_withdraws_its_parked_question_and_a_later_answer_finds_nothing() {
    let (mut owner, sessions, _actor, session) = running_ask();
    let qid = match owner
        .escalate(&session, request("which?"))
        .expect("escalate")
    {
        EscalateOutcome::Parked { qid } => qid,
        other => panic!("expected a park, got {other:?}"),
    };
    owner
        .turn_failed(&session, &TurnFailure::plain("boom"))
        .expect("the failure is handled");
    assert_eq!(
        sessions.0.borrow().rejected,
        vec![(session.clone(), qid.clone())],
        "the blocked escalate is failed, so the turn does not hang"
    );
    assert_eq!(owner.answer(&qid, "late").expect("answer"), None);
    assert!(sessions.0.borrow().answered.is_empty());
}
