//! The like and pin of a stored message (specs/fork-rust-feedback-and-pins.md), stored and read back as Node does
//! (`assistant-feedback-persistence.ts`, `row-pin-persistence.ts`, `transcript-hydration.ts`).

use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, StopReason, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::message_mark::{Feedback, Mark, Marks};
use rust_cli_kernel_api::store::{Fact, SessionStore};
use serde_json::{Value, json};

use crate::repo::open;
use crate::tests::{TestStore, batch, meta};

fn user(id: &str) -> Fact {
    Fact::MessageAppended {
        message: Message::User(UserMessage {
            stall_execution: None,
            workflow_meta: None,
            epilogue_start: Some(3),
            id: MessageId::new(id),
            content: vec![ContentBlock::Text { text: "hi".into() }],
            origin: UserOrigin::Human,
            intent: None,
        }),
    }
}

fn assistant(id: &str) -> Fact {
    Fact::MessageAppended {
        message: Message::Assistant(AssistantMessage {
            id: MessageId::new(id),
            content: vec![ContentBlock::Text { text: "ok".into() }],
            model: "m".into(),
            stop_reason: Some(StopReason::EndTurn),
            usage: None,
        }),
    }
}

fn mark(id: &str, mark: Mark) -> Fact {
    Fact::MessageMarked {
        message: MessageId::new(id),
        mark,
    }
}

/// A session with one typed input and one reply.
async fn session() -> (TestStore, SessionId) {
    let test = TestStore::new();
    let session = SessionId::new("sess_marks");
    test.store
        .create(meta("sess_marks", "/w", ""))
        .await
        .unwrap();
    test.store
        .commit(
            &session,
            batch(Some("c1"), vec![user("u1"), assistant("a1")]),
        )
        .await
        .unwrap();
    (test, session)
}

async fn commit(test: &TestStore, session: &SessionId, facts: Vec<Fact>) {
    test.store
        .commit(session, batch(Some("c2"), facts))
        .await
        .unwrap();
}

/// The stored `data` of a message row.
fn stored(test: &TestStore, id: &str) -> Value {
    let rows = test.rows(&format!("select data from message where id = '{id}'"));
    serde_json::from_str(rows[0][0].as_str().unwrap()).unwrap()
}

fn keys(data: &Value) -> Vec<&str> {
    data.as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect()
}

#[tokio::test]
async fn feedback_is_set_changed_and_cleared_in_the_metadata() {
    let (test, session) = session().await;
    assert!(stored(&test, "a1").get("metadata").is_none());
    commit(
        &test,
        &session,
        vec![mark("a1", Mark::Feedback(Some(Feedback::Like)))],
    )
    .await;
    let data = stored(&test, "a1");
    assert_eq!(data["metadata"], json!({"assistantFeedback": "like"}));
    // Node re-spreads the info with its metadata last.
    assert_eq!(keys(&data).last(), Some(&"metadata"));
    commit(
        &test,
        &session,
        vec![mark("a1", Mark::Feedback(Some(Feedback::Dislike)))],
    )
    .await;
    assert_eq!(
        stored(&test, "a1")["metadata"],
        json!({"assistantFeedback": "dislike"})
    );
    // Clearing the only key drops the whole object, like Node.
    commit(&test, &session, vec![mark("a1", Mark::Feedback(None))]).await;
    assert!(stored(&test, "a1").get("metadata").is_none());
}

#[tokio::test]
async fn a_pin_keeps_the_other_metadata_and_the_user_model_member() {
    let (test, session) = session().await;
    let before = stored(&test, "u1");
    assert_eq!(before["metadata"], json!({"epilogueStart": 3}));
    commit(&test, &session, vec![mark("u1", Mark::Pinned(Some(1_234)))]).await;
    let pinned = stored(&test, "u1");
    assert_eq!(
        pinned["metadata"],
        json!({"epilogueStart": 3, "pinnedAt": 1_234})
    );
    // Every other member of the record, the legacy `model` of a user record included, is as it was.
    let mut rest = pinned.clone();
    rest.as_object_mut().unwrap().remove("metadata");
    let mut was = before.clone();
    was.as_object_mut().unwrap().remove("metadata");
    assert_eq!(rest, was);
    commit(&test, &session, vec![mark("u1", Mark::Pinned(None))]).await;
    assert_eq!(stored(&test, "u1")["metadata"], json!({"epilogueStart": 3}));
}

#[tokio::test]
async fn a_cold_load_reads_the_marks_back() {
    let (test, session) = session().await;
    commit(
        &test,
        &session,
        vec![
            mark("a1", Mark::Feedback(Some(Feedback::Like))),
            mark("a1", Mark::Pinned(Some(9))),
            mark("u1", Mark::Pinned(Some(5))),
        ],
    )
    .await;
    let loaded = test.store.load(&session).await.unwrap();
    assert_eq!(loaded.marks.len(), 2);
    assert_eq!(
        loaded.marks[&MessageId::new("a1")],
        Marks {
            feedback: Some(Feedback::Like),
            pinned_at: Some(9)
        }
    );
    assert_eq!(
        loaded.marks[&MessageId::new("u1")],
        Marks {
            feedback: None,
            pinned_at: Some(5)
        }
    );
}

#[tokio::test]
async fn a_mark_on_a_missing_message_or_the_wrong_role_fails_the_batch() {
    let (test, session) = session().await;
    let missing = test
        .store
        .commit(
            &session,
            batch(Some("c2"), vec![mark("nope", Mark::Pinned(Some(1)))]),
        )
        .await;
    assert!(missing.is_err());
    // Feedback is an assistant mark.
    let wrong = test
        .store
        .commit(
            &session,
            batch(
                Some("c3"),
                vec![mark("u1", Mark::Feedback(Some(Feedback::Like)))],
            ),
        )
        .await;
    assert!(wrong.is_err());
    assert!(test.store.load(&session).await.unwrap().marks.is_empty());
}

/// Node wrote `assistantFeedback: "like"` on `a2` of the `rich` fixture; its other messages carry no mark. Values other
/// than `like` / `dislike`, and a feedback on a user record, are ignored like Node's hydration does.
#[test]
fn the_node_fixture_loads_its_stored_like() {
    let fixture: Value = serde_json::from_str(include_str!("../fixtures/node-cold.json")).unwrap();
    let case = &fixture["rich"];
    let dir = tempfile::tempdir().unwrap();
    let (conn, _) =
        open::open(&dir.path().join("db.sqlite"), open::MIGRATION_LOCK_WAIT, 1).unwrap();
    for (table, rows) in case["tables"].as_object().unwrap() {
        for row in rows.as_array().unwrap() {
            let values: Vec<rusqlite::types::Value> = row
                .as_array()
                .unwrap()
                .iter()
                .map(|v| match v {
                    Value::Null => rusqlite::types::Value::Null,
                    Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap()),
                    Value::String(s) => rusqlite::types::Value::Text(s.clone()),
                    other => panic!("unexpected column {other}"),
                })
                .collect();
            let slots = vec!["?"; values.len()].join(",");
            conn.execute(
                &format!("insert into {table} values ({slots})"),
                rusqlite::params_from_iter(values),
            )
            .unwrap();
        }
    }
    let session = SessionId::new("sess_rich");
    let (loaded, _) = crate::load::load(&conn, &session).unwrap();
    assert_eq!(loaded.marks.len(), 1, "{:?}", loaded.marks);
    assert_eq!(
        loaded.marks[&MessageId::new("a2")],
        Marks {
            feedback: Some(Feedback::Like),
            pinned_at: None
        }
    );
}
