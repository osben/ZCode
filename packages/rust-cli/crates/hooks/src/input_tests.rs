//! 输入 JSON 的字段与键序（spec §3.1）。

use rust_cli_kernel_api::hooks::{HookContext, HookEventName};
use rust_cli_kernel_api::ids::{AgentId, SessionId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use serde_json::json;

use super::*;
use crate::test_support::workspace;

#[test]
fn base_fields_come_first_in_order() {
    let event = HookEvent {
        context: HookContext {
            mode: Some(PermissionMode::AcceptEdits),
            agent: Some(AgentId::new("agent_1")),
            agent_type: Some("Explore".to_owned()),
            ..HookContext::default()
        },
        ..HookEvent::new(
            HookEventName::PreToolUse,
            SessionId::new("sess_1"),
            workspace(),
            json!({"tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_use_id": "toolu_1"}),
        )
    };
    assert_eq!(
        build(&event, "/Users/dev/project/sub").to_string(),
        r#"{"session_id":"sess_1","transcript_path":"","cwd":"/Users/dev/project/sub","permission_mode":"acceptEdits","agent_id":"agent_1","agent_type":"Explore","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"toolu_1"}"#
    );
}

#[test]
fn absent_context_fields_are_omitted() {
    let event = HookEvent::new(
        HookEventName::Notification,
        SessionId::new("sess_1"),
        workspace(),
        json!({"message": "m", "notification_type": "idle_prompt"}),
    );
    assert_eq!(
        build(&event, "/w").to_string(),
        r#"{"session_id":"sess_1","transcript_path":"","cwd":"/w","hook_event_name":"Notification","message":"m","notification_type":"idle_prompt"}"#
    );
    assert_eq!(hook_name("PreToolUse", Some("Bash")), "PreToolUse:Bash");
    assert_eq!(hook_name("Stop", None), "Stop");
}

#[test]
fn node_input_adds_camel_case_base_and_tool_fields_equal_to_their_aliases() {
    let event = HookEvent {
        context: HookContext {
            mode: Some(PermissionMode::AcceptEdits),
            agent_type: Some("Explore".to_owned()),
            ..HookContext::default()
        },
        ..HookEvent::new(
            HookEventName::PostToolUse,
            SessionId::new("sess_1"),
            workspace(),
            json!({"tool_name": "Write", "tool_input": {"file_path": "a"}, "tool_response": [{"type": "text"}], "tool_use_id": "toolu_1"}),
        )
    };
    let input = node_compatible(&event, "/w", 0);
    let text = with_transcript(input, "/tmp/zcode-hook-x/transcript.jsonl");
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["hookEventName"], "PostToolUse");
    assert_eq!(value["hook_event_name"], "PostToolUse");
    assert_eq!(value["sessionId"], "sess_1");
    assert_eq!(value["session_id"], "sess_1");
    assert_eq!(value["cwd"], "/w");
    assert_eq!(value["mode"], "edit");
    assert_eq!(value["permission_mode"], "edit");
    assert_eq!(value["agentName"], "Explore");
    assert_eq!(value["agent_type"], "Explore");
    assert_eq!(
        value["transcriptPath"],
        "/tmp/zcode-hook-x/transcript.jsonl"
    );
    assert_eq!(
        value["transcript_path"],
        "/tmp/zcode-hook-x/transcript.jsonl"
    );
    assert_eq!(value["toolName"], "Write");
    assert_eq!(value["toolInput"], json!({"file_path": "a"}));
    assert_eq!(value["toolCallId"], "toolu_1");
    assert_eq!(value["toolResponse"], json!([{"type": "text"}]));
}

#[test]
fn node_input_takes_the_session_mode_where_the_event_has_no_permission_mode() {
    let event = HookEvent {
        context: HookContext {
            session_mode: Some(PermissionMode::Default),
            ..HookContext::default()
        },
        ..HookEvent::new(
            HookEventName::SessionStart,
            SessionId::new("sess_1"),
            workspace(),
            json!({"source": "startup", "model": "m"}),
        )
    };
    let value: serde_json::Value =
        serde_json::from_str(&with_transcript(node_compatible(&event, "/w", 0), "/t")).unwrap();
    assert_eq!(value["mode"], "build");
    assert_eq!(value["permission_mode"], "build");
    assert!(value.get("toolName").is_none());
    // The Claude Code stdin keeps SessionStart without `permission_mode`.
    assert!(build(&event, "/w").get("permission_mode").is_none());
}

#[test]
fn transcript_text_is_the_stop_reply_or_the_prompt() {
    let stop = HookEvent::new(
        HookEventName::Stop,
        SessionId::new("sess_1"),
        workspace(),
        json!({"stop_hook_active": false, "last_assistant_message": "done"}),
    );
    assert_eq!(
        transcript_text(&stop),
        "{\"message\":{\"content\":[{\"text\":\"done\",\"type\":\"text\"}],\"role\":\"assistant\"}}\n"
    );
    let prompt = HookEvent::new(
        HookEventName::UserPromptSubmit,
        SessionId::new("sess_1"),
        workspace(),
        json!({"prompt": "hi"}),
    );
    assert_eq!(
        transcript_text(&prompt),
        "{\"message\":{\"content\":[{\"text\":\"hi\",\"type\":\"text\"}],\"role\":\"user\"}}\n"
    );
    let tool = HookEvent::new(
        HookEventName::PreToolUse,
        SessionId::new("sess_1"),
        workspace(),
        json!({"tool_name": "Bash"}),
    );
    assert_eq!(transcript_text(&tool), "");
}

