//! Fork: the session runtime presence protocol on the shared database (specs/fork-rust-agent-parity.md "Session
//! runtime presence on the shared database").
//!
//! Upstream migration `0025_session_permanent_deletion` owns `session_runtime_presence`, `session_purge` and their
//! triggers. node-store only uses them, when a Node build has created them: it never applies 0025 and adds no
//! migration. Every row this process writes is keyed by an owner of Node's format (`<pid>:<uuid>`), one per open.
//! Node's `beginSessionDeletion` refuses a purge while a foreign row with a live pid exists. There is no heartbeat:
//! Node's `kill(pid, 0)` probe deletes the rows of a process that is gone.
//!
//! Lock order: the connection, then [`Held`]. Every function here runs on the store's blocking thread.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, ErrorCode, params};
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::store::{SESSION_DATA_DELETING, StoreError};

use crate::ids::{RandomUuids, UuidSource};

/// The presence rows this process holds: owner id to session id.
pub(crate) type Held = Arc<Mutex<HashMap<String, String>>>;

/// A fresh owner id in Node's format (`${process.pid}:${randomUUID()}`). One per open, so the late release of a
/// closed runtime can never delete the row of a reopen of the same session.
pub(crate) fn owner() -> String {
    format!("{}:{}", std::process::id(), RandomUuids.uuid())
}

/// Whether a Node build created 0025's tables in this database.
fn has_tables(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "select count(*) = 2 from sqlite_master where type = 'table'
           and name in ('session_runtime_presence', 'session_purge')",
        [],
        |row| row.get(0),
    )
}

/// Whether the database has `session_purge` (for the list filters).
pub(crate) fn has_purge_table(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "select exists(select 1 from sqlite_master where type = 'table' and name = 'session_purge')",
        [],
        |row| row.get(0),
    )
}

/// Whether a SQLite error is a 0025 trigger's `raise(abort, 'session-data.deleting')`.
pub(crate) fn is_deleting(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, Some(message))
            if failure.code == ErrorCode::ConstraintViolation && message == SESSION_DATA_DELETING
    )
}

/// Node `registerSessionRuntime`. The insert is the barrier: with a purge row, `session_purge_runtime_guard` aborts
/// it inside the same write lock Node's inspection takes. `false` when the database has no protocol.
pub(crate) fn register(
    conn: &Connection,
    held: &Held,
    session: &str,
    owner: &str,
) -> Result<bool, StoreError> {
    if !has_tables(conn).map_err(crate::storage)? {
        return Ok(false);
    }
    conn.execute(
        "insert or ignore into session_runtime_presence(session_id,owner_id,process_id) values(?,?,?)",
        params![session, owner, std::process::id()],
    )
    .map_err(crate::storage)?;
    held.lock_unpoisoned()
        .insert(owner.to_owned(), session.to_owned());
    Ok(true)
}

fn delete(conn: &Connection, session: &str, owner: &str) -> rusqlite::Result<()> {
    if has_tables(conn)? {
        conn.execute(
            "delete from session_runtime_presence where session_id=? and owner_id=?",
            params![session, owner],
        )?;
    }
    Ok(())
}

/// Node `close()`: deletes every row this process still holds.
pub(crate) fn release_all(conn: &Connection, held: &Held) -> Result<(), StoreError> {
    let rows: Vec<(String, String)> = held.lock_unpoisoned().drain().collect();
    for (owner, session) in rows {
        delete(conn, &session, &owner).map_err(crate::storage)?;
    }
    Ok(())
}

/// Node `assertSessionNotDeleting`: `Deleting` when any of `sessions` has a purge row, in either state.
pub(crate) fn assert_not_deleting(
    conn: &Connection,
    sessions: &[String],
) -> Result<(), StoreError> {
    if !has_purge_table(conn).map_err(crate::storage)? {
        return Ok(());
    }
    let mut statement = conn
        .prepare_cached("select exists(select 1 from session_purge where session_id=?)")
        .map_err(crate::storage)?;
    for session in sessions {
        let purging: bool = statement
            .query_row([session], |row| row.get(0))
            .map_err(crate::storage)?;
        if purging {
            return Err(StoreError::Deleting);
        }
    }
    Ok(())
}

/// The release a [`rust_cli_kernel_api::store::RuntimePresence`] runs when it drops (Node
/// `unregisterSessionRuntime`).
pub(crate) struct Release {
    pub(crate) connection: Arc<Mutex<Option<Connection>>>,
    pub(crate) held: Held,
    pub(crate) session: String,
    pub(crate) owner: String,
}

impl Release {
    /// Deletes the row on a blocking thread (a drop cannot await), inline when no runtime is running.
    pub(crate) fn run(self) {
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => drop(runtime.spawn_blocking(move || self.delete())),
            Err(_) => self.delete(),
        }
    }

    fn delete(&self) {
        let slot = self.connection.lock_unpoisoned();
        // Released at shutdown already (`release_all`): nothing left to delete.
        if self.held.lock_unpoisoned().remove(&self.owner).is_none() {
            return;
        }
        let Some(conn) = slot.as_ref() else {
            return;
        };
        if let Err(error) = delete(conn, &self.session, &self.owner) {
            tracing::warn!(
                event = "session_presence.release_failed",
                session = %self.session,
                error = %error,
                "releasing the session runtime presence failed"
            );
        }
    }
}

#[cfg(test)]
#[path = "presence_tests.rs"]
mod tests;
