//! Fork: `session/subagents` — the App's subagent directory pane (Node `listSessionSubagents`
//! / `subagent-session-query.ts`; specs/fork-rust-agent-parity.md).
//!
//! The store supplies the raw rows through `StoreQueries::subagent_rows` / `subagent_children`
//! (the parent row and the active-branch subagent tool parts, then the child rows by candidate
//! id). Everything past that is a straight port of Node's pure projection: candidates from the
//! tool parts (metadata merged with `state.metadata`, the launch-ACK `agentId` fallback, the
//! `sess_subagent_<agentId>` session-id fallback), the running/ended classification, and the
//! ended pagination with base64url cursors.
//!
//! The Rust kernel persists no subagent spawn/stop events and has no background-task registry;
//! its live subagent table (`SessionHandle::subagents`) is the single live source and stands in
//! for Node's background tasks, child projections and spawn relations — including seeding
//! candidates for just-spawned subagents whose link fact has not landed yet (Node gets those
//! from the spawn events).

use base64::Engine;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::panels::{SubagentEntry, SubagentStatus};
use rust_cli_kernel_api::store::StoreError;
use rust_cli_protocol_core::rpc::RpcError;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

use crate::server::{SESSION_UNAVAILABLE, Server};

/// zod `zcodeSessionSubagentsParamsSchema.endedLimit` default.
const DEFAULT_ENDED_LIMIT: usize = 20;
/// Node `STREAM_RECOVERY_DISCARDED_ERROR_NAME`: a partial assistant persisted by stream
/// recovery is not a terminal child outcome.
const STREAM_RECOVERY_DISCARDED: &str = "StreamRecoveryDiscarded";

fn invalid() -> RpcError {
    RpcError::invalid_params("Invalid params")
}

/// Node `listSessionSubagents` on an unknown parent (zod protocol error `sessionUnavailable`).
fn unavailable(session_id: &str) -> RpcError {
    RpcError::new(
        SESSION_UNAVAILABLE,
        format!("Session not found: {session_id}"),
    )
}

// ---- params (zod `zcodeSessionSubagentsParamsSchema`, strict) ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    session_id: String,
    #[serde(default, deserialize_with = "present")]
    ended_cursor: Option<Value>,
    #[serde(default, deserialize_with = "present")]
    ended_limit: Option<Value>,
}

/// A present member stays `Some` even when it is `null`: zod's `.optional()` and `.default()`
/// only cover an absent member, so an explicit `null` must fail validation.
fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

/// Node `parseParams`: `sessionId` / `endedCursor` are trimmed non-empty strings (zod `.trim()`
/// transforms the value, so the trimmed form is what the handler uses), `endedLimit` an integer
/// in 1..=100 defaulting to 20. Present-but-invalid values fail with `-32602`.
fn parse_params(params: &Value) -> Result<(String, Option<String>, usize), RpcError> {
    let body: Params = serde_json::from_value(params.clone()).map_err(|_| invalid())?;
    let session_id = non_empty(&Value::String(body.session_id)).ok_or_else(invalid)?;
    let ended_cursor = match body.ended_cursor {
        None => None,
        Some(Value::String(raw)) => Some(non_empty(&Value::String(raw)).ok_or_else(invalid)?),
        // zod rejects `null` and non-string cursors, not only malformed strings.
        Some(_) => return Err(invalid()),
    };
    let ended_limit = match body.ended_limit {
        None => DEFAULT_ENDED_LIMIT,
        // JS `Number.isInteger` accepts integral floats, so `20.0` is a valid zod int.
        Some(value) => value
            .as_f64()
            .filter(|limit| limit.fract() == 0.0 && (1.0..=100.0).contains(limit))
            .map(|limit| limit as usize)
            .ok_or_else(invalid)?,
    };
    Ok((session_id, ended_cursor, ended_limit))
}

// ---- shared value helpers (Node's own small predicates) ----

