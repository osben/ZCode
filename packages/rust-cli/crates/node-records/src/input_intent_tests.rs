use serde_json::json;

use super::*;

fn intent() -> InputIntent {
    serde_json::from_value(json!({
        "inputOrigin": "desktop",
        "conversationQuotes": [],
        "sourceCommandId": "c1",
        "queueItemId": "queue_c1",
        "clientId": "client",
        "kind": "sendText",
        "text": "hi",
        "mode": "build",
        "planEnabled": false,
        "admissionSeq": 2,
        "admittedAt": 1500,
        "requestedDelivery": "guide",
        "admittedDelivery": "guide",
    }))
    .unwrap()
}

/// Node `buildPersistedConversationInputIntent`: `[]` quotes are kept (truthy), a drained guide is `guided`, and
/// `attachments` defaults to `[]`.
#[test]
fn the_persisted_intent_is_nodes() {
    assert_eq!(
        persisted(&intent(), "ignored", "drained"),
        json!({
            "inputOrigin": "desktop",
            "conversationQuotes": [],
            "sourceCommandId": "c1",
            "queueItemId": "queue_c1",
            "clientId": "client",
            "kind": "sendText",
            "text": "hi",
            "attachments": [],
            "mode": "build",
            "planEnabled": false,
            "delivery": {"requested": "guide", "admitted": "guide"},
            "order": {"admissionSeq": 2},
            "steer": {"state": "guided"},
            "dispatch": {"state": "drained"},
            "admittedAt": 1500,
        })
    );
}

/// Node `inputIntentOfMessage` reads the persisted form back to the flat intent, `[]` quotes included.
#[test]
fn a_stored_intent_reads_back() {
    let info = json!({"metadata": message_metadata(&intent(), "hi")});
    let read = of_message(&info).unwrap();
    assert_eq!(read.quotes(), Some(Vec::new()));
    assert_eq!(read.text(), Some("hi"));
    assert_eq!(read.str("requestedDelivery"), Some("guide"));
    assert_eq!(read.get("admissionSeq"), Some(&json!(2)));
}

/// A legacy `inputIntent` alone counts when it has the fields Node checks; an invalid full intent falls back to it.
#[test]
fn a_legacy_intent_counts_only_when_complete() {
    let legacy = json!({"sourceCommandId": "cmd-1", "queueItemId": "queue_c1", "clientId": "client",
        "kind": "sendText", "admissionSeq": 1, "admittedAt": 1500, "requestedDelivery": "startNow",
        "admittedDelivery": "startNow", "attachmentRefs": []});
    let info = json!({"metadata": {"inputIntent": legacy, "conversationInputIntent": {"kind": "sendText"}}});
    assert_eq!(
        of_message(&info).map(|intent| intent.fields().clone()),
        legacy.as_object().cloned()
    );
    let partial = json!({"metadata": {"inputIntent": {"sourceCommandId": "c"}}});
    assert!(of_message(&partial).is_none());
    assert!(of_message(&json!({})).is_none());
}
