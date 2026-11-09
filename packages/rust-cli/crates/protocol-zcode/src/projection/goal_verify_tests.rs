//! Fork: goal completion verification markers and control (specs/fork-rust-goal-verifier.md §4).

use rust_cli_kernel_api::goal::{
    GoalPhase, GoalState, GoalVerification, VerificationItem, VerificationOutcome,
    VerificationStatus, VerificationVerdict,
};

use super::*;

fn step(status: VerificationStatus, verdict: Option<(bool, &str)>) -> KernelEvent {
    KernelEvent::GoalVerification {
        verification: GoalVerification {
            target_id: "msg_goal".into(),
            status,
            verification_id: "goalverify_1".into(),
            verification: verdict.map(|(passed, reason)| VerificationVerdict {
                passed,
                reason: reason.into(),
                next_action: None,
            }),
            goal_iteration: 1,
            anchor_assistant_message_id: Some("msg_a1".into()),
            anchor_turn_id: Some("turn_1".into()),
        },
        at_ms: 3000,
    }
}

fn goal(status: GoalPhase, verifications: Vec<VerificationItem>) -> GoalState {
    GoalState {
        target: "msg_goal".into(),
        objective: "tests pass".into(),
        status,
        iteration: 1,
        time_used_seconds: 0,
        active_run_started_at_ms: None,
        summary_title: None,
        verifications,
    }
}

fn item(outcome: VerificationOutcome) -> VerificationItem {
    VerificationItem {
        iteration: 1,
        outcome,
        at_ms: 3000,
        reason: Some("Tests fail.".into()),
        next_action: Some("Fix it.".into()),
        anchor_message: Some("msg_a1".into()),
    }
}

fn patch_of(deltas: &[Value]) -> &Value {
    &deltas
        .iter()
        .rev()
        .find(|delta| delta["op"] == "state.updated")
        .unwrap()["patch"]
}

#[test]
fn a_verification_is_a_tail_marker_and_a_goal_verifier_work() {
    let mut feed = Feed::new();
    finished_turn(&mut feed, 1);
    finished_turn(&mut feed, 2);
    let deltas = feed.apply(step(VerificationStatus::Started, None));
    let row = &deltas[0]["row"];
    assert_eq!(deltas[0]["op"], "row.appended");
    assert_eq!(
        (
            row["kind"].clone(),
            row["lane"].clone(),
            row["turnId"].clone()
        ),
        (
            json!("timelineMarker"),
            json!("turnTailBoundary"),
            json!("turn_1")
        )
    );
    assert_eq!(
        row["marker"],
        json!({"type": "goalVerify", "iteration": 1, "outcome": "running"})
    );
    let patch = patch_of(&deltas);
    assert_eq!(patch["control"]["phase"], "running");
    assert_eq!(patch["control"]["stopTargetKind"], "goalVerifier");
    assert_eq!(
        patch["control"]["activeWorks"],
        json!([{"kind": "goalVerifier", "startedAt": 2000 + feed.seq}])
    );
    assert_eq!(
        patch["inputRouting"],
        json!({"mode": "enqueue", "reasonCode": "goalVerifierAcceptsFutureInput"})
    );
    let marker_row = row["rowId"].clone();

    let deltas = feed.apply(step(
        VerificationStatus::Completed,
        Some((false, "Tests fail.")),
    ));
    assert_eq!(deltas[0]["op"], "row.upserted");
    assert_eq!(
        deltas[0]["row"]["marker"],
        json!({"type": "goalVerify", "iteration": 1, "outcome": "notSatisfied", "detail": "Tests fail."})
    );
    let patch = patch_of(&deltas);
    assert_eq!(patch["control"]["phase"], "completedSuccess");
    assert_eq!(patch["control"]["activeWorks"], json!([]));

    let deltas = feed.apply(KernelEvent::GoalChanged {
        goal: Some(goal(
            GoalPhase::NotSatisfied,
            vec![item(VerificationOutcome::NotSatisfied)],
        )),
    });
    assert_eq!(
        patch_of(&deltas)["goal"]["verifications"],
        json!([{
            "iteration": 1,
            "outcome": "notSatisfied",
            "at": 3000,
            "anchorRowId": marker_row,
            "reason": "Tests fail.",
            "nextAction": "Fix it.",
        }])
    );
}

#[test]
fn a_cancelled_verification_is_a_failed_marker_and_an_interrupted_session() {
    let mut feed = Feed::new();
    finished_turn(&mut feed, 1);
    feed.apply(step(VerificationStatus::Started, None));
    let deltas = feed.apply(step(
        VerificationStatus::Cancelled,
        Some((false, "Completion verifier request was cancelled.")),
    ));
    assert_eq!(
        deltas[0]["row"]["marker"],
        json!({"type": "goalVerify", "iteration": 1, "outcome": "failed", "detail": "cancelled"})
    );
    assert_eq!(
        patch_of(&deltas)["control"]["phase"],
        "completedInterrupted"
    );
}

/// A failed verification request leaves Node's phase `error` without ending the session.
#[test]
fn a_failed_verification_request_is_an_error_phase_that_does_not_end_the_session() {
    let mut feed = Feed::new();
    finished_turn(&mut feed, 1);
    feed.apply(step(VerificationStatus::Started, None));
    let deltas = feed.apply(step(
        VerificationStatus::FailedClosed,
        Some((true, "Completion verifier request failed: busy")),
    ));
    assert_eq!(deltas[0]["row"]["marker"]["outcome"], "failed");
    let control = &patch_of(&deltas)["control"];
    assert_eq!(
        (control["phase"].clone(), control["sessionEnded"].clone()),
        (json!("error"), json!(false))
    );
}

#[test]
fn a_cold_projection_places_stored_verifications_after_their_anchor() {
    let mut session = view(vec![
        user("msg_u1", "first"),
        assistant("msg_a1", vec![ContentBlock::Text { text: "one".into() }]),
        user("msg_u2", "second"),
        assistant("msg_a2", vec![ContentBlock::Text { text: "two".into() }]),
    ]);
    session.goal = Some(goal(
        GoalPhase::NotSatisfied,
        vec![item(VerificationOutcome::NotSatisfied)],
    ));
    let projection = Projection::from_view(&session, Followup::Queue, Vec::new());
    let snapshot = projection.snapshot(0, "epoch");
    let rows: Vec<String> = snapshot["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["kind"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(
        rows,
        [
            "turnHeader",
            "userInput",
            "assistantText",
            "timelineMarker",
            "turnHeader",
            "userInput",
            "assistantText",
        ]
    );
    let marker = &snapshot["rows"]["window"][3];
    assert_eq!(marker["marker"]["outcome"], "notSatisfied");
    assert_eq!(
        snapshot["goal"]["verifications"][0]["anchorRowId"],
        marker["rowId"]
    );
}