/// Node `nonEmptyString`: a string that is non-empty after trimming.
fn non_empty(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// Node `stringField`: the first key whose value is a non-empty (trimmed) string.
fn field(source: Option<&Map<String, Value>>, keys: &[&str]) -> Option<String> {
    let source = source?;
    keys.iter()
        .find_map(|key| source.get(*key).and_then(non_empty))
}

/// Node `parseJsonObject`: the completed output parsed as a JSON object; anything else is null.
fn parse_json_object(value: &str) -> Option<Map<String, Value>> {
    serde_json::from_str::<Value>(value)
        .ok()?
        .as_object()
        .cloned()
}

/// Node `agentIdFromLaunchAcknowledgement`: a background Agent's persisted output is the plain
/// launch ACK; its stable `agentId:` line recovers the agent when neither the output JSON nor
/// the metadata carries it (a cold query has no transient spawn event).
fn agent_id_from_launch_acknowledgement(output: Option<&str>) -> Option<String> {
    let output = output?;
    output.lines().find_map(|line| {
        let rest = line.strip_prefix("agentId:")?.trim_start();
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '(')
            .unwrap_or(rest.len());
        let token = &rest[..end];
        (!token.is_empty()).then(|| token.to_owned())
    })
}

/// Node `contentBlocksToText`: the non-empty `text` members of the blocks joined with a blank
/// line, or nothing when that is empty.
fn content_blocks_to_text(content: Option<&Value>) -> Option<String> {
    let blocks = content?.as_array()?;
    let joined = blocks
        .iter()
        .filter_map(|block| block.get("text").and_then(non_empty))
        .collect::<Vec<_>>()
        .join("\n\n");
    (!joined.is_empty()).then_some(joined)
}

// ---- the store documents (node-store `subagent_rows`) ----

/// `StoreQueries::subagent_rows`.
#[derive(Deserialize, Default)]
struct ParentDoc {
    parent: Option<ParentRow>,
    #[serde(default)]
    parts: Vec<PartRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParentRow {
    time_updated: i64,
}

/// One subagent tool part of the active branch. `metadata` arrives already merged (the store
/// merges the part-level metadata with `state.metadata`, state wins).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartRow {
    #[serde(default)]
    call_id: String,
    #[serde(default)]
    tool: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    input: Value,
    output: Option<String>,
    error: Option<String>,
    #[serde(default)]
    metadata: Value,
    started_at: Option<u64>,
    ended_at: Option<u64>,
}

/// `StoreQueries::subagent_children`.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ChildrenDoc {
    #[serde(default)]
    children: Vec<ChildRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChildRow {
    id: String,
    task_type: String,
    time_updated: i64,
    #[serde(default)]
    last_assistant: Option<LastAssistant>,
}

/// The child's last assistant message (Node `lastChildOutcome`'s input). `error` is the raw
/// record — Node CLI rows can carry one, rows written by this runtime do not yet.
#[derive(Deserialize, Default, Clone)]
#[serde(default, rename_all = "camelCase")]
struct LastAssistant {
    completed_at: Option<u64>,
    finish: Option<String>,
    error: Option<Value>,
    text: Option<String>,
    has_tool_part: bool,
}

// ---- candidates (Node `SubagentCandidate` / `candidateFromToolPart`) ----

struct Candidate {
    agent_id: String,
    child_session_id: String,
    call_id: String,
    run_in_background: bool,
    subagent_type: String,
    title: String,
    summary: Option<String>,
    part_status: String,
    output: Option<Map<String, Value>>,
    error: Option<String>,
    started_at: Option<u64>,
    ended_at: Option<u64>,
}

