//! hook 输入 JSON（docs/specs/rust-cli/hooks.md §3.1）。
//!
//! 公共字段的键序：`session_id`、
//! `transcript_path`、`cwd`、`permission_mode`、`agent_id`、`agent_type`，之后是 `hook_event_name`
//! 与调用方给出的事件字段（键序保持）。

use rust_cli_kernel_api::hooks::{HookEvent, HookEventName};
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
/// stdin"): the Claude Code fields plus the camelCase base and tool fields. [`with_transcript`] adds the transcript
/// path to both keys.
pub(crate) fn node_compatible(event: &HookEvent, cwd: &str) -> Map<String, Value> {
    let mut input = fields(event, cwd);
    let context = &event.context;
    if let Some(agent_type) = &context.agent_type {
        input.insert("agentName".to_owned(), Value::from(agent_type.as_str()));
    }
    input.insert("hookEventName".to_owned(), Value::from(event.name.as_str()));
    // Node's `permission_mode` is its `mode` (the Node mode name), not the Claude Code name.
    if let Some(mode) = context.mode.or(context.session_mode) {
        input.insert("mode".to_owned(), Value::from(mode.node_name()));
        input.insert("permission_mode".to_owned(), Value::from(mode.node_name()));
    }
    input.insert("sessionId".to_owned(), Value::from(event.session.as_str()));
    for (alias, camel) in [
        ("tool_name", "toolName"),
        ("tool_input", "toolInput"),
        ("tool_use_id", "toolCallId"),
        ("tool_response", "toolResponse"),
    ] {
        if let Some(value) = input.get(alias).cloned() {
            input.insert(camel.to_owned(), value);
        }
    }
    input
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
