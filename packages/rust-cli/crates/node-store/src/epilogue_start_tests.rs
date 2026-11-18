//! The epilogue boundary of a turn's user message, stored as Node stores it (`persistUserPrompt`, `message-persistence.ts`):
//! `metadata.epilogueStart` on the message row, written whenever the boundary is known (0 included) and absent otherwise.
//! It sits in the same `metadata` object as the input intent.

use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::input_intent::InputIntent;
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::store::{Fact, SessionStore};
use serde_json::{Value, json};

use crate::tests::{TestStore, batch, meta};

fn input(id: &str, epilogue_start: Option<usize>, intent: Option<InputIntent>) -> Fact {
    Fact::MessageAppended {
        message: Message::User(UserMessage {
            stall_execution: None,
            epilogue_start,
            id: MessageId::new(id),
            content: vec![ContentBlock::Text {
                text: "do it".into(),
            }],
            origin: UserOrigin::Human,
            intent: intent.map(Box::new),
        }),
    }
}

fn intent() -> InputIntent {
    serde_json::from_value(json!({
        "conversationQuotes": [],
        "sourceCommandId": "c1",
        "queueItemId": "queue_c1",
        "clientId": "client",
        "kind": "sendText",
        "text": "do it",
        "admissionSeq": 1,
        "admittedAt": 1500,
        "requestedDelivery": "startNow",
        "admittedDelivery": "startNow",
        "attachmentRefs": [],
    }))
    .unwrap()
}

/// The stored message row's `metadata`, or None when the row has no metadata object.
async fn stored_metadata(fact: Fact) -> Option<Value> {
    let test = TestStore::new();
    let session = SessionId::new("sess_epilogue");
    test.store
        .create(meta("sess_epilogue", "/w", ""))
        .await
        .unwrap();
    test.store
        .commit(&session, batch(Some("c1"), vec![fact]))
        .await
        .unwrap();
    let row = test.rows("select data from message").remove(0).remove(0);
    let message: Value = serde_json::from_str(row.as_str().unwrap()).unwrap();
    message.get("metadata").cloned()
}

/// A turn that starts at the instructions' end stores its boundary, which Node reads back as `epilogueStart`.
#[tokio::test]
async fn a_turn_boundary_is_stored_as_node_epilogue_start() {
    let metadata = stored_metadata(input("msg_1", Some(5), None)).await;
    assert_eq!(metadata, Some(json!({"epilogueStart": 5})));
}

/// A nudged turn's boundary is 0. Node persists it (`epilogueStart !== undefined`), so 0 is stored, not dropped.
#[tokio::test]
async fn a_zero_boundary_is_stored_too() {
    let metadata = stored_metadata(input("msg_1", Some(0), None)).await;
    assert_eq!(metadata, Some(json!({"epilogueStart": 0})));
}

/// A user message without a boundary stores no `epilogueStart`, and no metadata object if it has nothing else.
#[tokio::test]
async fn a_message_without_a_boundary_stores_no_epilogue_start() {
    let metadata = stored_metadata(input("msg_1", None, None)).await;
    assert_eq!(metadata, None);
}

/// The boundary shares the metadata object with the input intent, as Node's `metadata` does.
#[tokio::test]
async fn the_boundary_sits_beside_the_input_intent() {
    let metadata = stored_metadata(input("msg_1", Some(7), Some(intent())))
        .await
        .expect("metadata");
    assert_eq!(metadata["epilogueStart"], json!(7));
    assert_eq!(
        metadata["inputIntent"],
        serde_json::to_value(intent()).unwrap()
    );
}