/// Node `candidateFromToolPart` (the relation argument is always absent here: the Rust kernel
/// persists no spawn events).
fn candidate_from_part(part: &PartRow) -> Option<Candidate> {
    if !matches!(part.tool.as_str(), "Agent" | "Task" | "subagent") {
        return None;
    }
    let completed_output = if part.status == "completed" {
        part.output
            .as_deref()
            .and_then(|output| non_empty(&Value::String(output.to_owned())))
    } else {
        None
    };
    let output = completed_output.as_deref().and_then(parse_json_object);
    let input = part.input.as_object().cloned().unwrap_or_default();
    let metadata = part.metadata.as_object().cloned().unwrap_or_default();
    let agent_id = field(output.as_ref(), &["agentId"])
        .or_else(|| agent_id_from_launch_acknowledgement(completed_output.as_deref()))
        .or_else(|| field(Some(&metadata), &["agentId"]));
    let child_session_id = field(output.as_ref(), &["childSessionId"])
        .or_else(|| field(Some(&metadata), &["childSessionId"]))
        // Node `createSessionId("subagent_<agentId>")` — the same id the runtime spawns with.
        .or_else(|| agent_id.as_ref().map(|id| format!("sess_subagent_{id}")))?;
    let title = field(output.as_ref(), &["description"])
        .or_else(|| field(Some(&input), &["description"]))
        .or_else(|| field(Some(&metadata), &["description"]))
        .or_else(|| field(Some(&input), &["prompt"]))
        .unwrap_or_else(|| "Subagent".to_owned());
    let subagent_type = field(output.as_ref(), &["agentType"])
        .or_else(|| field(Some(&metadata), &["agentType"]))
        .or_else(|| field(Some(&input), &["subagent_type", "agent", "agentType"]))
        .unwrap_or_else(|| "subagent".to_owned());
    let summary = content_blocks_to_text(output.as_ref().and_then(|o| o.get("content")))
        .or_else(|| field(output.as_ref(), &["result", "summary"]))
        .or_else(|| {
            (part.status == "error")
                .then_some(part.error.as_deref())
                .flatten()
                .and_then(|error| non_empty(&Value::String(error.to_owned())))
        });
    Some(Candidate {
        agent_id: agent_id.unwrap_or_else(|| part.call_id.clone()),
        child_session_id,
        call_id: part.call_id.clone(),
        run_in_background: input.get("run_in_background") == Some(&Value::Bool(true)),
        subagent_type,
        title,
        summary,
        part_status: part.status.clone(),
        output,
        error: part.error.clone(),
        started_at: part.started_at,
        ended_at: part.ended_at,
    })
}

/// Node `collectCandidates` (without relations): first-occurrence order, and a later part for
/// the same child session replaces the earlier candidate in place (the Map semantics).
fn collect_candidates(parts: &[PartRow]) -> Vec<Candidate> {
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    for part in parts {
        let Some(candidate) = candidate_from_part(part) else {
            continue;
        };
        match index.get(&candidate.child_session_id) {
            Some(&slot) => candidates[slot] = candidate,
            None => {
                index.insert(candidate.child_session_id.clone(), candidates.len());
                candidates.push(candidate);
            }
        }
    }
    candidates
}

// ---- the child's own outcome (Node `lastChildOutcome`) ----

#[derive(Default)]
struct Outcome {
    ended_at: Option<u64>,
    status: Option<&'static str>,
    summary: Option<String>,
}

/// Node `CANCELLATION_PATTERN` (`/abort|cancel|interrupt|stop/i`) as a substring test.
fn cancellation(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    ["abort", "cancel", "interrupt", "stop"]
        .iter()
        .any(|part| lower.contains(part))
}

fn last_child_outcome(last: Option<&LastAssistant>) -> Outcome {
    let Some(last) = last else {
        return Outcome::default();
    };
    let error = last.error.as_ref().filter(|error| error.is_object());
    let error_name = error.and_then(|error| error.get("name").and_then(Value::as_str));
    // Stream recovery may persist a partial assistant with an error; the child resends from the
    // anchor, so that error is not terminal.
    if error_name == Some(STREAM_RECOVERY_DISCARDED) {
        return Outcome::default();
    }
    let completed = last.completed_at.filter(|at| *at != 0);
    let finish = last.finish.as_deref().filter(|finish| !finish.is_empty());
    let error_summary = error.and_then(|error| {
        field(
            error.get("data").and_then(Value::as_object),
            &["message", "error", "detail"],
        )
        .or_else(|| error_name.map(str::to_owned))
    });
    let text = last.text.clone();
    Outcome {
        ended_at: completed,
        summary: text.or(error_summary),
        status: if let Some(name) = error_name {
            Some(if cancellation(name) {
                "cancelled"
            } else {
                "failed"
            })
        } else if !last.has_tool_part && (completed.is_some() || finish.is_some()) {
            // Only a final assistant message without a tool round is a success: a completed step
            // after a tool call just means the child is still executing tools.
            Some("success")
        } else {
            None
        },
    }
}

// ---- live entries (the kernel's subagent table as Node's live facts) ----

/// The live entry as the classification sees it. It stands in for Node's background task, child
/// projection and spawn relation at once: `terminal` is Node's `terminalBackgroundStatus`, and
/// `started_at` / `ended_at` recover the registry timestamps from the elapsed / ended-ago
/// counters (stable: the kernel derives both from the recorded times).
struct LiveChild {
    child: String,
    agent: String,
    agent_type: String,
    description: String,
    background: bool,
    running: bool,
    waiting: bool,
    terminal: Option<&'static str>,
    started_at: Option<u64>,
    ended_at: Option<u64>,
}

