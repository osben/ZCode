//! The host's run queries and the orphan settlement over the dwf journal (Node `listNonTerminalRuns`,
//! `listRuns`, `listRunsByParentSession`, `getRun`, and the one write of `reconcileOrphanRuns`).
//!
//! These are host reads, so they sit beside the engine's `JournalPort` and not on it: the engine never
//! enumerates runs. `RunStore` is the port the run service holds; `SqliteRunStore` implements it over one
//! session database, whose connection the composition owns. Every write goes through the W2 repository
//! (`dwf::update_run_status`), so the rows keep Node's format.
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::Connection;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_node_store::dwf::{
    self, RunListQuery as DwfListQuery, Settlement as DwfSettlement, StopReason as DwfStop,
};
use serde_json::json;

use crate::journal_dwf::{row_from_dwf, status_to_dwf};
use crate::model::{RunRow, RunStatus};
use rust_cli_node_store::dwf::codecs::INTERRUPTED_CODE;

/// The message an orphan settlement writes (Node `interruptedRunFailure`, copied byte for byte).
pub fn interrupted_message(run_id: &str) -> String {
    format!(
        "dynamic workflow run {run_id} was interrupted: the owning process exited before the run settled"
    )
}

/// A run row with the journal timestamps a list shows. The row's `result` is never read by a list.
#[derive(Debug, Clone, PartialEq)]
pub struct RunListRow {
    pub run: RunRow,
    pub time_created: i64,
    pub time_updated: i64,
}

/// Node `listRuns` input. `cwd` filters by literal equality when set. `limit` is the row count, with no ceiling
/// (the caller probes `limit + 1`); `0` returns no rows. `statuses` filters by logical status when set, and
/// `Some(empty)` matches no run. There is no `Default`: an empty query would be an empty page by accident.
#[derive(Debug, Clone, PartialEq)]
pub struct RunListQuery {
    pub cwd: Option<String>,
    pub limit: usize,
    pub statuses: Option<Vec<RunStatus>>,
}

/// The host's run queries and its orphan settlement (see the module doc). Every method is synchronous and
/// short: the run service calls them under its own lock only for the orphan sweep.
pub trait RunStore: Send + Sync {
    /// Node `listNonTerminalRuns(parentSessionId)`: the parent's runs that have not settled, by id.
    fn non_terminal_runs(&self, parent_session_id: &str) -> Result<Vec<RunRow>>;
    /// Node `updateRunStatus(runId, "stopped", { stopReason: "interrupted", failure })`: the orphan settlement,
    /// guarded (divergence 250). Precondition: the caller has no live engine for the run. The write happens only
    /// while the row is still pending or running, so a run that settled after `non_terminal_runs` keeps its
    /// settlement and this returns `Ok(false)`. `Ok(true)` means the run was settled here. An unknown run is an error.
    /// Writes no event.
    fn interrupt_run(&self, run_id: &str) -> Result<bool>;
    /// Node `listRunsByParentSession(parentSessionId, limit)`.
    fn runs_of_session(&self, parent_session_id: &str, limit: usize) -> Result<Vec<RunListRow>>;
    /// Node `listRuns(query)`.
    fn list_runs(&self, query: &RunListQuery) -> Result<Vec<RunListRow>>;
    /// Node `getRun(runId)`.
    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>>;
    /// One run's detail read (9.42): the row with its timestamps, and the run's entry of the journal's replay (the
    /// run-panel fields: pending questions, holes, artifacts, phases, node entries, the launch settings).
    ///
    /// `Ok(None)` means the journal does not hold the run. `state` is `None` when `default_concurrency` is `None` (the
    /// replay needs the configured default, and none is fabricated here) and when the journal holds no event for the run
    /// yet, which is a row written before its first event. A store that cannot read details fails the read.
    fn run_detail(
        &self,
        run_id: &str,
        default_concurrency: Option<f64>,
    ) -> Result<Option<RunDetail>> {
        let _ = (run_id, default_concurrency);
        Err(anyhow::anyhow!("this run store does not read run details"))
    }
}

