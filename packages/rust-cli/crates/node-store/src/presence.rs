//! Fork: the session runtime presence protocol on the shared database (specs/fork-rust-agent-parity.md "Session
//! runtime presence on the shared database").
//!
//! Upstream migration `0025_session_permanent_deletion` owns `session_runtime_presence`, `session_purge` and their
//! triggers. node-store only uses them, when a Node build has created them: it never applies 0025 and adds no
//! migration. Every row this process writes is keyed by an owner of Node's format (`<pid>:<uuid>`), one per open.
//! Node's `beginSessionDeletion` refuses a purge while a foreign row with a live pid exists. There is no heartbeat:
//! Node's `kill(pid, 0)` probe deletes the rows of a process that is gone.
//!
//! A row stays in [`Held`] until its delete succeeds: a release that fails (the database locked past the busy timeout,
//! which is when Node holds `begin immediate`) is retried by every later release and register, by a backoff timer the
//! store owns while failed releases remain, and by the shutdown sweep, as Node's `close()` deletes every row of its
//! owner whatever an earlier `unregisterSessionRuntime` did.
//!
//! The entry, and the guard that releases it, exist before the insert is queued: an open or a create dropped while
//! its insert waits for the connection leaves no row. The insert runs only while the entry is still unreleased, and
//! the release deletes whatever the insert wrote; the connection orders the two.
//!
//! Lock order: the connection, then [`Held`]. Every function here except [`pending`] and [`Release::run`] runs on the
//! store's blocking thread.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{Connection, ErrorCode, params};
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::store::{SESSION_DATA_DELETING, StoreError};

use crate::ids::NodeIds;

/// Rust's presence insert, shared with the Node test that runs the real `beginSessionDeletion` against it
/// (`apps/zcode-cli/packages/adapters/tests/fork-rust-runtime-presence.test.ts`).
const INSERT: &str = include_str!("fixtures/runtime_presence_insert.sql");

/// One presence row this process wrote.
#[derive(Debug)]
pub(crate) struct Entry {
    pub(crate) session: String,
    /// The runtime let go of it; the row is left because its delete failed.
    pub(crate) released: bool,
}

/// The presence rows this process holds: owner id to entry.
pub(crate) type Held = Arc<Mutex<HashMap<String, Entry>>>;

/// The first wait of the retry timer, doubled after each try that leaves rows, up to [`RETRY_MAX`].
const RETRY_FIRST: Duration = Duration::from_millis(50);
const RETRY_MAX: Duration = Duration::from_secs(2);

/// A fresh owner id in Node's format (`${process.pid}:${randomUUID()}`). One per open, so the late release of a
/// closed runtime can never delete the row of a reopen of the same session.
pub(crate) fn owner(ids: &NodeIds) -> String {
    format!("{}:{}", std::process::id(), ids.uuid())
}

