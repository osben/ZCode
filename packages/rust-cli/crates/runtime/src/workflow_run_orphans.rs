//! Fork: orphan reconciliation of one session (specs/fork-rust-workflow-engine.md, 3.6 and 9.29, W7-5a-4; Node
//! `dynamic-workflow-run-reconcile.ts`, `reconcileOrphanRuns`).
//!
//! A run left `running` or `pending` by a process that is gone is settled as `stopped(interrupted)` with the
//! `Interrupted` failure, so it reads as resumable. The sweep is per session, runs when the composition opens the
//! session, and never writes an event (the event log records what the engine emitted; the row is the state).
//! Node runs it in the service constructor: the Rust service holds runs of many sessions, so the open is the
//! equivalent moment, and the guard below keeps the sweep off any run this process holds.

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_workflow::model::RunStatus;

use super::WorkflowRunService;
use super::list::is_terminal;

/// What a sweep did. A sweep that did not run says why; a failed query or write is reported and does not stop the
/// others (Node logs and continues, and never fails the open).
#[derive(Debug, Default, PartialEq)]
pub struct ReconcileReport {
    /// Why the sweep did not run, when it did not (Node's reason strings).
    pub skipped: Option<&'static str>,
    /// The query error, when the query failed.
    pub query_error: Option<String>,
    /// The runs settled as interrupted, with the status each had before.
    pub reconciled: Vec<(String, RunStatus)>,
    /// Per-run write failures, by run id.
    pub failures: Vec<(String, String)>,
}

impl WorkflowRunService {
    /// Settles the session's orphaned runs. Holds the run map's lock for the sweep, so a launch of the same id
    /// cannot start between the check and the write.
    pub fn reconcile_session(&self, parent_session_id: &str) -> ReconcileReport {
        let mut report = ReconcileReport::default();
        let Some(store) = self.inner.store.get() else {
            report.skipped = Some("journal_missing_list_non_terminal_runs");
            return report;
        };
        let state = self.inner.state.lock_unpoisoned();
        if state.closed {
            report.skipped = Some("closed");
            return report;
        }
        let rows = match store.non_terminal_runs(parent_session_id) {
            Ok(rows) => rows,
            Err(error) => {
                let text = format!("{error:#}");
                tracing::warn!(
                    event = "workflow.run.reconcile_query_failed",
                    session = %parent_session_id,
                    error = %text,
                    "the orphan query failed; the session's runs are left as they are"
                );
                report.query_error = Some(text);
                return report;
            }
        };
        for row in rows {
            let previous = row.status;
            if is_terminal(previous) {
                continue;
            }
            // A run this process holds is live, and its row is the engine's own write.
            if state.runs.contains_key(&row.run_id) || state.starting.contains(&row.run_id) {
                continue;
            }
            match store.interrupt_run(&row.run_id) {
                Ok(()) => {
                    tracing::warn!(
                        event = "workflow.run.reconciled_interrupted",
                        run = %row.run_id,
                        previous_status = ?previous,
                        "a run left unsettled by a previous process was settled as interrupted"
                    );
                    report.reconciled.push((row.run_id, previous));
                }
                Err(error) => {
                    let text = format!("{error:#}");
                    tracing::warn!(
                        event = "workflow.run.reconcile_failed",
                        run = %row.run_id,
                        error = %text,
                        "an orphaned run could not be settled"
                    );
                    report.failures.push((row.run_id, text));
                }
            }
        }
        report
    }
}