fn node(
    name: HookEventName,
    context: HookContext,
    payload: serde_json::Value,
) -> serde_json::Value {
    let event = HookEvent {
        context,
        ..HookEvent::new(name, SessionId::new("sess_1"), workspace(), payload)
    };
    // 2025-11-13T00:00:00.000Z
    serde_json::from_str(&with_transcript(
        node_compatible(&event, "/w", 1_762_992_000_000),
        "/t",
    ))
    .unwrap()
}

/// Fork: Node's `HookInput` fields that Rust has the data for (`contracts/src/hooks/index.ts`; the Node hook callers
/// `runtime/methods/hooks.ts`, `tool/executor/hook-flow.ts`).
#[test]
fn node_input_carries_the_node_event_fields() {
    let stop = node(
        HookEventName::Stop,
        HookContext::default(),
        json!({"stop_hook_active": true, "last_assistant_message": "done"}),
    );
    assert_eq!(stop["timestamp"], "2025-11-13T00:00:00.000Z");
    assert_eq!(stop["responseText"], "done");
    assert_eq!(stop["responsePreview"], "done");
    assert_eq!(stop["stopHookActive"], true);

    let failure = node(
        HookEventName::PostToolUseFailure,
        HookContext::default(),
        json!({"tool_name": "Bash", "error": "boom", "is_interrupt": false,
               "error_details": {"message": "boom", "type": "tool_execution_failed"}}),
    );
    assert_eq!(failure["isInterrupt"], false);
    assert_eq!(failure["error"], "boom");
    assert_eq!(failure["error_details"]["type"], "tool_execution_failed");

    let suggestions = json!([{"type": "addRules"}]);
    let request = node(
        HookEventName::PermissionRequest,
        HookContext::default(),
        json!({"tool_name": "Bash", "permission_suggestions": suggestions}),
    );
    assert_eq!(request["permissionSuggestions"], suggestions);

    let compact = node(
        HookEventName::PreCompact,
        HookContext::default(),
        json!({"trigger": "manual", "custom_instructions": "keep it"}),
    );
    assert_eq!(compact["customInstructions"], "keep it");
    assert_eq!(compact["trigger"], "manual");

    let start = node(
        HookEventName::SessionStart,
        HookContext {
            selection: Some(ModelSelection::new("zhipu", "glm-5")),
            ..HookContext::default()
        },
        json!({"source": "startup", "model": "glm-5"}),
    );
    assert_eq!(start["model"], "zhipu/glm-5");
    assert_eq!(start["source"], "startup");
    // Without the selection the model id stays as the Claude Code input has it.
    let compacted = node(
        HookEventName::SessionStart,
        HookContext::default(),
        json!({"source": "compact", "model": "glm-5"}),
    );
    assert_eq!(compacted["model"], "glm-5");
}

/// Node `truncateForHook` (Stop, 4000 characters and `...`) and `previewHookValue` (PostToolUse, the JSON text cut at
/// 4000 characters and `...[truncated]`), counted in UTF-16 units as JS strings are.
#[test]
fn node_previews_cut_at_four_thousand_characters() {
    let long = "é".repeat(4001);
    let stop = node(
        HookEventName::Stop,
        HookContext::default(),
        json!({"stop_hook_active": false, "last_assistant_message": long}),
    );
    assert_eq!(stop["responseText"], long.as_str());
    assert_eq!(
        stop["responsePreview"],
        format!("{}...", "é".repeat(4000)).as_str()
    );

    let content = json!([{"type": "text", "text": "ran ls"}]);
    let short = node(
        HookEventName::PostToolUse,
        HookContext::default(),
        json!({"tool_name": "Bash", "tool_response": content}),
    );
    assert_eq!(short["toolResultPreview"], content.to_string().as_str());
    let text = json!("x".repeat(4001));
    let long = node(
        HookEventName::PostToolUse,
        HookContext::default(),
        json!({"tool_name": "Bash", "tool_response": text}),
    );
    // A string response is previewed as is, not as JSON.
    assert_eq!(
        long["toolResultPreview"],
        format!("{}...[truncated]", "x".repeat(4000)).as_str()
    );
}

/// Node always sends `mode` (`HookInput.mode` is required); an event without one takes the default mode's name.
#[test]
fn node_input_always_has_a_mode() {
    let notification = node(
        HookEventName::Notification,
        HookContext::default(),
        json!({"message": "m", "notification_type": "permission_prompt"}),
    );
    assert_eq!(notification["mode"], "build");
    assert_eq!(notification["permission_mode"], "build");
}

/// Node always sends the Stop reply (`responseText: ""` for a reply without text); the Claude Code input omits
/// `last_assistant_message` then.
#[test]
fn node_stop_input_without_reply_text_sends_empty_strings() {
    let stop = node(
        HookEventName::Stop,
        HookContext::default(),
        json!({"stop_hook_active": false}),
    );
    assert_eq!(stop["last_assistant_message"], "");
    assert_eq!(stop["responseText"], "");
    assert_eq!(stop["responsePreview"], "");
}
