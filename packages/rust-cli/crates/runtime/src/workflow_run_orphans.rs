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

use super::list::is_terminal;
use super::{Reservation, WorkflowRunService};

/// Why a sweep did not run. The codes are Node's reason strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The session store has no dwf journal, so there is nothing to sweep (Node's `journal_missing_list_non_terminal_runs`).
    JournalMissing,
    /// The service is closed: a closed service does not write.
    Closed,
}

impl SkipReason {
    /// Node's wire literal.
    pub fn code(self) -> &'static str {
        match self {
            Self::JournalMissing => "journal_missing_list_non_terminal_runs",
            Self::Closed => "closed",
        }
    }
}

/// What a sweep did. A sweep that did not run says why; a failed query or write is reported and does not stop the
/// others (Node logs and continues, and never fails the open).
#[derive(Debug, Default, PartialEq)]
pub struct ReconcileReport {
    /// Why the sweep did not run, when it did not.
    pub skipped: Option<SkipReason>,
    /// The query error, when the query failed.
    pub query_error: Option<String>,
    /// The runs settled as interrupted, with the status each had before.
    pub reconciled: Vec<(String, RunStatus)>,
    /// Runs that settled after they were enumerated (their row is kept, divergence 250).
    pub raced: Vec<String>,
    /// Per-run write failures, by run id.
    pub failures: Vec<(String, String)>,
}

impl WorkflowRunService {
    /// Settles the session's orphaned runs. This is synchronous SQLite work on the caller's thread: a caller on an
    /// async runtime uses [`WorkflowRunService::reconcile_session_off_thread`]. The journal query and each write run
    /// without the run map's lock: the lock is taken only for an orphan's liveness check, and the orphan's id is
    /// reserved in `starting` across its write, so a launch of that id is refused as a duplicate while it settles.
    pub fn reconcile_session(&self, parent_session_id: &str) -> ReconcileReport {
        let mut report = ReconcileReport::default();
        let Some(store) = self.inner.store.get() else {
            report.skipped = Some(SkipReason::JournalMissing);
            return report;
        };
        if self.inner.state.lock_unpoisoned().closed {
            report.skipped = Some(SkipReason::Closed);
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
            // A run this process holds is live, and its row is the engine's own write. Otherwise the id is reserved
            // for the write (the reservation frees it on drop, however the write ends).
            let reservation = {
                let mut state = self.inner.state.lock_unpoisoned();
                if state.closed {
                    report.skipped = Some(SkipReason::Closed);
                    break;
                }
                if state.runs.contains_key(&row.run_id)
                    || !state.starting.insert(row.run_id.clone())
                {
                    continue;
                }
                Reservation {
                    inner: self.inner.clone(),
                    run_id: row.run_id.clone(),
                }
            };
            // The write is guarded on the row still being unsettled, so a run that settled since the enumeration
            // keeps its settlement (`Ok(false)`).
            let written = store.interrupt_run(&row.run_id);
            drop(reservation);
            match written {
                Ok(true) => {
                    tracing::warn!(
                        event = "workflow.run.reconciled_interrupted",
                        run = %row.run_id,
                        previous_status = ?previous,
                        "a run left unsettled by a previous process was settled as interrupted"
                    );
                    report.reconciled.push((row.run_id, previous));
                }
                Ok(false) => {
                    tracing::info!(
                        event = "workflow.run.reconcile_raced",
                        run = %row.run_id,
                        "a run settled after it was listed; its settlement is kept"
                    );
                    report.raced.push(row.run_id);
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

    /// [`WorkflowRunService::reconcile_session`] on the blocking pool, for a caller on an async runtime (the
    /// composition's session open).
    pub async fn reconcile_session_off_thread(&self, parent_session_id: &str) -> ReconcileReport {
        let service = self.clone();
        let parent = parent_session_id.to_owned();
        match tokio::task::spawn_blocking(move || service.reconcile_session(&parent)).await {
            Ok(report) => report,
            Err(error) => ReconcileReport {
                query_error: Some(format!("the orphan sweep did not finish: {error}")),
                ..ReconcileReport::default()
            },
        }
    }
}
