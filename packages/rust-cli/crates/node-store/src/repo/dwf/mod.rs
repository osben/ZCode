//! The `dwf_*` journal of the dynamic workflow engine, on Node's session database (W2 of
//! specs/fork-rust-workflow-engine.md, sections 2.4 and 5.1).
//!
//! Rust writes the upstream tables in Node's exact format. Nothing here adds a table, a column, or a
//! migration: `0019_dwf_journal` is frozen (its checksum is pinned by `dwf_tests`). Every function takes
//! the connection and the caller's clock (`now`, epoch milliseconds), so Rust and the goldens share the
//! same inputs. Node's readers are the reference for every value; see `codecs` for the status mapping.
//!
//! Single writer per run: only the runtime that owns a run writes its rows (spec section 5.1, rule 4).
//! Reads here are the ones the engine and the W3 projection need; the artifact, introspection and
//! paged reads of Node's `dwf-journal-*.ts` come with the PRs that use them.
pub mod codecs;

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;
#[cfg(test)]
#[cfg(test)]
use std::path::Path;

use codecs::{
    PhysicalStatus, decode_json, decode_run_settlement, encode_json, encode_result_json,
    encode_run_settlement,
};

/// Logical run status (Node `RunStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RunStatus {
    #[default]
    Pending,
    Running,
    Completed,
    Errored,
    Stopped,
}

/// Why a run stopped (Node `RunStopReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    User,
    Model,
    Provider,
    Interrupted,
    Superseded,
}

/// Node `NodeKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NodeKind {
    #[default]
    Ask,
    WorldRead,
    WorldRun,
    Report,
    Artifact,
}

impl NodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::WorldRead => "world-read",
            Self::WorldRun => "world-run",
            Self::Report => "report",
            Self::Artifact => "artifact",
        }
    }
}

/// Node `NodeRecordStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NodeStatus {
    #[default]
    Running,
    Completed,
    Failed,
}

impl NodeStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

/// Node `RunRecord`. `max_concurrency` is `caps.maxConcurrency`. JSON fields stay JSON values: the
/// journal stores them verbatim and the engine owns their shapes.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RunRecord {
    pub run_id: String,
    pub parent_session_id: Option<String>,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub tool_call_id: Option<String>,
    pub script_text: Option<String>,
    pub script_hash: Option<String>,
    pub args: Option<Value>,
    pub resumed_from: Option<String>,
    pub max_concurrency: i64,
    pub spent_tokens: i64,
    pub status: RunStatus,
    pub stop_reason: Option<StopReason>,
    pub superseded_by: Option<String>,
    pub failure: Option<Value>,
    pub result: Option<Value>,
}

/// Node `RunSettlementRecord`: the terminal-state data written with a status.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Settlement {
    pub stop_reason: Option<StopReason>,
    pub superseded_by: Option<String>,
    pub failure: Option<Value>,
    pub result: Option<Value>,
}

/// Node `ActorRecord`, unique on (run, site, ordinal).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ActorRecord {
    pub run_id: String,
    pub site_id: String,
    pub ordinal: i64,
    pub name: Option<String>,
    pub persona: Option<Value>,
    pub session_id: Option<String>,
    pub resolved_model: Option<String>,
}

/// Node `NodeRecord`, unique on (run, site, ordinal).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct NodeRecord {
    pub run_id: String,
    pub site_id: String,
    pub ordinal: i64,
    pub kind: NodeKind,
    pub actor_site_id: Option<String>,
    pub actor_ordinal: Option<i64>,
    pub actor_seq: Option<i64>,
    pub input_hash: String,
    pub status: NodeStatus,
    pub result: Option<Value>,
    pub error: Option<Value>,
    pub stats: Option<Value>,
    pub artifact_id: Option<String>,
    pub input: Option<Value>,
    pub message_boundary: Option<i64>,
}

/// Node `StoredEvent`: the `RunEvent` verbatim plus its sequence and append time.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredEvent {
    pub sequence: i64,
    pub event: Value,
    pub time_created: i64,
}

