//! What the runtime surfaces to a turn (Node `updates.ts`, `permissions.ts` and the driver's `toToolUpdate`).

use serde_json::Value;
use tokio::sync::oneshot;

use crate::config::ConfigOption;

/// One tool call or tool call update. `raw` is the whole ACP update; the driver reads `rawInput` and `content`.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallInfo {
    pub tool_call_id: String,
    pub title: String,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub raw: Value,
}

const TOOL_STATUSES: [&str; 4] = ["pending", "in_progress", "completed", "failed"];

impl ToolCallInfo {
    /// The title the user sees; a blank title is none (the row then shows the kind).
    pub fn display_title(&self) -> Option<&str> {
        (!self.title.trim().is_empty()).then_some(self.title.as_str())
    }

    /// A known status (`ExternalAgentToolStatus`); anything else is none.
    pub fn known_status(&self) -> Option<&str> {
        self.status
            .as_deref()
            .filter(|status| TOOL_STATUSES.contains(status))
    }

    /// `rawInput` of the update, when the agent sent one.
    pub fn input(&self) -> Option<&Value> {
        self.raw.get("rawInput")
    }

    /// `textOfToolContent`: text blocks verbatim and diffs as their path and new text, joined by newlines.
    pub fn output_text(&self) -> Option<String> {
        let content = self.raw.get("content")?.as_array()?;
        let mut chunks = Vec::new();
        for item in content {
            match item.get("type").and_then(Value::as_str) {
                Some("content") => {
                    let inner = item.get("content");
                    if inner
                        .and_then(|inner| inner.get("type"))
                        .and_then(Value::as_str)
                        == Some("text")
                        && let Some(text) = inner
                            .and_then(|inner| inner.get("text"))
                            .and_then(Value::as_str)
                    {
                        chunks.push(text.to_owned());
                    }
                }
                Some("diff") => {
                    if let Some(path) = item.get("path").and_then(Value::as_str) {
                        match item.get("newText").and_then(Value::as_str) {
                            Some(new_text) => chunks.push(format!("{path}\n{new_text}")),
                            None => chunks.push(path.to_owned()),
                        }
                    }
                }
                _ => {}
            }
        }
        (!chunks.is_empty()).then(|| chunks.join("\n"))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanEntry {
    pub content: String,
    pub priority: String,
    pub status: String,
}

/// One option of a permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionOption {
    pub option_id: String,
    pub kind: String,
    pub name: String,
}

/// A permission request of the agent, routed to the turn bound to the runtime (`AcpPermissionAsk`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionAsk {
    pub request_id: String,
    pub tool_call_id: String,
    pub title: String,
    pub detail: Option<String>,
    pub options: Vec<PermissionOption>,
}

/// The turn's answer: the kind of the chosen option (`allow_once`, `reject_once`, …) or cancelled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionAnswer {
    Selected { kind: String },
    Cancelled,
}

/// Events of the prompt that runs on the runtime, in the order the agent sent them.
#[derive(Debug)]
pub enum RuntimeEvent {
    MessageChunk(String),
    ThoughtChunk(String),
    ToolCall(ToolCallInfo),
    ToolCallUpdate(ToolCallInfo),
    Plan(Vec<PlanEntry>),
    SessionTitle(String),
    /// The agent advertised slash commands (only counted; never shown).
    AvailableCommands(usize),
    /// The agent changed its configuration (`config_option_update` / `current_mode_update`).
    ConfigOptions(Vec<ConfigOption>),
    /// The prompt produced no output for the stall window.
    Stalled {
        silent_ms: u64,
    },
    /// Output arrived again after a stall.
    Resumed,
    /// A permission request; the reply goes back to the agent. Dropping the sender answers cancelled.
    Permission {
        ask: PermissionAsk,
        reply: oneshot::Sender<PermissionAnswer>,
    },
}