/// What one detail read holds, all from one snapshot of the journal (9.42).
#[derive(Debug, Clone)]
pub struct RunDetail {
    /// The row, with its timestamps.
    pub run: RunListRow,
    /// The run's entry of the journal's replay, as `RunStore::run_detail` documents it.
    pub state: Option<serde_json::Map<String, serde_json::Value>>,
}

/// The `RunStore` over one session database. `clock` stamps the rows a settlement writes.
pub struct SqliteRunStore {
    conn: Mutex<Connection>,
    clock: fn() -> i64,
}

impl SqliteRunStore {
    /// `conn` is a session database with Node's migrations applied (`open_session_database`).
    pub fn new(conn: Connection, clock: fn() -> i64) -> Self {
        Self {
            conn: Mutex::new(conn),
            clock,
        }
    }

    /// The connection, for a test that reads the rows directly.
    #[cfg(test)]
    pub(crate) fn lock_for_test(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock_unpoisoned()
    }
}

fn list_row(record: dwf::RunListRecord) -> RunListRow {
    RunListRow {
        run: row_from_dwf(record.run),
        time_created: record.time_created,
        time_updated: record.time_updated,
    }
}

impl RunStore for SqliteRunStore {
    fn non_terminal_runs(&self, parent_session_id: &str) -> Result<Vec<RunRow>> {
        let conn = self.conn.lock_unpoisoned();
        Ok(dwf::list_non_terminal_runs(&conn, parent_session_id)?
            .into_iter()
            .map(row_from_dwf)
            .collect())
    }

    fn interrupt_run(&self, run_id: &str) -> Result<bool> {
        let conn = self.conn.lock_unpoisoned();
        let settlement = DwfSettlement {
            stop_reason: Some(DwfStop::Interrupted),
            superseded_by: None,
            failure: Some(json!({
                "code": INTERRUPTED_CODE,
                "message": interrupted_message(run_id),
            })),
            result: None,
        };
        dwf::interrupt_unsettled_run(&conn, run_id, &settlement, (self.clock)())
    }

    fn runs_of_session(&self, parent_session_id: &str, limit: usize) -> Result<Vec<RunListRow>> {
        let conn = self.conn.lock_unpoisoned();
        Ok(
            dwf::list_runs_by_parent_session(&conn, parent_session_id, limit)?
                .into_iter()
                .map(list_row)
                .collect(),
        )
    }

    fn list_runs(&self, query: &RunListQuery) -> Result<Vec<RunListRow>> {
        let conn = self.conn.lock_unpoisoned();
        let dwf_query = DwfListQuery {
            cwd: query.cwd.clone(),
            limit: query.limit,
            statuses: query
                .statuses
                .as_ref()
                .map(|statuses| statuses.iter().copied().map(status_to_dwf).collect()),
        };
        Ok(dwf::list_runs(&conn, &dwf_query)?
            .into_iter()
            .map(list_row)
            .collect())
    }

    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>> {
        let conn = self.conn.lock_unpoisoned();
        Ok(dwf::get_run(&conn, run_id)?.map(row_from_dwf))
    }

    fn run_detail(
        &self,
        run_id: &str,
        default_concurrency: Option<f64>,
    ) -> Result<Option<RunDetail>> {
        // The row, its timestamps and its events are read under one lock hold, so they are one snapshot. The replay
        // folds the events after the lock is released.
        let (record, time_created, time_updated, events) = {
            let conn = self.conn.lock_unpoisoned();
            let Some(record) = dwf::get_run(&conn, run_id)? else {
                return Ok(None);
            };
            let Some((created, updated)) = dwf::run_times(&conn, run_id)? else {
                anyhow::bail!("the run {run_id} has a row without timestamps");
            };
            let events = dwf::list_events(&conn, run_id)?;
            (record, created, updated, events)
        };
        let state = default_concurrency.and_then(|default| {
            let replayed = rust_cli_node_store::replay_run_state(
                &record,
                &events,
                default,
                &rust_cli_node_store::WORKFLOW_RUN_LIMITS,
            )?;
            replayed
                .runs
                .into_iter()
                .find(|run| run.get("runId").and_then(serde_json::Value::as_str) == Some(run_id))
        });
        Ok(Some(RunDetail {
            run: RunListRow {
                run: row_from_dwf(record),
                time_created,
                time_updated,
            },
            state,
        }))
    }
}
