//! Fork: the `dynamic_workflow_run_progress` session entry (specs/fork-rust-workflow-engine.md, 9.34, W7-5e). Node appends
//! each run's progress to the parent session as a `dynamic_workflow_run_progress` session event whose payload is the
//! `DynamicWorkflowRunProgressPayload` (contracts `session.events.ts`). This writes that payload as a `session_entry` row of
//! the same type, so the parent session's rows carry the event Node's sink appends.
use anyhow::Result;
use rusqlite::Connection;
use serde_json::Value;

use crate::repo::entries::{self, Entry};

/// The session event type, Node's `SessionEventType.DynamicWorkflowRunProgress`.
pub const PROGRESS_ENTRY_TYPE: &str = "dynamic_workflow_run_progress";

/// Writes one progress payload for `parent_session_id`. A re-record of the same run and sequence replaces its row.
pub fn record_progress(
    conn: &Connection,
    parent_session_id: &str,
    progress: &Value,
    now: i64,
) -> Result<()> {
    let run_id = progress
        .get("runId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow::anyhow!("a progress payload needs a runId"))?;
    let sequence = progress
        .get("sequence")
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("a progress payload needs a sequence"))?;
    // The id is the run and its journal sequence: a re-record replaces the row, and the row is one event.
    let entry = Entry {
        id: format!("dwf-progress:{run_id}:{sequence}"),
        session_id: parent_session_id.to_owned(),
        kind: PROGRESS_ENTRY_TYPE.to_owned(),
        time_created: now,
        time_updated: now,
        data: progress.clone(),
        // Node's progress does not touch the session's activity time: the parent's order is its own turns.
        touch_session: false,
    };
    entries::save(conn, &entry)
}

#[cfg(test)]
#[path = "session_progress_tests.rs"]
mod tests;