impl LiveChild {
    fn of(entry: &SubagentEntry, now_ms: u64) -> Self {
        let (running, terminal) = match entry.status {
            SubagentStatus::Running => (true, None),
            SubagentStatus::Completed => (false, Some("success")),
            SubagentStatus::Failed => (false, Some("failed")),
            // A killed subagent was aborted by the user — Node's `cancelled`.
            SubagentStatus::Killed => (false, Some("cancelled")),
        };
        Self {
            child: entry.child.as_str().to_owned(),
            agent: entry.agent.as_str().to_owned(),
            agent_type: entry.agent_type.clone(),
            description: entry.description.clone(),
            background: entry.background,
            running,
            waiting: entry.waiting,
            terminal,
            started_at: Some(now_ms.saturating_sub(entry.elapsed_ms)),
            ended_at: entry.ended_ago_ms.map(|ago| now_ms.saturating_sub(ago)),
        }
    }
}

// ---- classification (Node `runningStatus` / `endedStatus`) ----

/// Node `runningStatus` with the live entry standing in for the background task and the child
/// projection (Node's `activeToolCalls` check is folded into the persisted part state: a live
/// parent with a pending part is Node's pending active tool call).
fn running_status(
    candidate: &Candidate,
    live: Option<&LiveChild>,
    parent_live: bool,
    outcome: &Outcome,
) -> Option<&'static str> {
    if let Some(live) = live.filter(|live| live.running) {
        // A blocked input is a background task waiting on interaction; a foreground child
        // waiting on the user is Node's child-projection `waiting`.
        if live.waiting {
            return Some(if live.background {
                "blocked"
            } else {
                "waiting"
            });
        }
        return Some("running");
    }
    // The background input itself is a recoverable running fact while nothing terminal is known
    // (Node's spawned-but-not-stopped case; here: no live entry and no child outcome).
    if candidate.run_in_background && live.is_none() && outcome.status.is_none() {
        return Some("running");
    }
    if parent_live && matches!(candidate.part_status.as_str(), "pending" | "running") {
        return Some("running");
    }
    None
}

/// Node `endedStatus` (`stoppedStatus` from spawn events never exists here).
fn ended_status(
    candidate: &Candidate,
    live: Option<&LiveChild>,
    outcome: &Outcome,
) -> &'static str {
    if let Some(status) = live.and_then(|live| live.terminal) {
        return status;
    }
    if candidate.part_status == "error" {
        return if candidate.error.as_deref().is_some_and(cancellation) {
            "cancelled"
        } else {
            "failed"
        };
    }
    if let Some(status) = candidate
        .output
        .as_ref()
        .and_then(|output| field(Some(output), &["status"]))
    {
        return match status.as_str() {
            "cancelled" | "stopped" => "cancelled",
            "failed" | "error" => "failed",
            // The ACK settled the part at launch; the child's own outcome decides, and an
            // unknown child is lost.
            "async_launched" => outcome.status.unwrap_or("lost"),
            _ if candidate.part_status == "completed" => "success",
            _ => outcome.status.unwrap_or("lost"),
        };
    }
    if candidate.part_status == "completed" {
        return "success";
    }
    outcome.status.unwrap_or("lost")
}

// ---- the projection (Node `projectSessionSubagents`) ----

struct ProjectionInput<'a> {
    parts: &'a [PartRow],
    children: &'a [ChildRow],
    live: &'a [SubagentEntry],
    parent_live: bool,
    now_ms: u64,
}

struct Projection {
    child_session_ids: Vec<String>,
    running: Vec<Value>,
    ended: Vec<EndedItem>,
}

/// The typed ended item (the sorting and cursor input); `value` is the wire JSON.
struct EndedItem {
    child_session_id: String,
    ended_at: u64,
    value: Value,
}