/// One `session_task_link` row with role `workflow_actor` (Node `createSessionTaskLink`).
/// `root_workflow_run_id` stays NULL: it references the legacy `workflow_run` table, and the run
/// identity lives in `path` (`dwf/<runId>/<siteId>@<ordinal>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkflowActorLink<'a> {
    pub id: &'a str,
    pub child_session_id: &'a str,
    pub parent_session_id: Option<&'a str>,
    pub path: &'a str,
    pub status: &'a str,
}

const RUN_COLUMNS: &str = "id, parent_session_id, cwd, name, script_text, script_hash, args_json, \
     tool_call_id, resumed_from, caps_max_concurrency, spent_tokens, status, failure_json, result_json";

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<RunRecord> {
    let physical: String = row.get("status")?;
    let physical = PhysicalStatus::from_column(&physical).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            format!("unknown dwf_run status {physical}").into(),
        )
    })?;
    let failure_json: Option<String> = row.get("failure_json")?;
    let settlement = decode_run_settlement(physical, failure_json.as_deref());
    let args_json: Option<String> = row.get("args_json")?;
    let result_json: Option<String> = row.get("result_json")?;
    Ok(RunRecord {
        run_id: row.get("id")?,
        parent_session_id: row.get("parent_session_id")?,
        cwd: row.get("cwd")?,
        name: row.get("name")?,
        tool_call_id: row.get("tool_call_id")?,
        script_text: row.get("script_text")?,
        script_hash: row.get("script_hash")?,
        args: decode_json(args_json.as_deref()),
        resumed_from: row.get("resumed_from")?,
        max_concurrency: row.get("caps_max_concurrency")?,
        spent_tokens: row.get("spent_tokens")?,
        status: settlement.status,
        stop_reason: settlement.stop_reason,
        superseded_by: settlement.superseded_by,
        failure: settlement.failure,
        // Node: `result_json !== null` decodes, and a stored JSON null is a valid result.
        result: result_json
            .as_deref()
            .and_then(|text| serde_json::from_str(text).ok()),
    })
}

/// Node `createRun`: writes the run with its settlement (if the record already has one).
pub fn create_run(conn: &Connection, run: &RunRecord, now: i64) -> Result<()> {
    let settlement = Settlement {
        stop_reason: run.stop_reason,
        superseded_by: run.superseded_by.clone(),
        failure: run.failure.clone(),
        result: run.result.clone(),
    };
    let encoded = encode_run_settlement(run.status, &settlement);
    let inserted = conn.execute(
        "insert into dwf_run (
            id, parent_session_id, cwd, name, script_text, script_hash, tool_call_id,
            args_json, resumed_from, caps_max_concurrency, spent_tokens, status, failure_json,
            result_json, time_created, time_updated
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)",
        params![
            run.run_id,
            run.parent_session_id,
            run.cwd,
            run.name,
            run.script_text,
            run.script_hash,
            run.tool_call_id,
            encode_json(run.args.as_ref()),
            run.resumed_from,
            run.max_concurrency,
            run.spent_tokens,
            encoded.status.as_str(),
            encoded.failure_json,
            encode_result_json(run.result.as_ref()),
            now,
        ],
    );
    match inserted {
        Ok(_) => Ok(()),
        Err(error) => {
            if get_run(conn, &run.run_id)?.is_some() {
                bail!("dwf journal: run already exists: {}", run.run_id);
            }
            Err(error.into())
        }
    }
}

pub fn get_run(conn: &Connection, run_id: &str) -> Result<Option<RunRecord>> {
    conn.query_row(
        &format!("select {RUN_COLUMNS} from dwf_run where id = ?1"),
        params![run_id],
        run_from_row,
    )
    .optional()
    .context("read dwf_run")
}

