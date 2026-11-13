use rust_cli_acp::{AcpError, AcpErrorCode, PromptResponse};
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message::{ContentBlock, ImageSource, Message, UserMessage, UserOrigin};
use serde_json::json;

use super::{prompt_blocks, prompt_failure, start_failure, usage_of};

fn user(id: &str, origin: UserOrigin, content: Vec<ContentBlock>) -> Message {
    Message::User(UserMessage {
        id: MessageId::new(id),
        content,
        origin,
        intent: None,
        stall_execution: None,
    })
}

fn text(text: &str) -> ContentBlock {
    ContentBlock::Text {
        text: text.to_owned(),
    }
}

#[test]
fn the_prompt_is_the_newest_human_input_with_its_images() {
    let image = ContentBlock::Image {
        source: ImageSource::Base64 {
            media_type: "image/png".to_owned(),
            data: "AAAA".to_owned(),
        },
        name: None,
    };
    let messages = [
        user("u1", UserOrigin::Human, vec![text("old")]),
        user(
            "u2",
            UserOrigin::Human,
            vec![text("look"), image, text("here")],
        ),
        user(
            "u3",
            UserOrigin::Human,
            vec![text("[Request interrupted by user]")],
        ),
    ];
    assert_eq!(
        prompt_blocks(&messages),
        vec![
            json!({"type": "text", "text": "look\nhere"}),
            json!({"type": "image", "mimeType": "image/png", "data": "AAAA"}),
        ]
    );
    assert_eq!(
        prompt_blocks(&[]),
        vec![json!({"type": "text", "text": ""})]
    );
}

#[test]
fn usage_maps_the_four_counts_and_is_absent_without_them() {
    let response = |usage| PromptResponse {
        stop_reason: "end_turn".to_owned(),
        usage,
    };
    let usage = usage_of(&response(Some(json!({
        "inputTokens": 10, "outputTokens": 5, "cachedReadTokens": 3, "cachedWriteTokens": 2, "thoughtTokens": 9,
    }))))
    .expect("usage");
    assert_eq!(
        (
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_input_tokens,
            usage.cache_creation_input_tokens
        ),
        (10, 5, 3, 2)
    );
    assert!(usage_of(&response(Some(json!({"thoughtTokens": 9})))).is_none());
    assert!(usage_of(&response(None)).is_none());
}

#[test]
fn failures_use_the_node_texts() {
    let error = |code, message: &str| AcpError::new(code, message);
    assert_eq!(
        start_failure("cursor", &error(AcpErrorCode::SpawnFailed, "ENOENT")),
        "Cursor could not be started. Check that it is installed and that its launch settings are correct."
    );
    assert_eq!(
        start_failure("cursor", &error(AcpErrorCode::Rpc, "Unauthorized")),
        "Cursor requires sign-in. Run \"cursor-agent login\" in a terminal, then send your message again."
    );
    for code in [AcpErrorCode::AgentDied, AcpErrorCode::StreamClosed] {
        assert_eq!(
            prompt_failure("opencode", &error(code, "gone")),
            "opencode stopped during the turn. Send the message again to restart it."
        );
    }
    assert_eq!(
        prompt_failure("opencode", &error(AcpErrorCode::Rpc, "boom")),
        "opencode could not complete the turn: boom"
    );
}