fn project(input: ProjectionInput<'_>) -> Projection {
    let ProjectionInput {
        parts,
        children,
        live,
        parent_live,
        now_ms,
    } = input;
    let live: Vec<LiveChild> = live
        .iter()
        .map(|entry| LiveChild::of(entry, now_ms))
        .collect();
    let mut candidates = collect_candidates(parts);
    // Seed candidates the spawn events would have given Node: a subagent the kernel is running
    // (or has just finished) whose link fact has not landed in a part yet.
    let known: HashSet<String> = candidates
        .iter()
        .map(|candidate| candidate.child_session_id.clone())
        .collect();
    for entry in &live {
        if !known.contains(entry.child.as_str()) {
            candidates.push(Candidate {
                agent_id: entry.agent.clone(),
                child_session_id: entry.child.clone(),
                call_id: String::new(),
                run_in_background: entry.background,
                subagent_type: entry.agent_type.clone(),
                title: entry.description.clone(),
                summary: None,
                part_status: String::new(),
                output: None,
                error: None,
                started_at: None,
                ended_at: None,
            });
        }
    }
    let children: HashMap<&str, &ChildRow> =
        children.iter().map(|row| (row.id.as_str(), row)).collect();
    let mut projection = Projection {
        child_session_ids: Vec::new(),
        running: Vec::new(),
        ended: Vec::new(),
    };
    for candidate in &candidates {
        // Node resolves each candidate id with `getSession` and keeps only `subagent_child`.
        let Some(child) = children
            .get(candidate.child_session_id.as_str())
            .filter(|child| child.task_type == "subagent_child")
        else {
            continue;
        };
        let live = live.iter().find(|entry| {
            entry.child == candidate.child_session_id || entry.agent == candidate.agent_id
        });
        let outcome = last_child_outcome(child.last_assistant.as_ref());
        projection
            .child_session_ids
            .push(candidate.child_session_id.clone());
        let started_at = live
            .and_then(|live| live.started_at)
            .or(candidate.started_at);
        let mut common = json!({
            "childSessionId": candidate.child_session_id,
            "subagentType": candidate.subagent_type,
            "title": candidate.title,
        });
        if !candidate.agent_id.is_empty() {
            common["agentId"] = json!(candidate.agent_id);
        }
        if !candidate.call_id.is_empty() {
            common["toolCallId"] = json!(candidate.call_id);
        }
        if let Some(at) = started_at {
            common["startedAt"] = json!(at);
        }
        match running_status(candidate, live, parent_live, &outcome) {
            Some(status) => {
                common["status"] = json!(status);
                projection.running.push(common);
            }
            None => {
                common["status"] = json!(ended_status(candidate, live, &outcome));
                if let Some(summary) = candidate
                    .summary
                    .clone()
                    .or_else(|| outcome.summary.clone())
                {
                    common["summary"] = json!(summary);
                }
                let ended_at = live
                    .and_then(|live| live.ended_at)
                    .or(candidate.ended_at)
                    .or(outcome.ended_at)
                    .unwrap_or_else(|| u64::try_from(child.time_updated).unwrap_or(0));
                common["endedAt"] = json!(ended_at);
                projection.ended.push(EndedItem {
                    child_session_id: candidate.child_session_id.clone(),
                    ended_at,
                    value: common,
                });
            }
        }
    }
    let started = |item: &Value| item["startedAt"].as_u64().unwrap_or(0);
    fn id_of(item: &Value) -> &str {
        item["childSessionId"].as_str().unwrap_or("")
    }
    // Node sorts `localeCompare` descending; these ids are ASCII (`sess_…`), where byte order
    // and locale order agree.
    projection.running.sort_by(|left, right| {
        started(right)
            .cmp(&started(left))
            .then_with(|| id_of(right).cmp(id_of(left)))
    });
    projection.ended.sort_by(|left, right| {
        right
            .ended_at
            .cmp(&left.ended_at)
            .then_with(|| right.child_session_id.cmp(&left.child_session_id))
    });
    projection
}

// ---- pagination (Node `paginateEndedSubagents`) ----

/// Node `encodeCursor`: base64url without padding of `{childSessionId, endedAt}`.
fn encode_cursor(child_session_id: &str, ended_at: u64) -> String {
    let payload = json!({"childSessionId": child_session_id, "endedAt": ended_at});
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string())
}