/// Node `updateRunStatus`. A non-terminal status clears the settlement. A terminal one replaces
/// `failure_json` whole and keeps an earlier `result_json` when the new settlement has none.
pub fn update_run_status(
    conn: &Connection,
    run_id: &str,
    status: RunStatus,
    settlement: Option<&Settlement>,
    now: i64,
) -> Result<()> {
    let changed = match status {
        RunStatus::Pending | RunStatus::Running => conn.execute(
            "update dwf_run set status = ?1, failure_json = null, result_json = null, time_updated = ?2
             where id = ?3",
            params![
                if status == RunStatus::Pending { "pending" } else { "running" },
                now,
                run_id
            ],
        )?,
        _ => {
            let default = Settlement::default();
            let settlement = settlement.unwrap_or(&default);
            let encoded = encode_run_settlement(status, settlement);
            conn.execute(
                "update dwf_run set status = ?1, failure_json = ?2,
                    result_json = coalesce(?3, result_json), time_updated = ?4
                 where id = ?5",
                params![
                    encoded.status.as_str(),
                    encoded.failure_json,
                    encode_result_json(settlement.result.as_ref()),
                    now,
                    run_id,
                ],
            )?
        }
    };
    assert_touched(changed, run_id)
}

pub fn update_run_usage(
    conn: &Connection,
    run_id: &str,
    spent_tokens: i64,
    now: i64,
) -> Result<()> {
    let changed = conn.execute(
        "update dwf_run set spent_tokens = ?1, time_updated = ?2 where id = ?3",
        params![spent_tokens, now, run_id],
    )?;
    assert_touched(changed, run_id)
}

/// Node `updateRunCaps`: the only second writer of `caps_max_concurrency`.
pub fn update_run_caps(
    conn: &Connection,
    run_id: &str,
    max_concurrency: i64,
    now: i64,
) -> Result<()> {
    let changed = conn.execute(
        "update dwf_run set caps_max_concurrency = ?1, time_updated = ?2 where id = ?3",
        params![max_concurrency, now, run_id],
    )?;
    assert_touched(changed, run_id)
}

/// Node `updateRunScript`: text and hash change in one statement, so resume never sees a new text with
/// an old hash.
pub fn update_run_script(
    conn: &Connection,
    run_id: &str,
    script_text: &str,
    script_hash: &str,
    now: i64,
) -> Result<()> {
    let changed = conn.execute(
        "update dwf_run set script_text = ?1, script_hash = ?2, time_updated = ?3 where id = ?4",
        params![script_text, script_hash, now, run_id],
    )?;
    assert_touched(changed, run_id)
}

