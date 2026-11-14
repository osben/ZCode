//! hook 输入 JSON（docs/specs/rust-cli/hooks.md §3.1）。
//!
//! 公共字段的键序：`session_id`、
//! `transcript_path`、`cwd`、`permission_mode`、`agent_id`、`agent_type`，之后是 `hook_event_name`
//! 与调用方给出的事件字段（键序保持）。

use rust_cli_base::js::{iso_timestamp, json, string};
use rust_cli_kernel_api::hooks::{HookEvent, HookEventName};
use rust_cli_kernel_api::permission::PermissionMode;
use serde_json::{Map, Value};

/// 组装输入 JSON。`cwd` 由引擎解析好（`context.cwd`、会话 shell cwd 或工作区根）。
pub(crate) fn build(event: &HookEvent, cwd: &str) -> Value {
    Value::Object(fields(event, cwd))
}

fn fields(event: &HookEvent, cwd: &str) -> Map<String, Value> {
    let mut input = Map::new();
    input.insert("session_id".to_owned(), Value::from(event.session.as_str()));
    // zcode 没有 JSONL 记录（D2）。
    input.insert("transcript_path".to_owned(), Value::from(""));
    input.insert("cwd".to_owned(), Value::from(cwd));
    let context = &event.context;
    if let Some(mode) = context.mode {
        input.insert(
            "permission_mode".to_owned(),
            serde_json::to_value(mode).unwrap_or(Value::Null),
        );
    }
    if let Some(agent) = &context.agent {
        input.insert("agent_id".to_owned(), Value::from(agent.as_str()));
    }
    if let Some(agent_type) = &context.agent_type {
        input.insert("agent_type".to_owned(), Value::from(agent_type.as_str()));
    }
    input.insert(
        "hook_event_name".to_owned(),
        Value::from(event.name.as_str()),
    );
    if let Value::Object(fields) = &event.payload {
        for (key, value) in fields {
            input.insert(key.clone(), value.clone());
        }
    }
    input
}

/// Fork: Node's command hook stdin (`createCompatibleHookStdin`, specs/fork-rust-agent-parity.md "Command hook
/// stdin"): the Claude Code fields plus the camelCase `HookInput` fields Rust has the data for. [`with_transcript`]
/// adds the transcript path to both keys.
pub(crate) fn node_compatible(event: &HookEvent, cwd: &str, now_ms: u64) -> Map<String, Value> {
    let mut input = fields(event, cwd);
    let context = &event.context;
    if let Some(agent_type) = &context.agent_type {
        input.insert("agentName".to_owned(), Value::from(agent_type.as_str()));
    }
    input.insert("hookEventName".to_owned(), Value::from(event.name.as_str()));
    // Node's `permission_mode` is its `mode` (the Node mode name), not the Claude Code name. Node's `mode` is
    // required, so an event without one names the default mode.
    let mode = context
        .mode
        .or(context.session_mode)
        .unwrap_or(PermissionMode::Default)
        .node_name();
    input.insert("mode".to_owned(), Value::from(mode));
    input.insert("permission_mode".to_owned(), Value::from(mode));
    input.insert("sessionId".to_owned(), Value::from(event.session.as_str()));
    input.insert("timestamp".to_owned(), Value::from(iso_timestamp(now_ms)));
    for (alias, camel) in [
        ("tool_name", "toolName"),
        ("tool_input", "toolInput"),
        ("tool_use_id", "toolCallId"),
        ("tool_response", "toolResponse"),
        ("permission_suggestions", "permissionSuggestions"),
        ("is_interrupt", "isInterrupt"),
        ("custom_instructions", "customInstructions"),
        ("stop_hook_active", "stopHookActive"),
        ("last_assistant_message", "responseText"),
    ] {
        if let Some(value) = input.get(alias).cloned() {
            input.insert(camel.to_owned(), value);
        }
    }
    match event.name {
        HookEventName::Stop => {
            let reply = input
                .get("last_assistant_message")
                .and_then(Value::as_str)
                .unwrap_or("");
            let preview = cut(reply, "...");
            input.insert("responsePreview".to_owned(), Value::from(preview));
        }
        HookEventName::PostToolUse => {
            if let Some(response) = input.get("tool_response") {
                let preview = tool_result_preview(response);
                input.insert("toolResultPreview".to_owned(), Value::from(preview));
            }
        }
        // Node's `model` is `<provider>/<model>`; the selection is known where the session starts.
        HookEventName::SessionStart => {
            if let Some(selection) = &context.selection {
                let model = format!("{}/{}", selection.provider, selection.model);
                input.insert("model".to_owned(), Value::from(model));
            }
        }
        _ => {}
    }
    input
}

/// Node's hook previews keep 4000 characters (UTF-16 units, as JS strings).
const PREVIEW_CHARS: usize = 4000;

/// Node `truncateForHook` / the cut of `previewHookValue`: the text, or its first [`PREVIEW_CHARS`] and `marker`.
fn cut(text: &str, marker: &str) -> String {
    if string::utf16_len(text) <= PREVIEW_CHARS {
        return text.to_owned();
    }
    format!("{}{marker}", string::utf16_prefix(text, PREVIEW_CHARS))
}

/// Node `previewHookValue`: a string as is, anything else as its JSON text.
fn tool_result_preview(response: &Value) -> String {
    match response {
        Value::String(text) => cut(text, "...[truncated]"),
        other => cut(&json::stringify(other), "...[truncated]"),
    }
}

/// Fork: the Node stdin text with `transcript_path` and `transcriptPath` set to `path`.
pub(crate) fn with_transcript(mut input: Map<String, Value>, path: &str) -> String {
    input.insert("transcript_path".to_owned(), Value::from(path));
    input.insert("transcriptPath".to_owned(), Value::from(path));
    Value::Object(input).to_string()
}

/// Fork: Node's transcript file text (`formatTranscript`): the Stop reply as an assistant line, the submitted prompt
/// as a user line, nothing for other events.
pub(crate) fn transcript_text(event: &HookEvent) -> String {
    let (role, key) = match event.name {
        HookEventName::Stop => ("assistant", "last_assistant_message"),
        HookEventName::UserPromptSubmit => ("user", "prompt"),
        _ => return String::new(),
    };
    let text = event.payload.get(key).and_then(Value::as_str).unwrap_or("");
    let line = serde_json::json!({
        "message": {"content": [{"text": text, "type": "text"}], "role": role},
    });
    format!("{line}\n")
}

/// `hookName`：有 match query 时是 `<事件>:<query>`。
pub(crate) fn hook_name(event: &str, query: Option<&str>) -> String {
    match query {
        Some(query) => format!("{event}:{query}"),
        None => event.to_owned(),
    }
}

#[cfg(test)]
#[path = "input_tests.rs"]
mod tests;