/// Records the entry of a registration about to be queued, before the guard that releases it is built.
pub(crate) fn pending(held: &Held, session: &str, owner: &str) {
    held.lock_unpoisoned().insert(
        owner.to_owned(),
        Entry {
            session: session.to_owned(),
            released: false,
        },
    );
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

/// Node `registerSessionRuntime` for the [`pending`] entry of `owner`. The insert is the barrier: with a purge row,
/// `session_purge_runtime_guard` aborts it inside the same write lock Node's inspection takes. `false`, with the entry
/// forgotten, when the database has no protocol or the guard was already dropped; on an error the entry is forgotten
/// too, as no row was written.
pub(crate) fn register(
    conn: &Connection,
    held: &Held,
    session: &str,
    owner: &str,
) -> Result<bool, StoreError> {
    let wanted = held
        .lock_unpoisoned()
        .get(owner)
        .is_some_and(|entry| !entry.released);
    let inserted = match has_tables(conn) {
        Ok(true) if wanted => {
            retry_released(conn, held);
            conn.execute(INSERT, params![session, owner, std::process::id()])
                .map(|_| true)
        }
        Ok(_) => Ok(false),
        Err(error) => Err(error),
    };
    if !matches!(inserted, Ok(true)) {
        held.lock_unpoisoned().remove(owner);
    }
    inserted.map_err(crate::storage)
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

/// Deletes the rows `select` picks, forgetting each only once its delete succeeded. The first failure is returned
/// after every row was tried.
fn sweep(conn: &Connection, held: &Held, select: fn(&Entry) -> bool) -> rusqlite::Result<()> {
    let rows: Vec<(String, String)> = held
        .lock_unpoisoned()
        .iter()
        .filter(|(_, entry)| select(entry))
        .map(|(owner, entry)| (owner.clone(), entry.session.clone()))
        .collect();
    let mut failed = None;
    for (owner, session) in rows {
        match delete(conn, &session, &owner) {
            Ok(()) => {
                held.lock_unpoisoned().remove(&owner);
            }
            Err(error) => {
                failed.get_or_insert(error);
            }
        }
    }
    failed.map_or(Ok(()), Err)
}

/// Retries the releases that failed earlier. Best effort: a row that still cannot be deleted waits for the next try.
fn retry_released(conn: &Connection, held: &Held) {
    if let Err(error) = sweep(conn, held, |entry| entry.released) {
        tracing::warn!(
            event = "session_presence.release_retry_failed",
            error = %error,
            "retrying a failed session runtime presence release failed"
        );
    }
}

fn any_released(held: &Held) -> bool {
    held.lock_unpoisoned().values().any(|entry| entry.released)
}

/// Starts the store's retry timer unless it runs: while failed releases remain it retries them on a bounded backoff,
/// and it stops once none is left. It is a runtime task, so it never keeps the process alive; what it has not deleted
/// by the runtime shutdown goes to the exit sweep.
fn schedule_retry(
    runtime: &tokio::runtime::Handle,
    connection: Arc<Mutex<Option<Connection>>>,
    held: Held,
    retrying: Arc<AtomicBool>,
) {
    if retrying.swap(true, Ordering::AcqRel) {
        return;
    }
    let blocking = runtime.clone();
    drop(runtime.spawn(async move {
        let mut wait = RETRY_FIRST;
        loop {
            tokio::time::sleep(wait).await;
            let (slot, rows) = (connection.clone(), held.clone());
            let swept = blocking
                .spawn_blocking(move || {
                    if let Some(conn) = slot.lock_unpoisoned().as_ref() {
                        retry_released(conn, &rows);
                    }
                })
                .await;
            if swept.is_err() || !any_released(&held) {
                retrying.store(false, Ordering::Release);
                // A release that failed after the check found the timer still running: take it over.
                if !any_released(&held) || retrying.swap(true, Ordering::AcqRel) {
                    return;
                }
                wait = RETRY_FIRST;
            } else {
                wait = (wait * 2).min(RETRY_MAX);
            }
        }
    }));
}

/// Node `close()`: deletes every row this process still holds. A row whose delete fails stays held.
pub(crate) fn release_all(conn: &Connection, held: &Held) -> Result<(), StoreError> {
    sweep(conn, held, |_| true).map_err(crate::storage)
}

/// Whether `session` has a purge row, in either state (`false` without 0025).
pub(crate) fn is_purging(conn: &Connection, session: &str) -> Result<bool, StoreError> {
    if !has_purge_table(conn).map_err(crate::storage)? {
        return Ok(false);
    }
    conn.prepare_cached("select exists(select 1 from session_purge where session_id=?)")
        .and_then(|mut statement| statement.query_row([session], |row| row.get(0)))
        .map_err(crate::storage)
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
    /// Whether the store's retry timer runs ([`schedule_retry`]).
    pub(crate) retrying: Arc<AtomicBool>,
    pub(crate) session: String,
    pub(crate) owner: String,
}

impl Release {
    /// Deletes the row on a blocking thread (a drop cannot await), inline when no runtime is running. Nothing to do
    /// once the entry is gone: an owner is never held again after it is forgotten.
    pub(crate) fn run(self) {
        if !self.held.lock_unpoisoned().contains_key(&self.owner) {
            return;
        }
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                let timer = runtime.clone();
                let task = runtime.spawn_blocking(move || self.delete(Some(&timer)));
                // A panicked delete is reported; one the runtime shutdown skipped leaves its entry held for the exit
                // sweep.
                drop(runtime.spawn(async move {
                    if let Err(error) = task.await {
                        tracing::warn!(
                            event = "session_presence.release_task_failed",
                            error = %error,
                            "the session runtime presence release task did not finish"
                        );
                    }
                }));
            }
            Err(_) => self.delete(None),
        }
    }

    /// `runtime` runs the retry timer when rows are left held; inline (no runtime) they wait for the exit sweep.
    fn delete(&self, runtime: Option<&tokio::runtime::Handle>) {
        let slot = self.connection.lock_unpoisoned();
        match self.held.lock_unpoisoned().get_mut(&self.owner) {
            // Released at shutdown already (`release_all`): nothing left to delete.
            None => return,
            Some(entry) => entry.released = true,
        }
        let Some(conn) = slot.as_ref() else {
            return;
        };
        match delete(conn, &self.session, &self.owner) {
            Ok(()) => {
                self.held.lock_unpoisoned().remove(&self.owner);
                retry_released(conn, &self.held);
            }
            // The row stays held: a later release or register, the retry timer or the shutdown sweep deletes it.
            Err(error) => tracing::warn!(
                event = "session_presence.release_failed",
                session = %self.session,
                error = %error,
                "releasing the session runtime presence failed; it is retried"
            ),
        }
        drop(slot);
        if let Some(runtime) = runtime
            && any_released(&self.held)
        {
            schedule_retry(
                runtime,
                self.connection.clone(),
                self.held.clone(),
                self.retrying.clone(),
            );
        }
    }
}

#[cfg(test)]
#[path = "presence_tests.rs"]
mod tests;
