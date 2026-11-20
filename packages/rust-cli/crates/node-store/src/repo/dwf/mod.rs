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

/// The error for a column whose value cannot be read. The column name travels in the message, and the
/// index is the column's real position in the statement. A name the statement does not select is a
/// programming error: it is never reported as column 0.
fn column_error(
    row: &Row<'_>,
    name: &'static str,
    source: impl Into<Box<dyn std::error::Error + Send + Sync>>,
) -> rusqlite::Error {
    let index = match row.as_ref().column_index(name) {
        Ok(index) => index,
        Err(_) => {
            debug_assert!(false, "dwf column {name} is not in the selected columns");
            usize::MAX
        }
    };
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        Box::new(ColumnError {
            column: name,
            source: source.into(),
        }),
    )
}

/// The source of a [`column_error`]: the column name, then the cause.
#[derive(Debug)]
struct ColumnError {
    column: &'static str,
    source: Box<dyn std::error::Error + Send + Sync>,
}

impl std::fmt::Display for ColumnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "column {}: {}", self.column, self.source)
    }
}

impl std::error::Error for ColumnError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

/// An optional JSON column where JSON `null` is absent (Node `decodeJson`).
fn json_column(row: &Row<'_>, name: &'static str) -> rusqlite::Result<Option<Value>> {
    let text: Option<String> = row.get(name)?;
    decode_json(text.as_deref()).map_err(|error| column_error(row, name, error))
}

/// A column where only SQL NULL is absent, and a stored JSON `null` is a present value. Node reads
/// `result_json` and `args_json` as `col !== null` then `JSON.parse`, with no falsy check, so the empty
/// string is corrupt here as it is there.
fn value_column(row: &Row<'_>, name: &'static str) -> rusqlite::Result<Option<Value>> {
    let text: Option<String> = row.get(name)?;
    text.map(|text| serde_json::from_str(&text).map_err(|error| column_error(row, name, error)))
        .transpose()
}

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<RunRecord> {
    let mut run = run_metadata_from_row(row)?;
    run.result = value_column(row, "result_json")?;
    Ok(run)
}

/// A run row without its result: the columns the host lists read (`LIST_COLUMNS`). The result is the
/// script's return value and is unbounded, so list reads never select it.
fn run_metadata_from_row(row: &Row<'_>) -> rusqlite::Result<RunRecord> {
    let physical: String = row.get("status")?;
    let physical = PhysicalStatus::from_column(&physical)
        .ok_or_else(|| column_error(row, "status", format!("unknown dwf_run status {physical}")))?;
    let failure_json: Option<String> = row.get("failure_json")?;
    let settlement = decode_run_settlement(physical, failure_json.as_deref())
        .map_err(|error| column_error(row, "failure_json", error))?;
    Ok(RunRecord {
        run_id: row.get("id")?,
        parent_session_id: row.get("parent_session_id")?,
        cwd: row.get("cwd")?,
        name: row.get("name")?,
        tool_call_id: row.get("tool_call_id")?,
        script_text: row.get("script_text")?,
        script_hash: row.get("script_hash")?,
        args: value_column(row, "args_json")?,
        resumed_from: row.get("resumed_from")?,
        max_concurrency: row.get("caps_max_concurrency")?,
        spent_tokens: row.get("spent_tokens")?,
        status: settlement.status,
        stop_reason: settlement.stop_reason,
        superseded_by: settlement.superseded_by,
        failure: settlement.failure,
        result: None,
    })
}

/// A run as a host list reads it (Node `DwfRunListItem` / `DwfRunSessionListItem`): the run without its
/// result, with the journal timestamps.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RunListRecord {
    pub run: RunRecord,
    pub time_created: i64,
    pub time_updated: i64,
}

/// The columns of a list read: `LIST_COLUMNS` is Node's list select, and `result_json` is left out on purpose.
const LIST_COLUMNS: &str = "id, parent_session_id, cwd, name, script_text, script_hash, args_json, \
     tool_call_id, resumed_from, caps_max_concurrency, spent_tokens, status, failure_json, \
     time_created, time_updated";

fn list_record_from_row(row: &Row<'_>) -> rusqlite::Result<RunListRecord> {
    Ok(RunListRecord {
        run: run_metadata_from_row(row)?,
        time_created: row.get("time_created")?,
        time_updated: row.get("time_updated")?,
    })
}

