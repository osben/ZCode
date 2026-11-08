//! Fork: permanent erase of a session tree (Node `repositories/session-tree.ts`, specs
//! `session-deletion-cascade.md` §4-§5). A plain `delete from session` is not enough:
//! `workflow_run` references sessions with `on delete set null`, `dwf_*` and `input_history`
//! carry session ids without a foreign key, and `parent_id` has none either — the tree is
//! resolved explicitly and the non-cascading rows are deleted first.
//!
//! The fork usage rollup runs inside the same `BEGIN IMMEDIATE` transaction (Node's order:
//! recompute, preserve detached identities, prune), so an erase never loses usage statistics in
//! the database shared with the Node build (`fork_usage_rollup.rs`).

use std::collections::{HashMap, HashSet};

use rusqlite::types::Value as Sql;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use rust_cli_kernel_api::store::{ErasedSessionTree, SessionTreeCounts, StoreError};

use crate::OrStorage;
use crate::fork_usage_rollup::{
    ensure_rollup_schema, preserve_before_session_tree_delete, prune, recompute_in_transaction,
};
use crate::ids::NodeIds;

/// Node `SESSION_TREE_CHILD_TASK_TYPES` (`contracts/src/interfaces/session-store.port.ts`):
/// the task types the tree walk descends into. Forks and interactive sessions share `parent_id`
/// but are never walked into.
pub(crate) const SESSION_TREE_CHILD_TASK_TYPES: [&str; 4] = [
    "selection_side_chat",
    "subagent_child",
    "workflow_child",
    "nested_workflow_child",
];

/// Keeps every statement far below SQLite's bound-variable limit (Node `ID_CHUNK_SIZE`).
const ID_CHUNK_SIZE: usize = 400;

fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

fn text_values(part: &[String]) -> Vec<Sql> {
    part.iter().cloned().map(Sql::Text).collect()
}

/// Node `resolveTreeIds`: roots that exist plus descendants through the child task types
/// (archived included, no workspace filter). Returns first-seen order with the latest task type
/// for each id, like Node's `Map` (`set` on an existing key keeps the original position).
fn resolve_tree_ids(
    conn: &Connection,
    root_ids: &[String],
) -> Result<Vec<(String, String)>, StoreError> {
    let mut seen_roots = HashSet::new();
    let unique_roots: Vec<String> = root_ids
        .iter()
        .filter(|id| seen_roots.insert((*id).clone()))
        .cloned()
        .collect();
    let mut tree: Vec<(String, String)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let type_list = placeholders(SESSION_TREE_CHILD_TASK_TYPES.len());
    for roots in unique_roots.chunks(ID_CHUNK_SIZE) {
        let sql = format!(
            "with recursive tree(id, task_type) as (
           select id, task_type from session where id in ({})
           union
           select s.id, s.task_type from session s join tree t on s.parent_id = t.id
           where s.task_type in ({type_list})
         ) select id, task_type from tree",
            placeholders(roots.len())
        );
        let mut values = text_values(roots);
        values.extend(
            SESSION_TREE_CHILD_TASK_TYPES
                .iter()
                .map(|task_type| Sql::Text((*task_type).to_owned())),
        );
        let rows: Vec<(String, String)> = conn
            .prepare_cached(&sql)
            .storage()?
            .query_map(rusqlite::params_from_iter(values), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .storage()?
            .collect::<rusqlite::Result<_>>()
            .storage()?;
        for (id, task_type) in rows {
            match index.get(&id) {
                Some(&position) => tree[position].1 = task_type,
                None => {
                    index.insert(id.clone(), tree.len());
                    tree.push((id, task_type));
                }
            }
        }
    }
    Ok(tree)
}

