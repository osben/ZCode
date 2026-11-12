//! Fork: the read side of the App's subagent directory (`session/subagents`, Node
//! `listSessionSubagents`; specs/fork-rust-agent-parity.md).
//!
//! Storage-shaped queries only: the parent document (the session row plus the subagent tool
//! parts of the active conversation branch) and the child rows resolved by candidate id. The
//! running/ended projection is a port of Node's `subagent-session-query.ts` and lives in the
//! protocol layer; these documents are exactly its inputs.
//!
//! Node reads the same data with `getSession` / `messages` and trims the branch with
//! `selectActiveConversationBranch` (the revert cursor only — no compaction trimming, the pane
//! lists subagents across the whole branch).

use rusqlite::Connection;
use rust_cli_kernel_api::store::StoreError;
use rust_cli_node_records::branch::{self, Branch};
use rust_cli_node_records::row::WithParts;
use serde_json::{Map, Value, json};
use std::borrow::Cow;

use crate::OrStorage;
use crate::repo::{messages, sessions};

/// The tool names that can spawn a subagent (Node `SUBAGENT_TOOL_NAMES`). Other tool parts can
/// never become candidates, so they never enter the document.
const SUBAGENT_TOOLS: [&str; 3] = ["Agent", "Task", "subagent"];

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

/// The parent document: `{parent: {id, timeUpdated} | null, parts: [...]}`. A missing session
/// row yields `parent: null` — the protocol layer turns that into Node's session-unavailable
/// error. `timeUpdated` is Node's cold `revision` fallback (`parentSession.time.updated`).
pub(crate) fn parent_rows(conn: &Connection, session: &str) -> Result<Value, StoreError> {
    let Some(parent) = sessions::get(conn, session).storage()? else {
        return Ok(json!({"parent": null, "parts": []}));
    };
    let all = messages::messages(conn, session).storage()?;
    // Node `activeBranchMessages`: only the revert cursor, unlike the cold history read.
    let active = branch::select_branch(
        all.iter().map(Cow::Borrowed).collect(),
        &Branch::from_revert(parent.revert.as_ref()),
    );
    let parts: Vec<Value> = active
        .iter()
        .flat_map(|record| record.parts.iter())
        .filter(|part| {
            part["type"] == "tool"
                && part["tool"]
                    .as_str()
                    .is_some_and(|tool| SUBAGENT_TOOLS.contains(&tool))
        })
        .map(part_row)
        .collect();
    Ok(json!({
        "parent": {"id": parent.id, "timeUpdated": parent.time_updated},
        "parts": parts,
    }))
}

/// One tool part shaped for the projection (Node `candidateFromToolPart`'s inputs): the
/// part-level and state-level metadata merged (state wins), the settled state fields and the
/// state times. Pending parts have no `time` member — `startedAt` / `endedAt` stay null.
fn part_row(part: &Value) -> Value {
    let mut metadata = object(&part["metadata"]);
    for (key, value) in object(&part["state"]["metadata"]) {
        metadata.insert(key, value);
    }
    json!({
        "callId": part["callID"],
        "tool": part["tool"],
        "status": part["state"]["status"],
        "input": part["state"]["input"],
        "output": part["state"]["output"],
        "error": part["state"]["error"],
        "metadata": metadata,
        "startedAt": part["state"]["time"]["start"],
        "endedAt": part["state"]["time"]["end"],
    })
}

/// The child rows for the collected candidate ids (`{children: [...]}`). Node resolves each id
/// with `getSession` (`select * from session where id = ?`, no deleted filter); an id without a
/// row is simply absent, and Node drops that candidate too. Resolving by id — not by
/// `parent_id` — keeps forked sessions working: their copied tool parts point at the original
/// session's children.
pub(crate) fn child_rows(conn: &Connection, ids: &[String]) -> Result<Value, StoreError> {
    let mut children = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(row) = sessions::get(conn, id).storage()? {
            children.push(child_row(conn, &row)?);
        }
    }
    Ok(json!({"children": children}))
}

fn child_row(conn: &Connection, row: &sessions::SessionRow) -> Result<Value, StoreError> {
    let messages = messages::messages(conn, &row.id).storage()?;
    Ok(json!({
        "id": row.id,
        "taskType": row.task_type,
        "timeUpdated": row.time_updated,
        "lastAssistant": last_assistant(&messages),
    }))
}

/// The child's last assistant message as Node `lastChildOutcome`'s input: the raw error record
/// (Node CLI rows can carry one; rows written by this runtime do not yet), the trimmed
/// non-ignored text parts joined with a blank line, and whether the turn still has a tool part
/// (a completed step after a tool call is not a terminal outcome).
fn last_assistant(messages: &[WithParts]) -> Value {
    let Some(last) = messages
        .iter()
        .rfind(|message| message.info["role"] == "assistant")
    else {
        return Value::Null;
    };
    let mut texts: Vec<&str> = Vec::new();
    for part in &last.parts {
        if part["type"] == "text"
            && part["ignored"] != true
            && let Some(text) = part["text"]
                .as_str()
                .map(str::trim)
                .filter(|t| !t.is_empty())
        {
            texts.push(text);
        }
    }
    json!({
        "completedAt": last.info["time"]["completed"],
        "finish": last.info["finish"],
        "error": last.info["error"],
        "text": if texts.is_empty() { Value::Null } else { json!(texts.join("\n\n")) },
        "hasToolPart": last.parts.iter().any(|part| part["type"] == "tool"),
    })
}

#[cfg(test)]
#[path = "subagent_rows_tests.rs"]
mod tests;