/// Filter and bound of Node's `listRuns` (the `ListWorkflowRuns` surface).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RunListQuery {
    /// Literal equality with `dwf_run.cwd`; `None` lists every project.
    pub cwd: Option<String>,
    /// Maximum rows; `0` is an empty page. There is no ceiling here: the caller probes `limit + 1`.
    pub limit: usize,
    /// `None` is no filter; `Some(empty)` matches no run.
    pub statuses: Option<Vec<RunStatus>>,
}

/// Node `listRunsByParentSession`: one parent session's runs, most recently updated first (ties by id),
/// up to `limit`. Dwf rows per session are few, so there is no index beyond the table's own.
pub fn list_runs_by_parent_session(
    conn: &Connection,
    parent_session_id: &str,
    limit: usize,
) -> Result<Vec<RunListRecord>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut statement = conn.prepare(&format!(
        "select {LIST_COLUMNS} from dwf_run
         where parent_session_id = ?1
         order by time_updated desc, id desc
         limit ?2"
    ))?;
    let rows = statement.query_map(
        params![parent_session_id, i64::try_from(limit).unwrap_or(i64::MAX)],
        list_record_from_row,
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Node `listRuns`: runs by project (optional) and status, most recently updated first, up to `limit`.
pub fn list_runs(conn: &Connection, query: &RunListQuery) -> Result<Vec<RunListRecord>> {
    if query.limit == 0 || query.statuses.as_ref().is_some_and(Vec::is_empty) {
        return Ok(Vec::new());
    }
    let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut sql = format!("select {LIST_COLUMNS} from dwf_run where 1 = 1");
    if let Some(cwd) = &query.cwd {
        sql.push_str(" and cwd = ?");
        values.push(Box::new(cwd.clone()));
    }
    if let Some(statuses) = &query.statuses {
        sql.push_str(" and ");
        sql.push_str(&status_predicate(statuses, &mut values));
    }
    // Node orders by time_updated only (divergence 251: ties break by id, so a page is stable).
    sql.push_str(" order by time_updated desc, id desc limit ?");
    values.push(Box::new(i64::try_from(query.limit).unwrap_or(i64::MAX)));
    let mut statement = conn.prepare(&sql)?;
    let rows = statement.query_map(
        rusqlite::params_from_iter(values.iter().map(AsRef::as_ref)),
        list_record_from_row,
    )?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Node `encodeRunStatusPredicate`: a logical status is a physical one, and `stopped` and `errored` share the
/// physical `cancelled` and `failed` with the failure code deciding. Pushes the bound values in order.
fn status_predicate(statuses: &[RunStatus], values: &mut Vec<Box<dyn rusqlite::ToSql>>) -> String {
    // The physical names come from `PhysicalStatus`, the one source of the column's vocabulary.
    let cancelled = PhysicalStatus::Cancelled.as_str();
    let failed = PhysicalStatus::Failed.as_str();
    let mut clauses = Vec::with_capacity(statuses.len());
    for status in statuses {
        clauses.push(match status {
            // Logical stopped and errored have no physical value: they are predicates on the failure code.
            RunStatus::Stopped => {
                values.push(Box::new(codecs::INTERRUPTED_CODE));
                format!(
                    "(status = '{cancelled}' or (status = '{failed}' and json_extract(failure_json, '$.code') = ?))"
                )
            }
            RunStatus::Errored => {
                values.push(Box::new(codecs::INTERRUPTED_CODE));
                format!(
                    "(status = '{failed}' and coalesce(json_extract(failure_json, '$.code'), '') <> ?)"
                )
            }
            // The plain statuses are their own physical value.
            RunStatus::Pending => physical_status_clause(PhysicalStatus::Pending, values),
            RunStatus::Running => physical_status_clause(PhysicalStatus::Running, values),
            RunStatus::Completed => physical_status_clause(PhysicalStatus::Completed, values),
        });
    }
    format!("({})", clauses.join(" or "))
}

fn physical_status_clause(
    physical: PhysicalStatus,
    values: &mut Vec<Box<dyn rusqlite::ToSql>>,
) -> String {
    values.push(Box::new(physical.as_str()));
    "status = ?".to_owned()
}

/// Node `createRun`: writes the run with its settlement (if the record already has one).
pub fn create_run(conn: &Connection, run: &RunRecord, now: i64) -> Result<()> {
    // The encoder reads only stop_reason, superseded_by and failure. The result is written from
    // `run.result` below, so it is not copied into the settlement.
    let settlement = Settlement {
        stop_reason: run.stop_reason,
        superseded_by: run.superseded_by.clone(),
        failure: run.failure.clone(),
        result: None,
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
                // Node keeps the sqlite error as `cause`; the chain shows the real constraint.
                return Err(anyhow::Error::new(error)
                    .context(format!("dwf journal: run already exists: {}", run.run_id)));
            }
            Err(error.into())
        }
    }
}