fn text_of(content: Option<&Value>) -> Option<String> {
    let content = content?;
    (content.get("type").and_then(Value::as_str) == Some("text"))
        .then(|| content.get("text").and_then(Value::as_str))
        .flatten()
        .map(str::to_owned)
}

/// `None` without a string `toolCallId`: the ACP SDK rejects such an update on the Node side.
fn tool_call_info(update: &Value) -> Option<ToolCallInfo> {
    let text = |key: &str| update.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(ToolCallInfo {
        tool_call_id: text("toolCallId")?,
        title: text("title").unwrap_or_default(),
        kind: text("kind"),
        status: text("status"),
        raw: update.clone(),
    })
}

/// `mapSessionUpdate`: the update kinds a turn shows; `None` for anything else (usage, unknown kinds).
pub(crate) fn map_update(update: &Value) -> Option<RuntimeEvent> {
    match update.get("sessionUpdate").and_then(Value::as_str)? {
        "agent_message_chunk" => text_of(update.get("content")).map(RuntimeEvent::MessageChunk),
        "agent_thought_chunk" => text_of(update.get("content")).map(RuntimeEvent::ThoughtChunk),
        "tool_call" => tool_call_info(update).map(RuntimeEvent::ToolCall),
        "tool_call_update" => tool_call_info(update).map(RuntimeEvent::ToolCallUpdate),
        "plan" => {
            let entries = update.get("entries")?.as_array()?;
            let field = |entry: &Value, key: &str| {
                entry
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            Some(RuntimeEvent::Plan(
                entries
                    .iter()
                    .map(|entry| PlanEntry {
                        content: field(entry, "content"),
                        priority: field(entry, "priority"),
                        status: field(entry, "status"),
                    })
                    .collect(),
            ))
        }
        "session_info_update" => update
            .get("title")
            .and_then(Value::as_str)
            .map(|title| RuntimeEvent::SessionTitle(title.to_owned())),
        "available_commands_update" => Some(RuntimeEvent::AvailableCommands(
            update
                .get("availableCommands")
                .and_then(Value::as_array)
                .map_or(0, Vec::len),
        )),
        _ => None,
    }
}

/// `buildPermissionAsk` (the request id is built by the runtime).
pub(crate) fn permission_ask(params: &Value, request_id: String) -> PermissionAsk {
    let tool_call = params.get("toolCall");
    let text = |key: &str| {
        tool_call
            .and_then(|call| call.get(key))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .map(|option| {
                    let field = |key: &str| {
                        option
                            .get(key)
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned()
                    };
                    PermissionOption {
                        option_id: field("optionId"),
                        kind: field("kind"),
                        name: field("name"),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    PermissionAsk {
        request_id,
        tool_call_id: text("toolCallId"),
        title: text("title"),
        detail: permission_detail(tool_call),
        options,
    }
}

/// `extractPermissionDetail`: the first non-empty text content of the tool call.
fn permission_detail(tool_call: Option<&Value>) -> Option<String> {
    tool_call?
        .get("content")?
        .as_array()?
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("content"))
        .filter_map(|item| text_of(item.get("content")))
        .find(|text| !text.is_empty())
}

/// `toPermissionResponse`: the option whose kind matches the answer, otherwise cancelled.
pub(crate) fn permission_response(params: &Value, answer: &PermissionAnswer) -> Value {
    if let PermissionAnswer::Selected { kind } = answer
        && let Some(option_id) = params
            .get("options")
            .and_then(Value::as_array)
            .and_then(|options| {
                options
                    .iter()
                    .find(|option| option.get("kind").and_then(Value::as_str) == Some(kind))
            })
            .and_then(|option| option.get("optionId").and_then(Value::as_str))
    {
        return serde_json::json!({"outcome": {"outcome": "selected", "optionId": option_id}});
    }
    serde_json::json!({"outcome": {"outcome": "cancelled"}})
}

#[cfg(test)]
#[path = "updates_tests.rs"]
mod tests;
