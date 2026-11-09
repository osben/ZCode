//! Fork (desktop App): the goal's Node `session_target` row (specs/fork-rust-agent-parity.md, Goals).
use rust_cli_kernel_api::goal::{GoalPhase, GoalState};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::{Fact, SessionStore};
use serde_json::json;

use crate::tests::{TestStore, batch, meta, user};

fn goal(target: &str, status: GoalPhase, running: Option<u64>) -> GoalState {
    GoalState {
        target: target.to_owned(),
        objective: "tests pass".to_owned(),
        status,
        iteration: 4,
        time_used_seconds: 30,
        active_run_started_at_ms: running,
        summary_title: Some("Green suite".to_owned()),
    }
}

fn row(test: &TestStore) -> Vec<serde_json::Value> {
    test.rows(
        "select target_id, objective, summary_title, status, time_used_seconds, active_input_id,
                active_run_started_at, active_run_last_seen_at from session_target",
    )
    .remove(0)
}

#[tokio::test]
async fn the_goal_row_is_written_like_node_and_read_back() {
    let test = TestStore::new();
    let session = SessionId::new("sess_goal");
    test.store
        .create(meta("sess_goal", "/w", ""))
        .await
        .unwrap();
    test.store
        .commit(&session, batch(None, vec![user("msg_1", "start")]))
        .await
        .unwrap();
    let save = |goal: GoalState, seen_at_ms: u64| {
        let session = session.clone();
        let store = &test.store;
        async move {
            store
                .commit(
                    &session,
                    batch(None, vec![Fact::GoalTargetSaved { goal, seen_at_ms }]),
                )
                .await
                .unwrap();
        }
    };
    save(goal("msg_goal", GoalPhase::Active, Some(10_000)), 25_000).await;
    assert_eq!(
        row(&test),
        [
            json!("msg_goal"),
            json!("tests pass"),
            json!("Green suite"),
            json!("active"),
            json!(30),
            json!("msg_goal"),
            json!(10_000),
            json!(25_000)
        ]
    );
    // The process stopped during the stretch: it counts up to the last write (15 s), like Node's recovery.
    let loaded = test
        .store
        .load(&session)
        .await
        .unwrap()
        .goal_target
        .unwrap();
    assert_eq!(loaded.time_used_seconds, 45);
    assert_eq!(loaded.active_run_started_at_ms, None);
    assert_eq!(loaded.summary_title.as_deref(), Some("Green suite"));
    assert_eq!(loaded.iteration, 0);

    // A met goal is `complete` (Node's status check); the stretch columns are cleared.
    save(goal("msg_goal", GoalPhase::Verified, None), 30_000).await;
    assert_eq!(
        row(&test)[3..],
        [
            json!("complete"),
            json!(30),
            json!(null),
            json!(null),
            json!(null)
        ]
    );
    let loaded = test
        .store
        .load(&session)
        .await
        .unwrap()
        .goal_target
        .unwrap();
    assert_eq!(
        (loaded.status, loaded.time_used_seconds),
        (GoalPhase::Verified, 30)
    );

    test.store
        .commit(&session, batch(None, vec![Fact::GoalTargetCleared]))
        .await
        .unwrap();
    assert!(test.rows("select * from session_target").is_empty());
    assert!(
        test.store
            .load(&session)
            .await
            .unwrap()
            .goal_target
            .is_none()
    );
}