/// The row's `(time_created, time_updated)` (Node's `dwf_run` columns), for a detail read (9.42).
pub fn run_times(conn: &Connection, run_id: &str) -> Result<Option<(i64, i64)>> {
    conn.query_row(
        "select time_created, time_updated from dwf_run where id = ?1",
        params![run_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .context("read dwf_run times")
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
/// The orphan settlement, guarded (divergence 250): stops the run as `Stopped` with `settlement`, but only while the
/// row is still `pending` or `running`. Node's `updateRunStatus` is unconditional; a run that settled after it was
/// enumerated keeps its settlement here. `Ok(false)` means the row had already settled; an unknown run is an error.
pub fn interrupt_unsettled_run(
    conn: &Connection,
    run_id: &str,
    settlement: &Settlement,
    now: i64,
) -> Result<bool> {
    let encoded = encode_run_settlement(RunStatus::Stopped, settlement);
    let changed = conn.execute(
        &format!(
            "update dwf_run set status = ?1, failure_json = ?2,
                result_json = coalesce(?3, result_json), time_updated = ?4
             where id = ?5 and status in ('{}', '{}')",
            PhysicalStatus::Pending.as_str(),
            PhysicalStatus::Running.as_str(),
        ),
        params![
            encoded.status.as_str(),
            encoded.failure_json,
            encode_result_json(settlement.result.as_ref()),
            now,
            run_id,
        ],
    )?;
    if changed == 1 {
        return Ok(true);
    }
    let exists = conn
        .query_row(
            "select 1 from dwf_run where id = ?1",
            params![run_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if exists {
        Ok(false)
    } else {
        assert_touched(changed, run_id).map(|()| false)
    }
}

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
    Ok(ActorRecord {
        run_id: row.get("run_id")?,
        site_id: row.get("site_id")?,
        ordinal: row.get("ordinal")?,
        name: row.get("name")?,
        persona: json_column(row, "persona_json")?,
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

fn node_kind_from_column(row: &Row<'_>, value: &str) -> rusqlite::Result<NodeKind> {
    Ok(match value {
        "ask" => NodeKind::Ask,
        "world-read" => NodeKind::WorldRead,
        "world-run" => NodeKind::WorldRun,
        "report" => NodeKind::Report,
        "artifact" => NodeKind::Artifact,
        other => {
            return Err(column_error(
                row,
                "kind",
                format!("unknown dwf_node kind {other}"),
            ));
        }
    })
}

/// An unknown status is corruption (the CHECK set is running, completed, failed): it errors like an
/// unknown kind instead of defaulting to a terminal state.
fn node_status_from_column(row: &Row<'_>, value: &str) -> rusqlite::Result<NodeStatus> {
    Ok(match value {
        "running" => NodeStatus::Running,
        "completed" => NodeStatus::Completed,
        "failed" => NodeStatus::Failed,
        other => {
            return Err(column_error(
                row,
                "status",
                format!("unknown dwf_node status {other}"),
            ));
        }
    })
}

fn node_from_row(row: &Row<'_>) -> rusqlite::Result<NodeRecord> {
    let kind: String = row.get("kind")?;
    let status: String = row.get("status")?;
    Ok(NodeRecord {
        run_id: row.get("run_id")?,
        site_id: row.get("site_id")?,
        ordinal: row.get("ordinal")?,
        kind: node_kind_from_column(row, &kind)?,
        actor_site_id: row.get("actor_site_id")?,
        actor_ordinal: row.get("actor_ordinal")?,
        actor_seq: row.get("actor_seq")?,
        input_hash: row.get("input_hash")?,
        status: node_status_from_column(row, &status)?,
        result: value_column(row, "result_json")?,
        error: json_column(row, "error_json")?,
        stats: json_column(row, "stats_json")?,
        artifact_id: row.get("artifact_id")?,
        input: json_column(row, "input_json")?,
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
    // JSON.stringify's text, not serde's: they differ on exponent-form numbers (1e21 is 1e+21 in Node).
    let payload = rust_cli_base::js::json::stringify(event);
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

/// Node `listEvents` with `types: "all"` and `reportItems: {limit: keep}` (9.50, divergence 564), the cold read of the run
/// detail. The `item` of every report event after the run's `keep`th report is removed in SQL (`json_remove`), as Node's
/// `listEventRows` does; the ranking is over the whole run. A cap of zero removes every item; a run with fewer than `keep`
/// reports keeps them all. Sequence, time and the other fields are read as `list_events` reads them.
pub fn list_events_with_report_cap(
    conn: &Connection,
    run_id: &str,
    keep: usize,
) -> Result<Vec<StoredEvent>> {
    let cutoff: i64 = if keep == 0 {
        -1
    } else {
        conn.query_row(
            "select sequence from dwf_event where run_id = ?1 and type = 'report' order by sequence limit 1 offset ?2",
            params![run_id, i64::try_from(keep - 1)?],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(i64::MAX)
    };
    let mut statement = conn.prepare(
        "select sequence,
                case when type = 'report' and sequence > ?2 then json_remove(payload_json, '$.item') else payload_json end,
                time_created
         from dwf_event where run_id = ?1 order by sequence",
    )?;
    let rows = statement.query_map(params![run_id, cutoff], |row| {
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

/// Node `listNodes({kinds: NON_REPORT_NODE_KINDS, withResult: false})` (9.50, divergence 564): the run's non-report rows in
/// insertion order, with `result_json` read as null. `input_json` is kept, as Node keeps it.
pub fn list_roster_nodes(conn: &Connection, run_id: &str) -> Result<Vec<NodeRecord>> {
    let columns = NODE_COLUMNS.replace("result_json", "null as result_json");
    let mut statement = conn.prepare(&format!(
        "select {columns} from dwf_node where run_id = ?1 and kind <> 'report' order by id"
    ))?;
    let rows = statement.query_map(params![run_id], node_from_row)?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(Into::into)
}

/// Node `listActors(runId, {withPersona: false})` (9.50, divergence 564): the run's actor rows in insertion order, with
/// `persona_json` read as null (the full system prompt has no reader in the run detail).
pub fn list_actors_without_persona(conn: &Connection, run_id: &str) -> Result<Vec<ActorRecord>> {
    let columns = ACTOR_COLUMNS.replace("persona_json", "null as persona_json");
    let mut statement = conn.prepare(&format!(
        "select {columns} from dwf_actor where run_id = ?1 order by id"
    ))?;
    let rows = statement.query_map(params![run_id], actor_from_row)?;
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

/// The fields of a dynamic-workflow actor's session row (Node `createActorSession`).
pub struct WorkflowActorSession<'a> {
    pub id: &'a str,
    pub parent_session_id: &'a str,
    pub directory: &'a str,
    pub title: &'a str,
    pub trace_id: &'a str,
    pub version: &'a str,
    pub created_at: i64,
}

/// Node `createActorSession`: a `workflow_child` session under the run's parent session. Node's owned-tree rules
/// (`OWNED_CHILD_TASK_TYPES`) and the tree walk key on this task type, so it is not the subagent kind's
/// `subagent_child`. The row goes through the same `repo::sessions::create` as every other session.
pub fn create_workflow_actor_session(
    conn: &Connection,
    session: &WorkflowActorSession<'_>,
) -> rusqlite::Result<()> {
    let input = crate::repo::sessions::Create {
        id: session.id.to_owned(),
        project_id: crate::ids::project_id(session.directory),
        workspace_id: None,
        parent_id: Some(session.parent_session_id.to_owned()),
        trace_id: Some(session.trace_id.to_owned()),
        task_type: Some("workflow_child".to_owned()),
        slug: crate::ids::slugify(session.id),
        directory: session.directory.to_owned(),
        path: Some(session.directory.to_owned()),
        title: session.title.to_owned(),
        title_source: Some("default".to_owned()),
        version: session.version.to_owned(),
        permission: Some(serde_json::json!({"mode": "build"})),
        time_created: Some(session.created_at),
        incognito: None,
    };
    crate::repo::sessions::create(conn, &input, session.created_at)
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
#[path = "workflow_actor_tests.rs"]
mod workflow_actor_tests;

#[cfg(test)]
#[path = "golden_tests.rs"]
mod golden_tests;

#[cfg(test)]
#[path = "dwf_list_tests.rs"]
mod dwf_list_tests;
