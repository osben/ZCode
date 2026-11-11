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

/// Node `canonical-intent-replay.ts`: `payload.conversationQuotes ?? the edited input's quotes`.
#[test]
fn an_edit_keeps_the_stored_quotes_unless_it_sends_its_own() {
    let stored = vec![ContentBlock::Text {
        text: compose("original", &[quote("kept")]),
    }];
    assert_eq!(stored_quotes(&stored), [quote("kept")]);
    assert_eq!(
        stored_quotes(&[ContentBlock::Text {
            text: "plain".into()
        }]),
        []
    );

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

/// Node `fork-edit-retry.ts`: quotes alone are an input, so an edit that clears the text but keeps them is accepted.
#[test]
fn quotes_alone_are_an_edited_input() {
    let text = compose("", &[quote("kept")]);
    assert!(has_input(&[ContentBlock::Text { text }]));
    assert!(!has_input(&[ContentBlock::Text {
        text: compose("  ", &[])
    }]));
}
