//! Fork: an App input's intent is stored as Node stores it (`persistUserPrompt`, `message-persistence.ts`):
//! `metadata.inputIntent`, `metadata.conversationInputIntent` and `metadata.inputClientId`, with the composed text in
//! the text part (specs/fork-agent-runtime-selection.md, Conversation quotes in Rust mode).

use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::input_intent::InputIntent;
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::store::{Fact, SessionStore};
use serde_json::{Value, json};

use crate::tests::{TestStore, batch, meta};

const BLOCK: &str = "<conversation_quote>\n[{\"text\":\"E2E selection\"}]\n</conversation_quote>";

fn intent(text: &str) -> InputIntent {
    serde_json::from_value(json!({
        "conversationQuotes": [{"text": "E2E selection"}],
        "sourceCommandId": "c1",
        "queueItemId": "queue_c1",
        "clientId": "client",
        "kind": "sendText",
        "text": text,
        "admissionSeq": 1,
        "admittedAt": 1500,
        "requestedDelivery": "startNow",
        "admittedDelivery": "startNow",
        "attachmentRefs": [],
    }))
    .unwrap()
}

fn input(id: &str, text: &str, intent: InputIntent) -> Fact {
    Fact::MessageAppended {
        message: Message::User(UserMessage {
            id: MessageId::new(id),
            content: vec![ContentBlock::Text { text: text.into() }],
            origin: UserOrigin::Human,
            intent: Some(Box::new(intent)),
        }),
    }
}

fn json_rows(test: &TestStore, sql: &str) -> Vec<Value> {
    test.rows(sql)
        .into_iter()
        .map(|row| serde_json::from_str(row[0].as_str().unwrap()).unwrap())
        .collect()
}

async fn stored(text: &str, intent: InputIntent) -> (TestStore, Value, Value, Value) {
    let test = TestStore::new();
    let session = SessionId::new("sess_quoted");
    test.store
        .create(meta("sess_quoted", "/w", ""))
        .await
        .unwrap();
    test.store
        .commit(
            &session,
            batch(Some("c1"), vec![input("msg_1", text, intent)]),
        )
        .await
        .unwrap();
    let message = json_rows(&test, "select data from message").remove(0);
    let part = json_rows(&test, "select data from part").remove(0);
    let title = test.rows("select title from session").remove(0).remove(0);
    (test, message, part, title)
}

/// Node writes both intent objects and the client id; Node's reader takes the row's typed text and quotes from them.
#[tokio::test]
async fn an_app_input_stores_nodes_intent_metadata() {
    let composed = format!("explain this\n\n{BLOCK}");
    let (_test, message, part, title) = stored(&composed, intent("explain this")).await;
    assert_eq!(
        message["metadata"],
        json!({
            "inputIntent": intent("explain this"),
            "conversationInputIntent": {
                "conversationQuotes": [{"text": "E2E selection"}],
                "sourceCommandId": "c1",
                "queueItemId": "queue_c1",
                "clientId": "client",
                "kind": "sendText",
                "text": "explain this",
                "attachments": [],
                "delivery": {"requested": "startNow", "admitted": "startNow"},
                "order": {"admissionSeq": 1},
                "steer": {"state": "notRequested"},
                "dispatch": {"state": "drained"},
                "admittedAt": 1500,
            },
            "inputClientId": "client",
        })
    );
    // Node's key order: the metadata follows the tools.
    let keys: Vec<_> = message.as_object().unwrap().keys().cloned().collect();
    let at = |key: &str| keys.iter().position(|k| k == key).unwrap();
    assert_eq!(at("metadata"), at("tools") + 1);
    assert_eq!(part["text"], composed);
    assert!(part.get("metadata").is_none());
    assert_eq!(title, json!("explain this"));
}

/// A slash command's part shows the display input, then the block (Node `withConversationQuotes(displayInput)`); the
/// expanded text with the block is the model input.
#[tokio::test]
async fn a_quoted_command_shows_its_display_input_then_the_block() {
    let tags = rust_cli_kernel_api::user_command::command_tags("greet", "Ada");
    let composed = format!("{tags}\n\n{BLOCK}");
    let (_test, _message, part, title) = stored(&composed, intent("/greet Ada")).await;
    assert_eq!(part["text"], format!("/greet Ada\n\n{BLOCK}"));
    assert_eq!(part["metadata"], json!({"modelInput": composed}));
    assert_eq!(title, json!("/greet Ada"));
}

/// Node `inputIntentOfMessage`: a reopened session's user message carries the stored intent, `[]` quotes included;
/// a message written without one has none, whatever its text.
#[tokio::test]
async fn a_reopened_input_reads_its_intent_back() {
    let composed = format!("explain this\n\n{BLOCK}");
    let (test, _message, _part, _title) = stored(&composed, intent("explain this")).await;
    let loaded = test
        .store
        .load(&SessionId::new("sess_quoted"))
        .await
        .unwrap();
    let Message::User(user) = &loaded.messages[0] else {
        panic!("{:?}", loaded.messages)
    };
    // Node's reader rebuilds the flat intent from the persisted one; it drops an empty attachment list.
    let mut read = intent("explain this").fields().clone();
    read.remove("attachmentRefs");
    assert_eq!(
        user.intent.as_deref(),
        Some(&InputIntent::from_fields(read))
    );
    assert_eq!(user.content, [ContentBlock::Text { text: composed }]);

    let empty = InputIntent::from_fields({
        let mut fields = intent("hi").fields().clone();
        fields.insert("conversationQuotes".into(), json!([]));
        fields.remove("attachmentRefs");
        fields
    });
    let (test, _message, _part, _title) = stored("hi", empty.clone()).await;
    let loaded = test
        .store
        .load(&SessionId::new("sess_quoted"))
        .await
        .unwrap();
    let Message::User(user) = &loaded.messages[0] else {
        panic!("{:?}", loaded.messages)
    };
    assert_eq!(user.intent.as_deref(), Some(&empty));
    assert_eq!(user.intent.as_ref().unwrap().quotes(), Some(Vec::new()));
}