/// Node `listNonTerminalRuns`: the orphan-recovery query, scoped to one parent session. Rows with no
/// parent session belong to no session and never match.
pub fn list_non_terminal_runs(
    conn: &Connection,
    parent_session_id: &str,
) -> Result<Vec<RunRecord>> {
    let mut statement = conn.prepare(&format!(
        "select {RUN_COLUMNS} from dwf_run
         where parent_session_id = ?1 and status not in ('completed', 'failed', 'cancelled')
         order by id"
    ))?;
    let rows = statement.query_map(params![parent_session_id], run_from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Node `putActor`: a full-row upsert, so the caller passes the whole record.
pub fn put_actor(conn: &Connection, actor: &ActorRecord, now: i64) -> Result<()> {
    conn.execute(
        "insert into dwf_actor (
            run_id, site_id, ordinal, name, persona_json, session_id, resolved_model,
            time_created, time_updated
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         on conflict(run_id, site_id, ordinal) do update set
            name = excluded.name,
            persona_json = excluded.persona_json,
            session_id = excluded.session_id,
            resolved_model = excluded.resolved_model,
            time_updated = excluded.time_updated",
        params![
            actor.run_id,
            actor.site_id,
            actor.ordinal,
            actor.name,
            encode_json(actor.persona.as_ref()),
            actor.session_id,
            actor.resolved_model,
            now,
        ],
    )?;
    Ok(())
}

const ACTOR_COLUMNS: &str =
    "run_id, site_id, ordinal, name, persona_json, session_id, resolved_model";

fn actor_from_row(row: &Row<'_>) -> rusqlite::Result<ActorRecord> {
    let persona: Option<String> = row.get("persona_json")?;
    Ok(ActorRecord {
        run_id: row.get("run_id")?,
        site_id: row.get("site_id")?,
        ordinal: row.get("ordinal")?,
        name: row.get("name")?,
        persona: decode_json(persona.as_deref()),
        session_id: row.get("session_id")?,
        resolved_model: row.get("resolved_model")?,
    })
}

pub fn get_actor(
    conn: &Connection,
    run_id: &str,
    site_id: &str,
    ordinal: i64,
) -> Result<Option<ActorRecord>> {
    conn.query_row(
        &format!("select {ACTOR_COLUMNS} from dwf_actor where run_id = ?1 and site_id = ?2 and ordinal = ?3"),
        params![run_id, site_id, ordinal],
        actor_from_row,
    )
    .optional()
    .context("read dwf_actor")
}

/// Node `listActors` with no filters: insertion order (`order by id`).
pub fn list_actors(conn: &Connection, run_id: &str) -> Result<Vec<ActorRecord>> {
    let mut statement = conn.prepare(&format!(
        "select {ACTOR_COLUMNS} from dwf_actor where run_id = ?1 order by id"
    ))?;
    let rows = statement.query_map(params![run_id], actor_from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Node `putNode`: a full-row upsert. The identity columns (kind, actor coordinates, artifact,
/// input) are written on every call, so a settlement must carry them too.
pub fn put_node(conn: &Connection, node: &NodeRecord, now: i64) -> Result<()> {
    conn.execute(
        "insert into dwf_node (
            run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq,
            input_hash, status, result_json, error_json, stats_json, message_boundary,
            artifact_id, input_json, time_created, time_updated
         ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16)
         on conflict(run_id, site_id, ordinal) do update set
            kind = excluded.kind,
            actor_site_id = excluded.actor_site_id,
            actor_ordinal = excluded.actor_ordinal,
            actor_seq = excluded.actor_seq,
            input_hash = excluded.input_hash,
            status = excluded.status,
            result_json = excluded.result_json,
            error_json = excluded.error_json,
            stats_json = excluded.stats_json,
            message_boundary = excluded.message_boundary,
            artifact_id = excluded.artifact_id,
            input_json = excluded.input_json,
            time_updated = excluded.time_updated",
        params![
            node.run_id,
            node.site_id,
            node.ordinal,
            node.kind.as_str(),
            node.actor_site_id,
            node.actor_ordinal,
            node.actor_seq,
            node.input_hash,
            node.status.as_str(),
            encode_result_json(node.result.as_ref()),
            encode_json(node.error.as_ref()),
            encode_json(node.stats.as_ref()),
            node.message_boundary,
            node.artifact_id,
            encode_json(node.input.as_ref()),
            now,
        ],
    )?;
    Ok(())
}

const NODE_COLUMNS: &str = "run_id, site_id, ordinal, kind, actor_site_id, actor_ordinal, actor_seq, \
     input_hash, status, result_json, error_json, stats_json, message_boundary, artifact_id, input_json";

fn node_kind_from_column(value: &str) -> rusqlite::Result<NodeKind> {
    Ok(match value {
        "ask" => NodeKind::Ask,
        "world-read" => NodeKind::WorldRead,
        "world-run" => NodeKind::WorldRun,
        "report" => NodeKind::Report,
        "artifact" => NodeKind::Artifact,
        other => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("unknown dwf_node kind {other}").into(),
            ));
        }
    })
}

fn node_from_row(row: &Row<'_>) -> rusqlite::Result<NodeRecord> {
    let kind: String = row.get("kind")?;
    let status: String = row.get("status")?;
    let result_json: Option<String> = row.get("result_json")?;
    let error_json: Option<String> = row.get("error_json")?;
    let stats_json: Option<String> = row.get("stats_json")?;
    let input_json: Option<String> = row.get("input_json")?;
    Ok(NodeRecord {
        run_id: row.get("run_id")?,
        site_id: row.get("site_id")?,
        ordinal: row.get("ordinal")?,
        kind: node_kind_from_column(&kind)?,
        actor_site_id: row.get("actor_site_id")?,
        actor_ordinal: row.get("actor_ordinal")?,
        actor_seq: row.get("actor_seq")?,
        input_hash: row.get("input_hash")?,
        status: match status.as_str() {
            "running" => NodeStatus::Running,
            "completed" => NodeStatus::Completed,
            _ => NodeStatus::Failed,
        },
        result: result_json
            .as_deref()
            .and_then(|text| serde_json::from_str(text).ok()),
        error: decode_json(error_json.as_deref()),
        stats: decode_json(stats_json.as_deref()),
        artifact_id: row.get("artifact_id")?,
        input: decode_json(input_json.as_deref()),
        message_boundary: row.get("message_boundary")?,
    })
}

pub fn get_node(
    conn: &Connection,
    run_id: &str,
    site_id: &str,
    ordinal: i64,
) -> Result<Option<NodeRecord>> {
    conn.query_row(
        &format!("select {NODE_COLUMNS} from dwf_node where run_id = ?1 and site_id = ?2 and ordinal = ?3"),
        params![run_id, site_id, ordinal],
        node_from_row,
    )
    .optional()
    .context("read dwf_node")
}

/// Node `listNodes` with `kinds: "all"`: insertion order.
pub fn list_nodes(conn: &Connection, run_id: &str) -> Result<Vec<NodeRecord>> {
    let mut statement = conn.prepare(&format!(
        "select {NODE_COLUMNS} from dwf_node where run_id = ?1 order by id"
    ))?;
    let rows = statement.query_map(params![run_id], node_from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Node `appendEvent`: the sequence is allocated in the same statement as the insert, so two writers
/// cannot take the same number. The `type` column is the event's `type` field.
pub fn append_event(
    conn: &Connection,
    run_id: &str,
    event: &Value,
    now: i64,
) -> Result<StoredEvent> {
    let Some(kind) = event.get("type").and_then(Value::as_str) else {
        bail!("dwf journal: event without a type for run: {run_id}");
    };
    let payload = event.to_string();
    let sequence: i64 = conn.query_row(
        "insert into dwf_event (run_id, sequence, type, payload_json, time_created)
         values (
            ?1,
            coalesce((select max(sequence) + 1 from dwf_event where run_id = ?1), 0),
            ?2, ?3, ?4
         )
         returning sequence",
        params![run_id, kind, payload, now],
        |row| row.get(0),
    )?;
    Ok(StoredEvent {
        sequence,
        event: event.clone(),
        time_created: now,
    })
}

/// Node `listEvents` with `types: "all"`, no cursor and no limit: sequence order.
pub fn list_events(conn: &Connection, run_id: &str) -> Result<Vec<StoredEvent>> {
    let mut statement = conn.prepare(
        "select sequence, payload_json, time_created from dwf_event where run_id = ?1 order by sequence",
    )?;
    let rows = statement.query_map(params![run_id], |row| {
        let payload: String = row.get(1)?;
        let event = serde_json::from_str(&payload).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                1,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
        Ok(StoredEvent {
            sequence: row.get(0)?,
            event,
            time_created: row.get(2)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Node `createSessionTaskLink` for an actor: an upsert on `child_session_id` that moves only status
/// and time. The child session row must exist (foreign key).
pub fn insert_workflow_actor_link(
    conn: &Connection,
    link: &WorkflowActorLink<'_>,
    now: i64,
) -> Result<()> {
    conn.execute(
        "insert into session_task_link (
            id, root_workflow_run_id, parent_link_id, activity_id, parent_session_id,
            child_session_id, role, depth, path, phase, label, agent_type, model, status,
            time_created, time_updated
         ) values (?1, null, null, null, ?2, ?3, 'workflow_actor', 0, ?4, null, null, null, null, ?5, ?6, ?6)
         on conflict(child_session_id) do update set
            status = excluded.status,
            time_updated = excluded.time_updated",
        params![link.id, link.parent_session_id, link.child_session_id, link.path, link.status, now],
    )?;
    Ok(())
}

fn assert_touched(changed: usize, run_id: &str) -> Result<()> {
    if changed == 0 {
        bail!("dwf journal: unknown run: {run_id}");
    }
    Ok(())
}

#[cfg(test)]
#[path = "dwf_tests.rs"]
mod dwf_tests;

#[cfg(test)]
#[path = "golden_tests.rs"]
mod golden_tests;
