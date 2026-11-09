//! Fork: Node's `session_input` ledger (specs/fork-rust-agent-parity.md, Input ledger).
use rust_cli_kernel_api::ids::{CommandId, SessionId};
use rust_cli_kernel_api::store::{
    AdmittedInput, Fact, InputDelivery, SessionStore, SettledInput, StoreQueries,
};
use serde_json::{Value, json};

use crate::tests::{TestStore, batch, meta, user};

fn admitted(command: &str, text: &str, delivery: InputDelivery) -> Fact {
    Fact::InputAdmitted {
        input: AdmittedInput {
            command: CommandId::new(command),
            kind: "sendText".to_owned(),
            delivery,
            text: text.to_owned(),
        },
    }
}

async fn session(test: &TestStore) -> SessionId {
    let session = SessionId::new("sess_inputs");
    test.store
        .create(meta("sess_inputs", "/w", ""))
        .await
        .unwrap();
    test.store
        .commit(&session, batch(None, vec![user("msg_1", "running")]))
        .await
        .unwrap();
    session
}

async fn commit(test: &TestStore, session: &SessionId, facts: Vec<Fact>) {
    test.store
        .commit(session, batch(None, facts))
        .await
        .unwrap();
}

fn rows(test: &TestStore) -> Vec<Vec<Value>> {
    test.rows(
        "select id, kind, delivery, admitted_sequence, promoted_sequence, promoted_message_id, status, status_reason
           from session_input order by admitted_sequence",
    )
}

fn session_updated(test: &TestStore) -> Value {
    test.rows("select time_updated from session")
        .remove(0)
        .remove(0)
}

#[tokio::test]
async fn queued_inputs_are_admitted_promoted_and_cancelled_like_node() {
    let test = TestStore::new();
    let session = session(&test).await;
    let updated = session_updated(&test);
    commit(
        &test,
        &session,
        vec![
            admitted("cmd_a", "first", InputDelivery::Queue),
            admitted("cmd_b", "steer", InputDelivery::Guide),
            admitted("cmd_c", "third", InputDelivery::Queue),
        ],
    )
    .await;
    // An edit rewrites the row in place: the sequence stays.
    commit(
        &test,
        &session,
        vec![admitted("cmd_a", "first, edited", InputDelivery::Queue)],
    )
    .await;
    let payload: Value = serde_json::from_str(
        test.rows("select payload from session_input where id = 'queue_cmd_a'")[0][0]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["text"], "first, edited");
    assert_eq!(
        payload["conversationInputIntent"]["sourceCommandId"],
        "cmd_a"
    );
    assert_eq!(
        payload["conversationInputIntent"]["queueItemId"],
        "queue_cmd_a"
    );
    assert_eq!(
        payload["conversationInputIntent"]["delivery"],
        json!({"requested": "queue", "admitted": "queue"})
    );
    commit(
        &test,
        &session,
        vec![
            Fact::InputPromoted {
                command: CommandId::new("cmd_b"),
            },
            Fact::InputCancelled {
                command: CommandId::new("cmd_c"),
                reason: "user_removed".to_owned(),
            },
            // Only `admitted` rows change: a second settlement is a no-op.
            Fact::InputCancelled {
                command: CommandId::new("cmd_b"),
                reason: "user_removed".to_owned(),
            },
        ],
    )
    .await;
    assert_eq!(
        rows(&test),
        [
            [
                json!("queue_cmd_a"),
                json!("sendText"),
                json!("queue"),
                json!(0),
                Value::Null,
                Value::Null,
                json!("admitted"),
                Value::Null
            ],
            [
                json!("queue_cmd_b"),
                json!("sendText"),
                json!("guide"),
                json!(1),
                json!(0),
                Value::Null,
                json!("promoted"),
                Value::Null
            ],
            [
                json!("queue_cmd_c"),
                json!("sendText"),
                json!("queue"),
                json!(2),
                Value::Null,
                Value::Null,
                json!("cancelled"),
                json!("user_removed")
            ],
        ]
    );
    // The ledger never refreshes the sidebar time.
    assert_eq!(session_updated(&test), updated);
    assert_eq!(
        test.store
            .settled_input(&session, &CommandId::new("cmd_c"))
            .await
            .unwrap(),
        Some(SettledInput {
            status: "cancelled".to_owned(),
            reason: Some("user_removed".to_owned()),
            delivery: "queue".to_owned(),
        })
    );
    for live in ["cmd_a", "cmd_b", "cmd_unknown"] {
        assert_eq!(
            test.store
                .settled_input(&session, &CommandId::new(live))
                .await
                .unwrap(),
            None,
            "{live}"
        );
    }
}

#[tokio::test]
async fn the_open_sweep_discards_what_did_not_reach_the_transcript() {
    let test = TestStore::new();
    let session = session(&test).await;
    commit(
        &test,
        &session,
        vec![
            admitted("cmd_lost", "lost", InputDelivery::Queue),
            admitted("cmd_sent", "sent", InputDelivery::Queue),
        ],
    )
    .await;
    let updated = session_updated(&test);
    commit(
        &test,
        &session,
        vec![Fact::InputsResumed {
            transcript: vec![CommandId::new("cmd_sent")],
        }],
    )
    .await;
    let statuses = test.rows(
        "select id, status, status_reason, promoted_sequence from session_input order by admitted_sequence",
    );
    assert_eq!(
        statuses,
        [
            [
                json!("queue_cmd_lost"),
                json!("discarded"),
                json!("session_resumed"),
                Value::Null
            ],
            [
                json!("queue_cmd_sent"),
                json!("promoted"),
                Value::Null,
                json!(0)
            ],
        ]
    );
    assert_eq!(session_updated(&test), updated);
    assert_eq!(
        test.store
            .settled_input(&session, &CommandId::new("cmd_lost"))
            .await
            .unwrap(),
        Some(SettledInput {
            status: "discarded".to_owned(),
            reason: Some("session_resumed".to_owned()),
            delivery: "queue".to_owned(),
        })
    );
}

#[tokio::test]
async fn a_failed_ledger_write_keeps_the_rest_of_the_batch() {
    let test = TestStore::new();
    let session = session(&test).await;
    test.connection()
        .execute_batch("drop table session_input")
        .unwrap();
    commit(
        &test,
        &session,
        vec![
            admitted("cmd_a", "first", InputDelivery::Queue),
            user("msg_2", "next"),
        ],
    )
    .await;
    assert_eq!(test.rows("select count(*) from message")[0][0], json!(2));
}