/// `workflow_run` / `dwf_run` are owned by later migrations and may be absent from a database
/// another build created; treat a missing table as zero rows / nothing to delete.
fn table_exists(conn: &Connection, table: &str) -> Result<bool, StoreError> {
    conn.query_row(
        "select 1 from sqlite_master where type = 'table' and name = ?",
        rusqlite::params![table],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .storage()
    .map(|found| found.is_some())
}

fn ids_of(tree: &[(String, String)]) -> Vec<String> {
    tree.iter().map(|(id, _)| id.clone()).collect()
}

/// Node `listSessionTreeIds`.
pub(crate) fn list_tree_ids(
    conn: &Connection,
    root_ids: &[String],
) -> Result<Vec<String>, StoreError> {
    Ok(ids_of(&resolve_tree_ids(conn, root_ids)?))
}

/// Node `listSessionTreeIdsWithSurvivingChildren`: tree sessions with a child outside the tree,
/// i.e. a fork whose copied parts still point at their files.
pub(crate) fn list_tree_ids_with_surviving_children(
    conn: &Connection,
    root_ids: &[String],
) -> Result<Vec<String>, StoreError> {
    let ids = ids_of(&resolve_tree_ids(conn, root_ids)?);
    let in_tree: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut retained: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for part in ids.chunks(ID_CHUNK_SIZE) {
        let sql = format!(
            "select id, parent_id from session where parent_id in ({})",
            placeholders(part.len())
        );
        let rows: Vec<(String, String)> = conn
            .prepare_cached(&sql)
            .storage()?
            .query_map(rusqlite::params_from_iter(text_values(part)), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .storage()?
            .collect::<rusqlite::Result<_>>()
            .storage()?;
        for (id, parent) in rows {
            if !in_tree.contains(id.as_str()) && seen.insert(parent.clone()) {
                retained.push(parent);
            }
        }
    }
    Ok(retained)
}

/// Node `countSessionTree`: the tree's session mix plus the workflow runs attached to it.
pub(crate) fn count_tree(
    conn: &Connection,
    root_ids: &[String],
) -> Result<SessionTreeCounts, StoreError> {
    let tree = resolve_tree_ids(conn, root_ids)?;
    let ids = ids_of(&tree);
    let mut side_chats = 0u64;
    let mut subagents = 0u64;
    let mut workflow_sessions = 0u64;
    for (_, task_type) in &tree {
        match task_type.as_str() {
            "selection_side_chat" => side_chats += 1,
            "subagent_child" => subagents += 1,
            "workflow_child" | "nested_workflow_child" => workflow_sessions += 1,
            _ => {}
        }
    }
    let script_runs = count_by_ids(conn, &ids, "workflow_run", "parent_session_id")?;
    let dwf_runs = count_by_ids(conn, &ids, "dwf_run", "parent_session_id")?;
    Ok(SessionTreeCounts {
        total: ids.len() as u64,
        side_chats,
        subagents,
        workflow_sessions,
        workflow_runs: script_runs + dwf_runs,
    })
}

/// Node `countByIds`, summing over id chunks.
fn count_by_ids(
    conn: &Connection,
    ids: &[String],
    table: &str,
    column: &str,
) -> Result<u64, StoreError> {
    if !table_exists(conn, table)? {
        return Ok(0);
    }
    let mut total = 0i64;
    for part in ids.chunks(ID_CHUNK_SIZE) {
        let sql = format!(
            "select count(*) as n from {table} where {column} in ({})",
            placeholders(part.len())
        );
        let n: i64 = conn
            .prepare_cached(&sql)
            .storage()?
            .query_row(rusqlite::params_from_iter(text_values(part)), |row| {
                row.get(0)
            })
            .storage()?;
        total += n;
    }
    Ok(u64::try_from(total).unwrap_or(u64::MAX))
}

/// Node `deleteSessionTree`, plus the workspace of every erased requested root: the protocol
/// layer announces each erased root on the sessions index of the workspace it belonged to (a
/// Rust-only extension; Node's erase has no announcement).
///
/// The tree is resolved inside the write transaction so a concurrent writer cannot add a child
/// between resolution and deletion and leave it orphaned. On any error the transaction rolls
/// back (rusqlite's `Transaction` rolls back on drop), so the rollup and the deletes go together.
pub(crate) fn delete_tree(
    conn: &mut Connection,
    root_ids: &[String],
    ids: &NodeIds,
) -> Result<ErasedSessionTree, StoreError> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .storage()?;
    let tree_ids = ids_of(&resolve_tree_ids(&tx, root_ids)?);
    // Read the requested roots' workspaces before the rows go away.
    let requested: HashSet<&str> = root_ids.iter().map(String::as_str).collect();
    let mut erased_roots: Vec<(String, String)> = Vec::new();
    for part in tree_ids.chunks(ID_CHUNK_SIZE) {
        let sql = format!(
            "select id, directory from session where id in ({})",
            placeholders(part.len())
        );
        let rows: Vec<(String, String)> = tx
            .prepare_cached(&sql)
            .storage()?
            .query_map(rusqlite::params_from_iter(text_values(part)), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .storage()?
            .collect::<rusqlite::Result<_>>()
            .storage()?;
        for (id, directory) in rows {
            if requested.contains(id.as_str()) {
                erased_roots.push((id, directory));
            }
        }
    }
    if !tree_ids.is_empty() {
        // Bring complete raw-backed buckets current, then transfer session identities and freeze
        // aggregate baselines before FK cascades remove their raw usage rows.
        let now = ids.now_ms();
        ensure_rollup_schema(&tx, now)?;
        recompute_in_transaction(&tx, now)?;
        preserve_before_session_tree_delete(&tx, &tree_ids, now, || ids.uuid())?;
        prune(&tx, now)?;
    }
    for part in tree_ids.chunks(ID_CHUNK_SIZE) {
        let list = placeholders(part.len());
        // Order matters: the workflow rows still need the session ids to be matched, and deleting
        // the sessions first would null the references (`on delete set null`) that identify them.
        // Cascades workflow_activity / workflow_event / session_task_link rows of the run.
        if table_exists(&tx, "workflow_run")? {
            tx.prepare_cached(&format!(
                "delete from workflow_run where parent_session_id in ({list})"
            ))
            .storage()?
            .execute(rusqlite::params_from_iter(text_values(part)))
            .storage()?;
        }
        if table_exists(&tx, "dwf_run")? {
            tx.prepare_cached(&format!(
                "delete from dwf_run where parent_session_id in ({list})"
            ))
            .storage()?
            .execute(rusqlite::params_from_iter(text_values(part)))
            .storage()?;
        }
        tx.prepare_cached(&format!(
            "delete from input_history where session_id in ({list})"
        ))
        .storage()?
        .execute(rusqlite::params_from_iter(text_values(part)))
        .storage()?;
        tx.prepare_cached(&format!("delete from session where id in ({list})"))
            .storage()?
            .execute(rusqlite::params_from_iter(text_values(part)))
            .storage()?;
    }
    tx.commit().storage()?;
    Ok(ErasedSessionTree {
        erased_ids: tree_ids,
        erased_roots,
    })
}

/// The four tree operations on the shared database, reached through `Kernel::queries` (Node
/// exposes them on `sessionStore`; the store port keeps them next to the SQL they run). The
/// trait's default bodies answer `Unsupported` so stores without the shared database keep
/// compiling, and the protocol layer maps that to `-32601` like Node's
/// "Session tree operations are not supported".
#[cfg(test)]
#[path = "session_tree_tests.rs"]
mod tests;
