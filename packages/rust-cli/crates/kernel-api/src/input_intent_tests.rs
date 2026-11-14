use serde_json::json;

use super::*;

fn intent(value: serde_json::Value) -> InputIntent {
    serde_json::from_value(value).unwrap()
}

#[test]
fn an_empty_quote_list_is_kept_and_adds_no_block() {
    let intent = intent(json!({"text": "hi", "conversationQuotes": []}));
    assert_eq!(intent.quotes(), Some(Vec::new()));
    assert!(intent.shows_intent_text());
    assert_eq!(intent.compose("hi"), "hi");
    assert_eq!(intent.typed("hi"), "hi");
}

#[test]
fn absent_quotes_are_none() {
    let intent = intent(json!({"text": "hi"}));
    assert_eq!(intent.quotes(), None);
    assert!(!intent.shows_intent_text());
}

#[test]
fn typed_strips_only_the_intents_own_block() {
    let intent = intent(json!({"text": "hi", "conversationQuotes": [{"text": "q"}]}));
    let composed = intent.compose("hi");
    assert_eq!(
        composed,
        "hi\n\n<conversation_quote>\n[{\"text\":\"q\"}]\n</conversation_quote>"
    );
    assert_eq!(intent.typed(&composed), "hi");
    assert_eq!(intent.typed(&intent.compose("")), "");
    // A block the intent did not write stays part of the text.
    let other = "hi\n\n<conversation_quote>\n[{\"text\":\"x\"}]\n</conversation_quote>";
    assert_eq!(intent.typed(other), other);
}

#[test]
fn the_intent_keeps_nodes_key_order() {
    let intent = intent(json!({"sourceCommandId": "c", "text": "t", "admissionSeq": 1}));
    assert_eq!(
        serde_json::to_string(&intent).unwrap(),
        r#"{"sourceCommandId":"c","text":"t","admissionSeq":1}"#
    );
}

/// A commented quote's block ends with Node's guidance; the typed text is still what comes before both.
#[test]
fn typed_strips_the_block_and_the_comment_guidance() {
    let intent =
        intent(json!({"text": "hi", "conversationQuotes": [{"text": "q", "comment": "why?"}]}));
    let composed = intent.compose("hi");
    assert!(composed.ends_with(crate::conversation_quote::COMMENT_GUIDANCE));
    assert_eq!(intent.typed(&composed), "hi");
    assert_eq!(intent.typed(&intent.compose("")), "");
}
