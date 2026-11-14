//! Fork: ACP rows ↔ Node `tool` parts marked `metadata.externalAgent` (specs/fork-rust-agent-parity.md "ACP external
//! agents", rule 5). Node `ExternalAgentToolRows.#finish`/`#persist` writes them; they are display rows, never model
//! tool calls, so a cold read gives `ContentBlock::ExternalTool` back in part order and no tool result message.
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::message::{ContentBlock, ExternalTool};
use serde_json::{Value, json};

use crate::records::RUST_CLI;

const EXTERNAL_AGENT: &str = "externalAgent";

/// A `tool` part written for an ACP row (by either runtime).
pub fn is_external(part: &Value) -> bool {
    part["type"] == "tool" && part["metadata"][EXTERNAL_AGENT] == true
}

/// Node's settled part for a row. Node's error state has no title, so the row's own title rides in the part's
/// `rustCli` marker for a cold read.
pub fn part(
    id: String,
    (session, message): (&str, &str),
    row: &ExternalTool,
    (start, end): (u64, u64),
) -> Value {
    let marker = json!({EXTERNAL_AGENT: true});
    let mut metadata = marker.clone();
    let state = if row.is_error {
        if !row.title.is_empty() {
            metadata[RUST_CLI] = json!({"title": row.title});
        }
        json!({"status": "error", "input": row.input, "error": row.output, "metadata": marker,
            "time": {"start": start, "end": end}})
    } else {
        let title = if row.title.is_empty() {
            &row.name
        } else {
            &row.title
        };
        json!({"status": "completed", "input": row.input, "output": row.output, "title": title,
            "metadata": marker, "time": {"start": start, "end": end}})
    };
    json!({"id": id, "sessionID": session, "messageID": message, "type": "tool",
        "callID": row.id.as_str(), "tool": row.name, "metadata": metadata, "state": state})
}

/// The row of a stored part. A part the turn never settled (the process died mid-tool) is an error row with the stored
/// error text, or none; a title equal to the tool name is Node's `row.title || row.toolName` fallback, not a title.
pub fn block(part: &Value) -> ContentBlock {
    let state = &part["state"];
    let name = part["tool"].as_str().unwrap_or("").to_owned();
    let completed = state["status"] == "completed";
    let title = state["title"]
        .as_str()
        .or_else(|| part["metadata"][RUST_CLI]["title"].as_str())
        .filter(|title| *title != name)
        .unwrap_or("")
        .to_owned();
    let output = if completed {
        &state["output"]
    } else {
        &state["error"]
    };
    ContentBlock::ExternalTool(Box::new(ExternalTool {
        id: ToolUseId::new(part["callID"].as_str().unwrap_or("")),
        title,
        input: if state["input"].is_object() {
            state["input"].clone()
        } else {
            json!({})
        },
        output: output.as_str().unwrap_or("").to_owned(),
        is_error: !completed,
        name,
    }))
}
