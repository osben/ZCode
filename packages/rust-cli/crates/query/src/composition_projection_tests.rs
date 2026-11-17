//! Node parity for the sized message: `stringifyForEstimation({role, content, toolCalls, toolCallId, toolName})` of each
//! Node message, with `estimateTokens` over that string. The expected values come from
//! `tests/fixtures/composition_projection.json`, which `packages/rust-cli/tools/composition-fixture/generate.ts` writes by
//! running Node's own functions.

use super::*;
use rust_cli_base::js::json::stringify;
use rust_cli_base::js::string::utf16_len;
use rust_cli_base::tokens::estimate_text;
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::message::{ContentBlock, ToolResultContent};
use rust_cli_kernel_api::model::{ApiContent, ApiRole};
use serde_json::{Value, json};
use std::collections::HashMap;

const FIXTURE: &str = include_str!("../tests/fixtures/composition_projection.json");

fn block(block: ContentBlock) -> ApiContent {
    ApiContent {
        block,
        cache_control: None,
        meta: false,
    }
}

fn api(role: ApiRole, blocks: Vec<ContentBlock>) -> ApiMessage {
    ApiMessage {
        role,
        content: blocks.into_iter().map(block).collect(),
        output_config: None,
    }
}

fn text(value: &str) -> ContentBlock {
    ContentBlock::Text {
        text: value.to_owned(),
    }
}

fn tool_use(id: &str, name: &str, input: Value) -> ContentBlock {
    ContentBlock::ToolUse {
        id: ToolUseId::new(id),
        name: name.to_owned(),
        input,
    }
}

fn tool_result(id: &str, body: &str, is_error: bool) -> ContentBlock {
    ContentBlock::ToolResult {
        tool_use_id: ToolUseId::new(id),
        content: vec![ToolResultContent::Text {
            text: body.to_owned(),
        }],
        is_error,
    }
}

/// The wire messages each fixture case stands for. The Node input of each case is in the fixture.
fn wire_for(name: &str) -> Vec<ApiMessage> {
    match name {
        "user_text" => vec![api(ApiRole::User, vec![text("hello")])],
        "user_two_text_blocks" => {
            vec![api(ApiRole::User, vec![text("第一段 abc"), text("second")])]
        }
        "assistant_text_and_tool_call" => vec![api(
            ApiRole::Assistant,
            vec![
                text("Let me check."),
                tool_use("toolu_1", "Read", json!({"file_path": "/a/b.ts"})),
            ],
        )],
        "assistant_tool_calls_only" => vec![api(
            ApiRole::Assistant,
            vec![
                tool_use("toolu_2", "Bash", json!({"command": "ls -la"})),
                tool_use("toolu_3", "Grep", json!({"pattern": "a\"b", "path": "x"})),
            ],
        )],
        "tool_result_text" => vec![api(
            ApiRole::User,
            vec![tool_result(
                "toolu_1",
                "file body 中文 text\nline two",
                false,
            )],
        )],
        "tool_result_error" => vec![api(
            ApiRole::User,
            vec![tool_result("toolu_2", "Exit code 1", true)],
        )],
        "system_text" => vec![api(ApiRole::System, vec![text("You are a helpful agent.")])],
        "escapes_and_non_bmp" => vec![api(ApiRole::User, vec![text("a\"b\\c\nd\u{1} 😀 中")])],
        other => panic!("no wire form for fixture case {other}"),
    }
}

fn tool_names() -> HashMap<String, String> {
    [
        ("toolu_1", "Read"),
        ("toolu_2", "Bash"),
        ("toolu_3", "Grep"),
    ]
    .into_iter()
    .map(|(id, name)| (id.to_owned(), name.to_owned()))
    .collect()
}

#[test]
fn every_fixture_case_is_sized_as_node_sizes_it() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is JSON");
    let cases = fixture["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 8);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let projected = project(&wire_for(name), &tool_names());
        assert_eq!(projected.len(), 1, "{name}: one Node message");
        let bytes = stringify(&projected[0]);
        assert_eq!(
            bytes,
            case["projected"].as_str().expect("projected"),
            "{name}: bytes"
        );
        assert_eq!(
            utf16_len(&bytes) as u64,
            case["chars"].as_u64().expect("chars"),
            "{name}: chars"
        );
        assert_eq!(
            estimate_text(&bytes),
            case["tokens"].as_u64().expect("tokens"),
            "{name}: tokens"
        );
    }
}

/// Node sends a tool result as its own `tool` message, ahead of the user's text in the same turn.
#[test]
fn a_user_turn_with_a_tool_result_and_text_splits_into_two_node_messages() {
    let wire = vec![api(
        ApiRole::User,
        vec![tool_result("toolu_1", "ok", false), text("thanks")],
    )];
    let projected = project(&wire, &tool_names());
    assert_eq!(projected.len(), 2);
    assert_eq!(projected[0]["role"], "tool");
    assert_eq!(projected[0]["toolCallId"], "toolu_1");
    assert_eq!(projected[0]["toolName"], "Read");
    assert_eq!(projected[1], json!({"role": "user", "content": "thanks"}));
}

/// A tool result whose call is not in the request has no `toolName`; the key is absent, as Node's `undefined` is.
#[test]
fn an_unknown_tool_name_leaves_the_key_out() {
    let wire = vec![api(
        ApiRole::User,
        vec![tool_result("toolu_9", "ok", false)],
    )];
    let projected = project(&wire, &tool_names());
    assert_eq!(
        stringify(&projected[0]),
        r#"{"role":"tool","content":"ok","toolCallId":"toolu_9"}"#
    );
}
