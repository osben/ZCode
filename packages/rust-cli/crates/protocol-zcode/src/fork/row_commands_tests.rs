use rust_cli_kernel_api::conversation_quote::{Quote, compose};
use rust_cli_kernel_api::message::ContentBlock;
use serde_json::json;

use super::*;

fn quote(text: &str) -> Quote {
    Quote {
        text: text.to_owned(),
        path: None,
        sender_name: None,
        sender_id: None,
        message_id: None,
        sent_at: None,
    }
}

fn edit(extra: serde_json::Value) -> EditPayload {
    let mut body = json!({"target": {"rowId": 3, "entityId": "msg_u1"}, "newText": "edited"});
    body.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(body).unwrap()
}

fn envelope() -> Envelope {
    serde_json::from_value(json!({
        "commandId": "c9",
        "clientId": "client",
        "sessionId": "s",
        "type": "editUserQuery",
        "inputOrigin": "desktop",
    }))
    .unwrap()
}

fn stored_intent(extra: serde_json::Value) -> InputIntent {
    let mut fields = json!({
        "conversationQuotes": [{"text": "kept"}],
        "sourceCommandId": "c1",
        "queueItemId": "queue_c1",
        "clientId": "old",
        "kind": "sendText",
        "text": "original",
        "mode": "default",
        "admissionSeq": 1,
        "admittedAt": 10,
        "requestedDelivery": "queue",
        "admittedDelivery": "queue",
    });
    fields
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    serde_json::from_value(fields).unwrap()
}

/// Node `canonical-intent-replay.ts`: the payload parses absent, `[]` and quotes apart.
#[test]
fn an_edit_payload_keeps_absent_and_empty_quotes_apart() {
    assert_eq!(edit(json!({})).conversation_quotes, None);
    assert_eq!(
        edit(json!({"conversationQuotes": []})).conversation_quotes,
        Some(Vec::new())
    );
    assert_eq!(
        edit(json!({"conversationQuotes": [{"text": "new", "unknownKey": 1}]})).conversation_quotes,
        Some(vec![quote("new")])
    );
}

/// Node `inputIntentMetadataFromCanonical`: the edited input's intent with the new command, text and admission;
/// `payload.conversationQuotes ?? the stored quotes`; the stored command as provenance.
#[test]
fn an_edit_replays_the_stored_intent() {
    let stored = stored_intent(json!({}));
    let replayed = replayed_intent((7, 99), &envelope(), Some(&stored), "edited", None, None);
    assert_eq!(
        serde_json::to_value(&replayed).unwrap(),
        json!({
            "inputOrigin": "desktop",
            "conversationQuotes": [{"text": "kept"}],
            "sourceCommandId": "c9",
            "queueItemId": "queue_c9",
            "clientId": "client",
            "kind": "sendText",
            "text": "edited",
            "mode": "default",
            "admissionSeq": 7,
            "admittedAt": 99,
            "requestedDelivery": "queue",
            "admittedDelivery": "queue",
            "provenance": {"sourceCommandId": "c1", "queueItemId": "queue_c1", "clientId": "old"},
        })
    );
    let cleared = replayed_intent((7, 99), &envelope(), Some(&stored), "", Some(&[]), None);
    assert_eq!(cleared.quotes(), Some(Vec::new()));
    let new = [quote("new")];
    let replaced = replayed_intent((7, 99), &envelope(), Some(&stored), "", Some(&new), None);
    assert_eq!(replaced.quotes(), Some(new.to_vec()));
    // An input stored without an intent (TUI) gets Node's defaults.
    let fresh = replayed_intent((1, 5), &envelope(), None, "x", None, None);
    assert_eq!(fresh.quotes(), None);
    assert_eq!(fresh.str("requestedDelivery"), Some("startNow"));
    assert!(fresh.get("provenance").is_none());
}

/// A bot message's text has instructions after the quote block (Node `withConversationQuotes(…, botGroupSource)`);
/// its quotes still come from the intent, and Node's replay drops the bot source.
#[test]
fn a_bot_message_edit_keeps_the_quotes_from_the_intent() {
    let stored = stored_intent(json!({"botGroupSource": {"groupId": "g"}}));
    let replayed = replayed_intent((2, 3), &envelope(), Some(&stored), "edited", None, None);
    assert_eq!(replayed.quotes(), Some(vec![quote("kept")]));
    assert!(replayed.get("botGroupSource").is_none());
    let block = compose("", &[quote("kept")]);
    let bot = Stored {
        content: vec![ContentBlock::Text {
            text: format!("original\n\n{block}\n\nBot instructions"),
        }],
        intent: Some(stored),
    };
    // Retry submits the intent's text: the session adds the block once.
    assert_eq!(
        bot.typed(),
        [ContentBlock::Text {
            text: "original".into()
        }]
    );
}

/// Retry submits the typed text again; the session adds the block from the intent.
#[test]
fn a_retry_strips_only_the_intents_own_block() {
    let stored = stored_intent(json!({}));
    let quoted = Stored {
        content: vec![ContentBlock::Text {
            text: stored.compose("original"),
        }],
        intent: Some(stored.clone()),
    };
    assert_eq!(
        quoted.typed(),
        [ContentBlock::Text {
            text: "original".into()
        }]
    );
    let alone = Stored {
        content: vec![ContentBlock::Text {
            text: stored.compose(""),
        }],
        intent: Some(stored),
    };
    assert_eq!(alone.typed(), []);
}

/// Node `fork-edit-retry.ts`: quotes alone are an input, so an edit that clears the text but keeps them is accepted.
#[test]
fn quotes_alone_are_an_edited_input() {
    let quoted = stored_intent(json!({}));
    assert!(is_input(&[], &quoted));
    let empty = stored_intent(json!({"conversationQuotes": []}));
    assert!(!is_input(
        &[ContentBlock::Text { text: "  ".into() }],
        &empty
    ));
}
