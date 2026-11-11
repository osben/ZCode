//! Fork: a session's execution worktree in the Node `session` row (`execution_directory`, `execution_branch`;
//! Node fork migration `9002_fork_session_execution_worktree`, specs/fork-rust-agent-parity.md "Execution
//! worktree").
//!
//! The columns belong to the Node agent's fork migrations: zcode-rs adds no migration. A database Node never
//! migrated has no columns; it then holds no worktree (reads answer `None`) and a write is `Unsupported`, so a
//! worktree session is never run that would resume in the parent workspace.

use rusqlite::{Connection, OptionalExtension};
use rust_cli_kernel_api::env::EnvPath;
use rust_cli_kernel_api::store::{ExecutionWorktree, StoreError};

use crate::OrStorage;

fn has_columns(conn: &Connection) -> Result<bool, StoreError> {
    conn.query_row(
        "select count(*) = 2 from pragma_table_info('session')
         where name in ('execution_directory', 'execution_branch')",
        [],
        |row| row.get(0),
    )
    .storage()
}

/// The stored worktree; `None` for an ordinary session, an unknown one, or a database without the columns.
pub(crate) fn read(
    conn: &Connection,
    session: &str,
) -> Result<Option<ExecutionWorktree>, StoreError> {
    if !has_columns(conn)? {
        return Ok(None);
    }
    let row = conn
        .query_row(
            "select directory, execution_directory, execution_branch from session where id = ?",
            [session],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .storage()?;
    Ok(row.and_then(|(directory, path, branch)| {
        let path = path.filter(|path| !path.is_empty())?;
        Some(ExecutionWorktree {
            directory: EnvPath::new(directory),
            path: EnvPath::new(path),
            branch: branch.filter(|branch| !branch.is_empty()),
        })
    }))
}

/// A cold open runs the session in its stored worktree (Node starts the runtime with `execution_directory`); the
/// row's `directory` stays the parent it is listed under. A worktree that is gone stays the root, as in Node's resume
/// (`execution-worktree-missing-handling.md` section 2): tools then fail on the missing directory instead of reaching
/// the parent checkout, and the listing reports it missing.
pub(crate) async fn run_in_worktree(
    store: &crate::NodeStore,
    session: &rust_cli_kernel_api::ids::SessionId,
    meta: &mut rust_cli_kernel_api::store::SessionMeta,
) -> Result<(), StoreError> {
    let Some(worktree) =
        rust_cli_kernel_api::store::StoreQueries::execution_worktree(store, session).await?
    else {
        return Ok(());
    };
    meta.workspace.root = worktree.path;
    Ok(())
}

/// Node's `coalesce(session.execution_*, excluded.execution_*)`: a stored value is kept, a later write changes
/// nothing.
pub(crate) fn write(
    conn: &Connection,
    session: &str,
    path: &str,
    branch: Option<&str>,
) -> Result<(), StoreError> {
    if !has_columns(conn)? {
        return Err(StoreError::Unsupported {
            what: "execution worktree (the database has no execution columns)".to_owned(),
        });
    }
    let changed = conn
        .execute(
            "update session set
               execution_directory = coalesce(execution_directory, ?2),
               execution_branch = coalesce(execution_branch, ?3)
             where id = ?1",
            rusqlite::params![session, path, branch],
        )
        .storage()?;
    if changed == 0 {
        return Err(StoreError::NotFound {
            session: rust_cli_kernel_api::ids::SessionId::new(session),
        });
    }
    Ok(())
}

/// Test support: what the Node agent leaves for a worktree session, written the Node way. Its fork migration
/// `9002_fork_session_execution_worktree` (the DDL text Node runs) and its activation write, which sets both
/// columns.
#[cfg(feature = "testing")]
pub(crate) fn node_write(
    conn: &Connection,
    session: &str,
    path: &str,
    branch: &str,
) -> Result<(), StoreError> {
    if !has_columns(conn)? {
        conn.execute_batch(
            "alter table session
               add column execution_directory text;

             alter table session
               add column execution_branch text;",
        )
        .storage()?;
    }
    conn.execute(
        "update session set execution_directory = ?2, execution_branch = ?3 where id = ?1",
        rusqlite::params![session, path, branch],
    )
    .storage()?;
    Ok(())
}

#[cfg(test)]
#[path = "fork_execution_worktree_tests.rs"]
mod tests;
