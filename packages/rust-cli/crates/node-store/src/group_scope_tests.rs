//! Fork: a bot-group input makes the session's permission a session scope (Node `ensureGroupTaskPermissionScope`,
//! `input-intent-persistence.ts`; specs/fork-rust-topic-resource.md, Group task permission scope).

use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::input_intent::InputIntent;
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::store::{Fact, SessionStore};
use serde_json::{Value, json};

use crate::tests::{TestStore, batch, meta};

fn input(id: &str, group: bool) -> Fact {
    let mut intent = json!({"sourceCommandId": "c1", "kind": "sendText"});
    if group {
        intent["botGroupSource"] = json!({"botId": "bot", "chatId": "group"});
    }
    Fact::MessageAppended {
        message: Message::User(UserMessage {
            stall_execution: None,
            workflow_meta: None,
            epilogue_start: None,
            id: MessageId::new(id),
            content: vec![ContentBlock::Text { text: "hi".into() }],
            origin: UserOrigin::Human,
            intent: Some(Box::new(
                serde_json::from_value::<InputIntent>(intent).unwrap(),
            )),
        }),
    }
}

async fn session_with(permission: Option<&str>) -> (TestStore, SessionId) {
    let test = TestStore::new();
    let session = SessionId::new("sess_group");
    test.store
        .create(meta("sess_group", "/w", ""))
        .await
        .unwrap();
    if let Some(permission) = permission {
        test.connection()
            .execute("update session set permission = ?", [permission])
            .unwrap();
    }
    (test, session)
}

fn permission(test: &TestStore) -> Value {
    let text = test
        .rows("select permission from session")
        .remove(0)
        .remove(0);
    serde_json::from_str(text.as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn a_group_input_replaces_the_earlier_permission_with_a_session_scope() {
    let (test, session) =
        session_with(Some(r#"{"mode":"yolo","allow":[{"toolName":"Bash"}]}"#)).await;
    test.store
        .commit(&session, batch(Some("c1"), vec![input("msg_1", true)]))
        .await
        .unwrap();
    assert_eq!(
        permission(&test),
        json!({"version": 1, "scope": "session", "mode": "build"})
    );
}

#[tokio::test]
async fn a_group_input_creates_the_scope_on_a_row_without_permission() {
    let (test, session) = session_with(None).await;
    test.store
        .commit(&session, batch(Some("c1"), vec![input("msg_1", true)]))
        .await
        .unwrap();
    assert_eq!(
        permission(&test),
        json!({"version": 1, "scope": "session", "mode": "build"})
    );
}

#[tokio::test]
async fn a_scoped_row_keeps_its_grants() {
    let scoped = r#"{"version":1,"scope":"session","mode":"yolo","allow":[{"toolName":"Read"}]}"#;
    let (test, session) = session_with(Some(scoped)).await;
    test.store
        .commit(&session, batch(Some("c1"), vec![input("msg_1", true)]))
        .await
        .unwrap();
    assert_eq!(
        permission(&test),
        serde_json::from_str::<Value>(scoped).unwrap()
    );
}

#[tokio::test]
async fn an_ordinary_input_leaves_the_permission_alone() {
    let (test, session) = session_with(Some(r#"{"mode":"yolo"}"#)).await;
    test.store
        .commit(&session, batch(Some("c1"), vec![input("msg_1", false)]))
        .await
        .unwrap();
    assert_eq!(permission(&test), json!({"mode": "yolo"}));
}
