//! Fork (desktop App): goal verification steps as Node session entries (specs/fork-rust-goal-verifier.md §2).
use rust_cli_kernel_api::goal::{GoalVerification, VerificationStatus, VerificationVerdict};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::{Fact, SessionStore};
use serde_json::json;

use crate::tests::{TestStore, batch, meta, user};

fn step(iteration: u32, status: VerificationStatus) -> GoalVerification {
    GoalVerification {
        target_id: "msg_goal".to_owned(),
        status,
        verification_id: format!("ver_{iteration}"),
        verification: (status == VerificationStatus::Completed).then(|| VerificationVerdict {
            passed: false,
            reason: "tests fail".to_owned(),
            next_action: Some("Run the tests".to_owned()),
        }),
        goal_iteration: iteration,
        anchor_assistant_message_id: Some("msg_a".to_owned()),
        anchor_turn_id: Some("turn_1".to_owned()),
    }
}

#[tokio::test]
async fn verification_steps_are_node_session_entries_and_read_back() {
    let test = TestStore::new();
    let session = SessionId::new("sess_verify");
    test.store
        .create(meta("sess_verify", "/w", ""))
        .await
        .unwrap();
    test.store
        .commit(&session, batch(None, vec![user("msg_1", "start")]))
        .await
        .unwrap();
    for (at_ms, verification) in [
        (1_000, step(1, VerificationStatus::Started)),
        (2_000, step(1, VerificationStatus::Completed)),
        (3_000, step(2, VerificationStatus::Started)),
    ] {
        test.store
            .commit(
                &session,
                batch(
                    None,
                    vec![Fact::GoalVerificationRecorded {
                        verification,
                        at_ms,
                    }],
                ),
            )
            .await
            .unwrap();
    }
    let rows = test.rows(
        "select type, time_created, json_extract(data, '$.payload.status'),
                json_extract(data, '$.payload.goalIteration'), json_extract(data, '$.sequenceNumber'),
                json_extract(data, '$.turnId'), json_extract(data, '$.payload.verification.nextAction'),
                json_extract(data, '$.eventId') = id
           from session_entry where type = 'target_completion_verification' order by time_created",
    );
    assert_eq!(
        rows,
        [
            vec![
                json!("target_completion_verification"),
                json!(1_000),
                json!("started"),
                json!(1),
                json!(1),
                json!("turn_1"),
                json!(null),
                json!(1)
            ],
            vec![
                json!("target_completion_verification"),
                json!(2_000),
                json!("completed"),
                json!(1),
                json!(2),
                json!("turn_1"),
                json!("Run the tests"),
                json!(1)
            ],
            vec![
                json!("target_completion_verification"),
                json!(3_000),
                json!("started"),
                json!(2),
                json!(3),
                json!("turn_1"),
                json!(null),
                json!(1)
            ],
        ]
    );
    let loaded = test.store.load(&session).await.unwrap().goal_verifications;
    let read: Vec<_> = loaded
        .iter()
        .map(|step| {
            (
                step.verification.goal_iteration,
                step.verification.status,
                step.at_ms,
            )
        })
        .collect();
    assert_eq!(
        read,
        [
            (1, VerificationStatus::Completed, 2_000),
            (2, VerificationStatus::Started, 3_000)
        ]
    );
    assert_eq!(
        loaded[0].verification,
        step(1, VerificationStatus::Completed)
    );
}
