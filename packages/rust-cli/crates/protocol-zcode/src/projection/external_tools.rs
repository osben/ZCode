//! Fork: ACP rows (specs/fork-rust-agent-parity.md "ACP external agents", rules 5–7). Live, a row opens and updates
//! from `KernelEvent::ExternalToolRow` (Node's `ToolCallScheduled` / `ToolCallStarted` projection) and settles from
//! `ToolDone`; the settled row is then committed as a `ContentBlock::ExternalTool`, which a cold read turns into the
//! same row. A `TodoWrite` row also sets the snapshot `plan` (Node `todoPlanDeltas`).
use rust_cli_kernel_api::message::{AssistantMessage, ExternalTool};
use serde_json::{Map, Value, json};

use super::kinds::{RowKind, ToolStatus};
use super::{Projection, tool_key};

/// Node `PLAN_COLLECTION_KEYS`.
const PLAN_COLLECTION_KEYS: [&str; 4] = ["todos", "plan", "steps", "items"];

impl Projection {
    /// One `ExternalToolRow`: open the row (`inputStreaming`, or `running` once the agent started it), else take the
    /// new input and title. A settled row is never reopened.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn external_tool_row(
        &mut self,
        tool_use: &str,
        name: &str,
        title: &str,
        input: &Value,
        running: bool,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let key = tool_key(tool_use);
        if !self.index.contains_key(&key) {
            let turn = self
                .turn
                .as_ref()
                .map_or_else(|| self.session.clone(), |turn| turn.id.clone());
            let mut row = self.base(&turn, tool_use, RowKind::ToolCall, now, seq);
            row.insert("toolCallId".into(), json!(tool_use));
            row.insert("toolName".into(), json!(name));
            row.insert("status".into(), json!(ToolStatus::InputStreaming.as_str()));
            self.append(key.clone(), row, out);
        }
        self.upsert(
            &key,
            |row| {
                if ToolStatus::of(row).is_some_and(settled) {
                    return;
                }
                if !title.is_empty() {
                    row.insert("title".into(), json!(title));
                }
                row.insert("inputText".into(), json!(input.to_string()));
                row.insert("input".into(), input.clone());
                if running && ToolStatus::of(row) == Some(ToolStatus::InputStreaming) {
                    row.insert("status".into(), json!(ToolStatus::Running.as_str()));
                }
                if running {
                    row.entry("startedAt").or_insert(json!(now));
                }
            },
            out,
        );
        self.todo_plan(name, input, now, out);
    }

    /// A committed row: the live row (already settled by `ToolDone`) gets its reply message id; a cold read creates
    /// the settled row and its plan.
    pub(super) fn external_tool_block(
        &mut self,
        tool: &ExternalTool,
        assistant: &AssistantMessage,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let key = tool_key(tool.id.as_str());
        let cold = !self.index.contains_key(&key);
        if cold {
            self.external_tool_row(
                tool.id.as_str(),
                &tool.name,
                &tool.title,
                &tool.input,
                true,
                now,
                seq,
                out,
            );
        }
        let message_id = assistant.id.as_str().to_owned();
        self.upsert(
            &key,
            |row| {
                if cold || !ToolStatus::of(row).is_some_and(settled) {
                    let status = if tool.is_error {
                        ToolStatus::Error
                    } else {
                        ToolStatus::Success
                    };
                    row.insert("status".into(), json!(status.as_str()));
                    row.insert("output".into(), json!({"text": tool.output}));
                    row.insert("endedAt".into(), json!(now));
                    row.remove("approvalInteractionId");
                }
                row.insert("assistantResponseId".into(), json!(message_id));
            },
            out,
        );
    }

    /// Node `todoPlanDeltas(extractPlanStepsFromToolInput(...))`: a todo tool row's steps become the snapshot
    /// `plan`. Goal iterations are not projected (spec divergence).
    fn todo_plan(&mut self, name: &str, input: &Value, now: u64, out: &mut Vec<Value>) {
        if !is_todo_plan_tool_name(name) {
            return;
        }
        let Some(items) = plan_items(input) else {
            return;
        };
        let plan = json!({"items": items, "updatedAt": now});
        if self.plan_panel.as_ref() == Some(&plan) {
            return;
        }
        self.plan_panel = Some(plan.clone());
        out.push(json!({"op": "state.updated", "patch": {"plan": plan}}));
    }
}

fn settled(status: ToolStatus) -> bool {
    matches!(
        status,
        ToolStatus::Success | ToolStatus::Error | ToolStatus::Cancelled
    )
}

/// Node `isTodoPlanToolName`: `todo[_ -]*(read|write)` or `update[_ -]*plan` between word separators (`_`, `-`,
/// whitespace), ignoring case.
pub(super) fn is_todo_plan_tool_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let separator = |byte: u8| byte == b'_' || byte == b'-' || byte.is_ascii_whitespace();
    let word = |at: usize, word: &str| lower[at..].starts_with(word).then_some(at + word.len());
    let gap = |mut at: usize| {
        while at < bytes.len() && separator(bytes[at]) {
            at += 1;
        }
        at
    };
    let ends = |at: usize| at == bytes.len() || separator(bytes[at]);
    (0..bytes.len())
        .filter(|&at| at == 0 || separator(bytes[at - 1]))
        .any(|at| {
            let todo = word(at, "todo").and_then(|next| {
                let next = gap(next);
                word(next, "read").or_else(|| word(next, "write"))
            });
            let plan = word(at, "update").and_then(|next| word(gap(next), "plan"));
            todo.or(plan).is_some_and(ends)
        })
}

/// Node `extractPlanStepsFromValue` mapped like `todoPlanDeltas`: every item of the first array under a collection
/// key must parse, and an empty collection is no plan.
fn plan_items(input: &Value) -> Option<Vec<Value>> {
    let parsed;
    let value = match input {
        Value::String(text) => {
            parsed = serde_json::from_str::<Value>(text).ok()?;
            &parsed
        }
        other => other,
    };
    let record = value.as_object()?;
    let collection = PLAN_COLLECTION_KEYS
        .iter()
        .find_map(|key| record.get(*key).and_then(Value::as_array))?;
    if collection.is_empty() {
        return None;
    }
    collection
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let (id, title, status) = plan_step(item, index)?;
            let status = match status {
                "in_progress" => "inProgress",
                "completed" => "completed",
                _ => "pending",
            };
            Some(json!({"id": id, "content": title, "status": status}))
        })
        .collect()
}

/// Node `parsePlanStep`: (id, title, status); the id is never blank, so Node's `todo-N` fallback never applies.
fn plan_step(item: &Value, index: usize) -> Option<(String, String, &'static str)> {
    if let Some(text) = item.as_str() {
        let title = text.trim();
        let status = if index == 0 { "in_progress" } else { "pending" };
        return (!title.is_empty()).then(|| (title.to_owned(), title.to_owned(), status));
    }
    let record: &Map<String, Value> = item.as_object()?;
    let read = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
    };
    let title = ["content", "step", "title", "text", "activeForm"]
        .into_iter()
        .find_map(read)?;
    let status = match read("status")?
        .replace('-', "_")
        .to_ascii_lowercase()
        .as_str()
    {
        "pending" => "pending",
        "in_progress" => "in_progress",
        "completed" => "completed",
        _ => return None,
    };
    Some((
        read("id").unwrap_or(title).to_owned(),
        title.to_owned(),
        status,
    ))
}