/// Node `decodeCursor`: `null` on any malformed input (pagination then restarts from the top).
/// `endedAt` only needs to be a number there, so the cursor comparison runs on floats.
fn decode_cursor(cursor: Option<&str>) -> Option<(String, f64)> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor?)
        .ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    if !value.is_object() {
        return None;
    }
    let child_session_id = field(value.as_object(), &["childSessionId"])?;
    let ended_at = value.get("endedAt")?.as_f64()?;
    Some((child_session_id, ended_at))
}

fn paginate_ended(
    ended: &[EndedItem],
    cursor: &Option<String>,
    limit: usize,
) -> (Vec<Value>, Option<String>) {
    let start = match decode_cursor(cursor.as_deref()) {
        None => Some(0),
        Some((cursor_id, cursor_at)) => ended.iter().position(|item| {
            let item_at = item.ended_at as f64;
            item_at < cursor_at
                || (item_at == cursor_at && item.child_session_id.as_str() < cursor_id.as_str())
        }),
    };
    // Everything sorts at or before the cursor: an empty page, like Node's `findIndex` -1.
    let Some(start) = start else {
        return (Vec::new(), None);
    };
    let stop = (start + limit).min(ended.len());
    let items = &ended[start..stop];
    let next_cursor = if start + items.len() < ended.len() {
        items
            .last()
            .map(|last| encode_cursor(&last.child_session_id, last.ended_at))
    } else {
        None
    };
    (
        items.iter().map(|item| item.value.clone()).collect(),
        next_cursor,
    )
}

// ---- the method ----

/// `session/subagents` (Node `listSessionSubagents`): params validated like the zod schema,
/// rows read through `StoreQueries`, the projection above, and Node's session-unavailable error
/// for a parent without a persisted row. Unlike Node there is no "store missing" empty path —
/// the kernel always has a store.
pub(crate) async fn subagents(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let (session_id, ended_cursor, ended_limit) = parse_params(params)?;
    let session = SessionId::new(&session_id);
    let queries = server.kernel.queries();
    let rows = queries
        .subagent_rows(&session)
        .await
        .map_err(|error| match error {
            StoreError::NotFound { .. } => unavailable(&session_id),
            other => RpcError::internal(other.to_string()),
        })?;
    let rows: ParentDoc = serde_json::from_value(rows)
        .map_err(|error| RpcError::internal(format!("subagent rows: {error}")))?;
    let Some(parent) = rows.parent else {
        return Err(unavailable(&session_id));
    };
    // Node's live parent is the revision source and the in-process subagent facts; a cold query
    // falls back to the parent row's updated time and the persisted rows alone.
    let bridged = server.bridge.get(&session);
    let (revision, live) = match &bridged {
        Some(live) => {
            let revision = live.sink.status().1;
            let entries = live.handle.subagents().await.unwrap_or_else(|error| {
                tracing::debug!(
                    event = "protocol.subagents.live_failed",
                    error = %error,
                    "reading the live subagent table failed"
                );
                Vec::new()
            });
            (revision, entries)
        }
        None => (u64::try_from(parent.time_updated).unwrap_or(0), Vec::new()),
    };
    // Children resolve by candidate id (Node `getSession` per id) — including the ids only the
    // live table knows, so the synthetic candidates pass the same persisted-row filter.
    let mut ids: Vec<String> = rows
        .parts
        .iter()
        .filter_map(candidate_from_part)
        .map(|candidate| candidate.child_session_id)
        .collect();
    for entry in &live {
        let id = entry.child.as_str().to_owned();
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let children = queries
        .subagent_children(ids)
        .await
        .map_err(|error| RpcError::internal(error.to_string()))?;
    let children: ChildrenDoc = serde_json::from_value(children)
        .map_err(|error| RpcError::internal(format!("subagent children: {error}")))?;
    let projection = project(ProjectionInput {
        parts: &rows.parts,
        children: &children.children,
        live: &live,
        parent_live: bridged.is_some(),
        now_ms: server.context.clock.now_ms(),
    });
    let (items, next_cursor) = paginate_ended(&projection.ended, &ended_cursor, ended_limit);
    let mut ended = json!({"total": projection.ended.len(), "items": items});
    if let Some(next_cursor) = next_cursor {
        ended["nextCursor"] = json!(next_cursor);
    }
    Ok(json!({
        "revision": revision,
        "childSessionIds": projection.child_session_ids,
        "running": projection.running,
        "ended": ended,
    }))
}

#[cfg(test)]
#[path = "subagents_tests.rs"]
mod tests;
