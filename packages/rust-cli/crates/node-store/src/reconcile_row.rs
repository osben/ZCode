//! Fork: the stored row behind the session-list reconcile (`v4/sessionsIndex/reconcile`, Node
//! `reconcileSessions`; specs/fork-rust-agent-parity.md).
//!
//! Node reads `getSession`, which returns soft-deleted rows too: the App's task index learns a
//! delete through `deleted: true` on an existing row, not through a missing one.

use rusqlite::{Connection, OptionalExtension};
use rust_cli_kernel_api::store::StoreError;
use serde_json::{Value, json};

use crate::OrStorage;

/// `{directory, workspaceId, title, titleSource, timeCreated, timeUpdated, timeTitleUpdated,
/// timeDeleted, lastOutcome}` for the session, deleted or not; `None` when no row exists.
pub(crate) fn row(conn: &Connection, session: &str) -> Result<Option<Value>, StoreError> {
    conn.query_row(
        "select directory, workspace_id, title, title_source, time_created, time_updated,
           time_title_updated, time_deleted, last_outcome
         from session where id = ?",
        [session],
        |row| {
            Ok(json!({
                "directory": row.get::<_, String>(0)?,
                "workspaceId": row.get::<_, Option<String>>(1)?.filter(|id| !id.is_empty()),
                "title": row.get::<_, String>(2)?,
                "titleSource": row.get::<_, Option<String>>(3)?,
                "timeCreated": row.get::<_, i64>(4)?,
                "timeUpdated": row.get::<_, i64>(5)?,
                "timeTitleUpdated": row.get::<_, Option<i64>>(6)?,
                "timeDeleted": row.get::<_, Option<i64>>(7)?,
                "lastOutcome": row.get::<_, Option<String>>(8)?,
            }))
        },
    )
    .optional()
    .storage()
}

#[cfg(test)]
#[path = "reconcile_row_tests.rs"]
mod tests;
