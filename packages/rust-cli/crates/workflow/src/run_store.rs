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

use crate::import_build::{
    BuildOptions, BuildOutcome, ImportRefusal, build_imported_cache, preflight_amend_import,
};
use crate::journal_dwf::{DwfJournal, row_from_dwf, status_to_dwf};
use crate::model::{RunRow, RunStatus};
use crate::run_roster::{RosterFacts, build_roster};
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
    /// Node `preflightAmendImport` over this store's journal (9.43): the predecessor exists and its completed asks
    /// have boundaries. Read-only. Required, not defaulted: a wrapper that forgot to forward it would fail every amend.
    fn amend_preflight(&self, predecessor_run_id: &str) -> Result<Result<RunRow, ImportRefusal>>;
    /// Node `buildImportedCache` over this store's journal (9.43), without a transcript count: completed asks import,
    /// and an in-flight continuation is not built (the transcript surface is not composed yet).
    fn amend_import(&self, predecessor_run_id: &str) -> Result<BuildOutcome>;
    /// Whether the run's launch recorded script-named model bindings (9.50, the settings route). The settings route refuses
    /// such a run, since it does not rebind them yet. Required in spirit: the default answers `true` (refuse), so a store that
    /// does not read the launch cannot amend a settings change by accident.
    fn launch_binds_models(&self, run_id: &str) -> Result<bool> {
        let _ = run_id;
        Ok(true)
    }
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
    /// The situation snapshot (9.46): the phases, subagents, health, log tail, actors and the launch's script path and model
    /// bindings, built by `run_roster::build_roster` from the same snapshot's events, node and actor rows and `state`.
    pub roster: serde_json::Map<String, serde_json::Value>,
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

    fn amend_preflight(&self, predecessor_run_id: &str) -> Result<Result<RunRow, ImportRefusal>> {
        let conn = self.conn.lock_unpoisoned();
        let journal = DwfJournal::new(&*conn, self.clock);
        preflight_amend_import(&journal, predecessor_run_id)
    }

    fn amend_import(&self, predecessor_run_id: &str) -> Result<BuildOutcome> {
        let conn = self.conn.lock_unpoisoned();
        let journal = DwfJournal::new(&*conn, self.clock);
        build_imported_cache(&journal, predecessor_run_id, BuildOptions::default())
    }

    fn launch_binds_models(&self, run_id: &str) -> Result<bool> {
        let conn = self.conn.lock_unpoisoned();
        Ok(dwf::run_launched_payload(&conn, run_id)?
            .is_some_and(|launch| launch.get("modelBindings").is_some()))
    }

    fn run_detail(
        &self,
        run_id: &str,
        default_concurrency: Option<f64>,
    ) -> Result<Option<RunDetail>> {
        // The row, its timestamps, its events, its node rows and its actor rows are read in one read transaction, so they share
        // one WAL snapshot: the engine writes the journal through its own connection, and an autocommit read per query could
        // see a settlement land between two of them. The replay and the roster fold them after the lock is released. The
        // roster takes the non-report node rows (Node `NON_REPORT_NODE_KINDS`).
        let (record, time_created, time_updated, events, nodes, actors) = {
            let conn = self.conn.lock_unpoisoned();
            let tx = conn.unchecked_transaction()?;
            let Some(record) = dwf::get_run(&tx, run_id)? else {
                return Ok(None);
            };
            let Some((created, updated)) = dwf::run_times(&tx, run_id)? else {
                anyhow::bail!("the run {run_id} has a row without timestamps");
            };
            // Divergence 564 (9.50): the events are read in every case, bounded like Node's cold read (report items past the
            // projection's cap are removed). Only the replay of state needs the configured default (below). The roster's node
            // and actor reads leave out the result and persona columns, as Node's do.
            let events = dwf::list_events_with_report_cap(
                &tx,
                run_id,
                rust_cli_node_store::WORKFLOW_RUN_LIMITS.max_reports,
            )?;
            let nodes = dwf::list_roster_nodes(&tx, run_id)?;
            let actors = dwf::list_actors_without_persona(&tx, run_id)?;
            (record, created, updated, events, nodes, actors)
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
        let terminal = matches!(
            record.status,
            dwf::RunStatus::Completed | dwf::RunStatus::Errored | dwf::RunStatus::Stopped
        );
        let roster = build_roster(&RosterFacts {
            state: state.as_ref(),
            events: &events,
            nodes: &nodes,
            actors: &actors,
            terminal,
        });
        Ok(Some(RunDetail {
            run: RunListRow {
                run: row_from_dwf(record),
                time_created,
                time_updated,
            },
            state,
            roster,
        }))
    }
}
