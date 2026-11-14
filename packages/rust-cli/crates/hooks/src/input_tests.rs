//! 输入 JSON 的字段与键序（spec §3.1）。

use rust_cli_kernel_api::hooks::{HookContext, HookEventName};
use rust_cli_kernel_api::ids::{AgentId, SessionId};
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
    let input = node_compatible(&event, "/w");
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
        serde_json::from_str(&with_transcript(node_compatible(&event, "/w"), "/t")).unwrap();
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
