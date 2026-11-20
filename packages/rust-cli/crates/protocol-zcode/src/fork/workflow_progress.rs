//! Fork: the production run progress port (specs/fork-rust-workflow-engine.md, 9.34, W7-5e). Node's sink appends each run's
//! progress to the parent session and the Host hears it; this port does both: the payload becomes the parent's
//! `dynamic_workflow_run_progress` entry (node-store `record_progress_entry`), and the projection's deltas go to the
//! parent's open stream, if one is open (the live half of the `workflowRuns` read).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use serde_json::Value;

/// Where a run's live deltas go: the parent session's open stream.
pub trait ProgressDelivery: Send + Sync {
    fn deliver(&self, parent_session_id: &str, deltas: Vec<Value>);
}

/// The run progress port over the session database. The connection opens on the first record (the run's owner thread
/// is blocking), and then stays open for the process.
pub struct WorkflowProgressHost {
    database: PathBuf,
    delivery: Arc<dyn ProgressDelivery>,
    conn: Mutex<Option<rusqlite::Connection>>,
}

impl WorkflowProgressHost {
    pub fn new(database: PathBuf, delivery: Arc<dyn ProgressDelivery>) -> Self {
        Self {
            database,
            delivery,
            conn: Mutex::new(None),
        }
    }
}

impl WorkflowRunProgressPort for WorkflowProgressHost {
    fn record(
        &self,
        parent_session_id: &str,
        progress: &Value,
        deltas: &[Value],
    ) -> Result<(), String> {
        // The append comes first: a refused append tells the Host nothing (Node's sink notifies after its append).
        {
            let mut slot = self.conn.lock_unpoisoned();
            if slot.is_none() {
                let (conn, _) = rust_cli_node_store::open_session_database(
                    &self.database,
                    rust_cli_node_store::MIGRATION_LOCK_WAIT,
                    now_ms_u64(),
                )
                .map_err(|error| format!("the session database did not open: {error}"))?;
                *slot = Some(conn);
            }
            let conn = slot.as_ref().ok_or("the session database is not open")?;
            rust_cli_node_store::record_progress_entry(
                conn,
                parent_session_id,
                progress,
                i64::try_from(now_ms_u64()).unwrap_or(i64::MAX),
            )
            .map_err(|error| error.to_string())?;
        }
        if !deltas.is_empty() {
            self.delivery.deliver(parent_session_id, deltas.to_vec());
        }
        Ok(())
    }
}

/// The business clock's milliseconds, as the rows stamp them.
fn now_ms_u64() -> u64 {
    rust_cli_base::clock::SystemClock::utc().now_ms()
}

/// The production delivery: the parent session's open stream gets the deltas in its pump, as the helper's plugin UI
/// deltas do. A session with no open stream has nobody to show them to, so they are dropped.
pub struct BridgeDelivery {
    context: Arc<crate::context::Context>,
}

impl BridgeDelivery {
    pub fn new(context: Arc<crate::context::Context>) -> Self {
        Self { context }
    }
}

impl ProgressDelivery for BridgeDelivery {
    fn deliver(&self, parent_session_id: &str, deltas: Vec<Value>) {
        let Some(bridge) = self.context.live_bridge() else {
            return;
        };
        let Some(live) = bridge.get(&rust_cli_kernel_api::ids::SessionId::new(parent_session_id))
        else {
            return;
        };
        let sink = live.sink.clone();
        live.run(Box::pin(async move {
            sink.workflow_runs_changed(deltas).await;
        }));
    }
}

#[cfg(test)]
#[path = "workflow_progress_tests.rs"]
mod tests;
