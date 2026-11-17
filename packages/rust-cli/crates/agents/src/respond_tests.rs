//! RespondToCoordinator: input, the message the parent receives, and the reply text (Node
//! `tool/handlers/respond-to-coordinator.ts`, `subagent/coordinator-response.ts`).

use serde_json::json;

use super::{input_schema, message_text, parse, reply_text};

#[test]
fn input_is_strict_and_bounded_like_node() {
    assert!(parse(&json!({"summary": "ok", "message": "hi"})).is_ok());
    assert!(parse(&json!({"summary": "", "message": "hi"})).is_err());
    assert!(parse(&json!({"summary": "s".repeat(201), "message": "hi"})).is_err());
    assert!(parse(&json!({"summary": "s".repeat(200), "message": "hi"})).is_ok());
    assert!(parse(&json!({"summary": "ok", "message": ""})).is_err());
    assert!(parse(&json!({"summary": "ok", "message": "m".repeat(20_001)})).is_err());
    assert!(parse(&json!({"summary": "ok", "message": "m".repeat(20_000)})).is_ok());
    assert!(parse(&json!({"summary": "ok", "message": "hi", "to": "x"})).is_err());
    assert!(parse(&json!({"summary": "ok"})).is_err());
}

#[test]
fn schema_declares_the_same_bounds() {
    let schema = input_schema();
    assert_eq!(schema["additionalProperties"], json!(false));
    assert_eq!(schema["required"], json!(["summary", "message"]));
    assert_eq!(schema["properties"]["summary"]["minLength"], json!(1));
    assert_eq!(schema["properties"]["summary"]["maxLength"], json!(200));
    assert_eq!(schema["properties"]["message"]["maxLength"], json!(20_000));
}

#[test]
fn the_parent_gets_the_subagent_message_block_escaped() {
    assert_eq!(
        message_text("a1", "Explore", "s & t", "<m>"),
        "<subagent-message>\n<agent-id>a1</agent-id>\n<agent-type>Explore</agent-type>\n<summary>s &amp; t</summary>\n<message>&lt;m&gt;</message>\n</subagent-message>"
    );
}

#[test]
fn the_reply_text_matches_node() {
    assert_eq!(
        reply_text(&Ok("response_1".to_owned())),
        "Response response_1 was queued for the coordinator. Continue the current task unless the coordinator explicitly changed or ended it."
    );
    assert_eq!(
        reply_text(&Err(("response_1".to_owned(), "boom".to_owned()))),
        "Response response_1 failed to queue for the coordinator. Continue the current task unless the coordinator explicitly changed or ended it. Failure: boom."
    );
}
