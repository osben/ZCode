//! Fork: the permanent-deletion store on the shared database (Node `repositories/sessions.ts`
//! `inspectSessionDeletion`, `beginSessionDeletion`, `completeSessionDeletion`). The barrier rows are upstream
//! `session_purge` rows (migration 0025); node-store adds no migration and no table.
//!
//! The SQL and the revision are Node's, byte for byte where they reach the database or the hash: a preview made by
//! one build must match the execute of the other (`revision`). Node sorts with `localeCompare`; [`collate`] pins the
//! ICU root order for the identifier charset that session ids, artifact ids and file paths use.
use std::collections::{HashMap, HashSet, VecDeque};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params_from_iter};
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::session_deletion::{
    DeletionBegin, DeletionFork, DeletionReference, DeletionReferrer, SessionDeletionSnapshot,
    locale_compare as collate,
};
use rust_cli_kernel_api::store::StoreError;
use sha2::{Digest, Sha256};

use crate::OrStorage;
use crate::presence::Held;

/// Node `OWNED_CHILD_TASK_TYPES`: the task types an owned tree walks into. Forks are never owned children.
const OWNED_CHILD_TASK_TYPES: [&str; 4] = [
    "selection_side_chat",
    "workflow_child",
    "subagent_child",
    "nested_workflow_child",
];
/// Node `SQL_ID_CHUNK`: ids per `in (...)` list.
const SQL_ID_CHUNK: usize = 400;
const ARTIFACT_SCHEME: &str = "zcode-artifact://";

/// Node `listOwnedSessionTrees` for one root: the root and its owned descendants in breadth-first order; empty when the
/// root row does not exist.
pub(crate) fn owned_tree(conn: &Connection, root: &str) -> Result<Vec<String>, StoreError> {
    let exists: bool = conn
        .prepare_cached("select exists(select 1 from session where id = ?1)")
        .storage()?
        .query_row([root], |row| row.get(0))
        .storage()?;
    if !exists {
        return Ok(Vec::new());
    }
    let types = vec!["?"; OWNED_CHILD_TASK_TYPES.len()].join(",");
    let sql = format!(
        "select id from session where parent_id = ? and task_type in ({types})
         union select child_session_id as id from session_task_link where parent_session_id = ?"
    );
    let mut statement = conn.prepare(&sql).storage()?;
    let mut seen: HashSet<String> = HashSet::from([root.to_owned()]);
    let mut order = vec![root.to_owned()];
    let mut queue = VecDeque::from([root.to_owned()]);
    while let Some(current) = queue.pop_front() {
        let mut values = vec![current.clone()];
        values.extend(
            OWNED_CHILD_TASK_TYPES
                .iter()
                .map(|value| (*value).to_owned()),
        );
        values.push(current);
        let children: Vec<String> = statement
            .query_map(params_from_iter(values), |row| row.get(0))
            .storage()?
            .collect::<rusqlite::Result<_>>()
            .storage()?;
        for child in children {
            if seen.insert(child.clone()) {
                order.push(child.clone());
                queue.push_back(child);
            }
        }
    }
    Ok(order)
}

/// Node `inspectSessionDeletion`: the owned tree of `root`, its forks and retained artifacts, the runtimes holding the
/// tree, and the revision. Reads the barrier rows first: once a purge has started, its receipt is the tree.
pub(crate) fn inspect(
    conn: &Connection,
    root: &str,
    held: &Held,
) -> Result<SessionDeletionSnapshot, StoreError> {
    let receipt: Vec<(String, String, String)> = conn
        .prepare("select session_id,retained_artifacts,state from session_purge where root_id=?1 order by session_id")
        .storage()?
        .query_map([root], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .storage()?
        .collect::<rusqlite::Result<_>>()
        .storage()?;
    let ids: Vec<String> = if receipt.is_empty() {
        owned_tree(conn, root)?
    } else {
        receipt.iter().map(|row| row.0.clone()).collect()
    };
    let inside: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let forks = forks_of(conn, &ids, &inside)?;
    let references = references_of(conn, &inside, &receipt)?;
    let (foreign_runtime, local_runtime_ids) = runtimes_of(conn, &inside, held)?;
    let pending_work = receipt.is_empty() && pending_work_of(conn, &ids)?;

    let mut facts = Vec::with_capacity(ids.len());
    for id in &ids {
        let row: Option<(i64, Option<i64>)> = conn
            .prepare_cached("select time_updated,time_deleted from session where id=?1")
            .storage()?
            .query_row([id], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .storage()?;
        facts.push(match row {
            Some((updated, deleted)) => format!(
                "{{\"id\":{},\"time_updated\":{updated},\"time_deleted\":{}}}",
                json_string(id),
                deleted.map_or("null".to_owned(), |value| value.to_string())
            ),
            None => "null".to_owned(),
        });
    }
    let fork_json: Vec<String> = forks.iter().map(fork_json).collect();
    let reference_json: Vec<String> = references.iter().map(reference_json).collect();
    let revision_source = format!(
        "{{\"ids\":{},\"facts\":[{}],\"forks\":[{}],\"references\":[{}],\"pendingWork\":{pending_work}}}",
        json_array(&ids),
        facts.join(","),
        fork_json.join(","),
        reference_json.join(",")
    );
    let revision = format!("{:x}", Sha256::digest(revision_source.as_bytes()));

    let workspace: Option<(String, Option<String>)> = conn
        .prepare_cached(
            "select directory as path,workspace_id as identity from session where id=?1",
        )
        .storage()?
        .query_row([root], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
        .storage()?;
    let workspace = match workspace {
        Some(workspace) => Some(workspace),
        None => conn
            .prepare_cached(
                "select workspace_path as path,workspace_identity as identity from session_purge where session_id=?1",
            )
            .storage()?
            .query_row([root], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .storage()?,
    };
    let (workspace_path, workspace_identity) = match workspace {
        Some((path, identity)) => (Some(path), identity),
        None => (None, None),
    };
    Ok(SessionDeletionSnapshot {
        workspace_path,
        workspace_identity,
        revision,
        session_ids: ids,
        forks,
        references,
        foreign_runtime,
        local_runtime_ids,
        pending_work,
        deleting: receipt.iter().any(|row| row.2 == "deleting"),
        completed: !receipt.is_empty() && receipt.iter().all(|row| row.2 == "deleted"),
    })
}

/// Node `forks` of the snapshot: independent sessions whose parent is in the tree and which are not in it.
fn forks_of(
    conn: &Connection,
    ids: &[String],
    inside: &HashSet<&str>,
) -> Result<Vec<DeletionFork>, StoreError> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String, Option<String>)> = conn
        .prepare("select id as sessionId,title,parent_id from session where time_deleted is null order by id")
        .storage()?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .storage()?
        .collect::<rusqlite::Result<_>>()
        .storage()?;
    Ok(rows
        .into_iter()
        .filter(|(id, _, parent)| {
            parent
                .as_deref()
                .is_some_and(|parent| inside.contains(parent))
                && !inside.contains(id.as_str())
        })
        .map(|(session_id, title, _)| DeletionFork { session_id, title })
        .collect())
}

/// The source queries of Node's reference scan: rows of the session tables and of the workflow journals whose text
/// carries an artifact URI, with the session that owns each row and its title.
fn reference_sources() -> Vec<String> {
    let mut queries: Vec<String> = [
        ("part", "session_id", "data"),
        ("message", "session_id", "data"),
        ("session_input", "session_id", "payload"),
        ("session_entry", "session_id", "data"),
        ("session", "id", "revert"),
        ("input_history", "session_id", "attachments"),
    ]
    .into_iter()
    .map(|(table, id, data)| {
        format!(
            "select t.{id} as session_id,t.{data} as body,s.title from {table} t join session s on s.id=t.{id} where s.time_deleted is null and instr(t.{data}, '{ARTIFACT_SCHEME}')>0"
        )
    })
    .collect();
    let journals: [(&str, Option<&str>, &[&str]); 7] = [
        (
            "dwf_run",
            None,
            &["args_json", "result_json", "failure_json"],
        ),
        (
            "workflow_run",
            None,
            &["args_json", "stats_json", "failure_json"],
        ),
        (
            "dwf_node",
            Some("dwf_run"),
            &["input_json", "result_json", "error_json"],
        ),
        ("dwf_event", Some("dwf_run"), &["payload_json"]),
        ("dwf_actor", Some("dwf_run"), &["persona_json"]),
        (
            "workflow_activity",
            Some("workflow_run"),
            &["prompt", "opts_json", "result_json", "error_json"],
        ),
        ("workflow_event", Some("workflow_run"), &["payload_json"]),
    ];
    for (table, owner, columns) in journals {
        let body = columns
            .iter()
            .map(|column| format!("coalesce(t.{column},'')"))
            .collect::<Vec<_>>()
            .join(" || ' ' || ");
        let join = owner.map_or(String::new(), |owner| {
            format!("join {owner} r on r.id=t.run_id ")
        });
        let parent = if owner.is_some() { "r" } else { "t" };
        queries.push(format!(
            "select s.id as session_id,{body} as body,s.title from {table} t {join}join session s on s.id={parent}.parent_session_id where s.time_deleted is null and instr({body},'{ARTIFACT_SCHEME}')>0"
        ));
    }
    queries
}

/// Node `references` of the snapshot: `(session, artifact)` pairs of the tree that another live session still names,
/// plus the retained artifacts a receipt kept. Ordered by `session/artifact` (ICU), referrers by session (ICU).
fn references_of(
    conn: &Connection,
    inside: &HashSet<&str>,
    receipt: &[(String, String, String)],
) -> Result<Vec<DeletionReference>, StoreError> {
    let mut references: HashMap<String, DeletionReference> = HashMap::new();
    for sql in reference_sources() {
        let rows: Vec<(String, String, String)> = conn
            .prepare(&sql)
            .storage()?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .storage()?
            .collect::<rusqlite::Result<_>>()
            .storage()?;
        for (referrer, body, title) in rows {
            if inside.contains(referrer.as_str()) {
                continue;
            }
            for (session_id, artifact_id) in artifact_references(&body)? {
                if !inside.contains(session_id.as_str()) {
                    continue;
                }
                let key = format!("{session_id}/{artifact_id}");
                let entry = references.entry(key).or_insert_with(|| DeletionReference {
                    session_id: session_id.clone(),
                    artifact_id: artifact_id.clone(),
                    referrers: Vec::new(),
                });
                if !entry
                    .referrers
                    .iter()
                    .any(|known| known.session_id == referrer)
                {
                    entry.referrers.push(DeletionReferrer {
                        session_id: referrer.clone(),
                        title: title.clone(),
                    });
                }
            }
        }
    }
    for (session_id, retained, _) in receipt {
        let artifacts: Vec<String> = serde_json::from_str(retained).map_err(crate::storage)?;
        for artifact_id in artifacts {
            references
                .entry(format!("{session_id}/{artifact_id}"))
                .or_insert_with(|| DeletionReference {
                    session_id: session_id.clone(),
                    artifact_id,
                    referrers: Vec::new(),
                });
        }
    }
    let mut ordered: Vec<(String, DeletionReference)> = references.into_iter().collect();
    ordered.sort_by(|a, b| collate(&a.0, &b.0));
    Ok(ordered
        .into_iter()
        .map(|(_, mut reference)| {
            reference
                .referrers
                .sort_by(|a, b| collate(&a.session_id, &b.session_id));
            reference
        })
        .collect())
}

/// Node's `zcode-artifact://(<session>)/(<artifact>)` matches in a body, in order. Session and artifact are
/// percent-decoded (Node's `decodeURIComponent` throws on a bad escape, which fails the whole inspection).
fn artifact_references(body: &str) -> Result<Vec<(String, String)>, StoreError> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(offset) = body[from..].find(ARTIFACT_SCHEME) {
        let start = from + offset + ARTIFACT_SCHEME.len();
        let rest = &body[start..];
        let session_end = rest.find(|c: char| matches!(c, '/' | '"' | '\\') || c.is_whitespace());
        let parsed = session_end.and_then(|end| {
            if end == 0 || !rest[end..].starts_with('/') {
                return None;
            }
            let after = &rest[end + 1..];
            let artifact_end = after
                .find(|c: char| matches!(c, '"' | '\\' | '/' | '?' | '#') || c.is_whitespace())
                .unwrap_or(after.len());
            (artifact_end > 0)
                .then(|| (&rest[..end], &after[..artifact_end], end + 1 + artifact_end))
        });
        match parsed {
            Some((session, artifact, consumed)) => {
                found.push((decode_component(session)?, decode_component(artifact)?));
                from = start + consumed;
            }
            None => from = start,
        }
    }
    Ok(found)
}

/// JS `decodeURIComponent` for the characters an artifact URI can carry.
fn decode_component(value: &str) -> Result<String, StoreError> {
    let bad = || StoreError::Storage {
        message: "URI malformed".to_owned(),
    };
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3).ok_or_else(bad)?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| bad())?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| bad())
}

/// Node's presence scan: `(foreign_runtime, local_runtime_ids)` over the rows of the tree. A row whose owner this process
/// holds is local; another row whose pid is dead is removed (Node `kill(pid, 0)` with ESRCH).
fn runtimes_of(
    conn: &Connection,
    inside: &HashSet<&str>,
    held: &Held,
) -> Result<(bool, Vec<String>), StoreError> {
    let rows: Vec<(String, String, i64)> = conn
        .prepare("select session_id,owner_id,process_id from session_runtime_presence")
        .storage()?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .storage()?
        .collect::<rusqlite::Result<_>>()
        .storage()?;
    let mut foreign = false;
    let mut local = Vec::new();
    for (session_id, owner_id, pid) in rows {
        if !inside.contains(session_id.as_str()) {
            continue;
        }
        if held.lock_unpoisoned().contains_key(&owner_id) {
            local.push(session_id);
            continue;
        }
        if process_alive(pid) {
            foreign = true;
        } else {
            conn.prepare_cached(
                "delete from session_runtime_presence where session_id=?1 and owner_id=?2",
            )
            .storage()?
            .execute([&session_id, &owner_id])
            .storage()?;
        }
    }
    Ok((foreign, local))
}

/// Node `process.kill(pid, 0)`: alive unless the probe reports ESRCH (`rust_cli_fs::process_alive`).
fn process_alive(pid: i64) -> bool {
    u32::try_from(pid).is_ok_and(rust_cli_fs::process_alive)
}

/// Node `pendingWork`: an admitted input or an active target in the tree.
fn pending_work_of(conn: &Connection, ids: &[String]) -> Result<bool, StoreError> {
    for id in ids {
        let busy: bool = conn
            .prepare_cached(
                "select exists(select 1 from session_input where session_id=?1 and status='admitted') or exists(select 1 from session_target where session_id=?1 and status='active')",
            )
            .storage()?
            .query_row([id], |row| row.get(0))
            .storage()?;
        if busy {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Node `beginSessionDeletion`: inspect and write the `deleting` barrier rows in one `BEGIN IMMEDIATE` transaction.
/// A foreign runtime or pending work refuses with `Running`; a moved tree refuses with `Changed`.
pub(crate) fn begin(
    conn: &mut Connection,
    root: &str,
    revision: &str,
    operation_id: &str,
    retained: &[(String, String)],
    held: &Held,
) -> Result<DeletionBegin, StoreError> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .storage()?;
    let snapshot = inspect(&tx, root, held)?;
    if snapshot.foreign_runtime || snapshot.pending_work {
        return Ok(DeletionBegin::Running);
    }
    if !snapshot.deleting && !snapshot.completed {
        if snapshot.revision != revision || snapshot.session_ids.is_empty() {
            return Ok(DeletionBegin::Changed);
        }
        let workspace_path = snapshot.workspace_path.clone().unwrap_or_default();
        let mut insert = tx
            .prepare(
                "insert into session_purge(session_id,root_id,operation_id,retained_artifacts,workspace_path,workspace_identity,state) values(?1,?2,?3,?4,?5,?6,'deleting')",
            )
            .storage()?;
        for id in &snapshot.session_ids {
            let kept: Vec<&String> = retained
                .iter()
                .filter(|(session, _)| session == id)
                .map(|(_, artifact)| artifact)
                .collect();
            insert
                .execute(rusqlite::params![
                    id,
                    root,
                    operation_id,
                    serde_json::to_string(&kept).map_err(crate::storage)?,
                    workspace_path,
                    snapshot.workspace_identity,
                ])
                .storage()?;
        }
    }
    tx.commit().storage()?;
    Ok(DeletionBegin::Admitted)
}

/// Node `completeSessionDeletion`: purge the rows of the receipt's tree, then mark its barrier rows `deleted`. The
/// barrier rows are kept as tombstones, so a later create or upsert of the same id is refused by the triggers.
pub(crate) fn complete(conn: &mut Connection, root: &str) -> Result<(), StoreError> {
    let receipt: Vec<String> = conn
        .prepare("select session_id from session_purge where root_id=?1")
        .storage()?
        .query_map([root], |row| row.get(0))
        .storage()?
        .collect::<rusqlite::Result<_>>()
        .storage()?;
    purge_sessions(conn, &receipt)?;
    conn.execute(
        "update session_purge set state='deleted' where root_id=?1",
        [root],
    )
    .storage()?;
    Ok(())
}

/// Node `purgeSessions`: the owned trees of `ids`, their input history, workflow runs and rows, in one transaction.
/// Message, part, todo and usage rows cascade by foreign key.
fn purge_sessions(conn: &mut Connection, ids: &[String]) -> Result<(), StoreError> {
    let mut all: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for id in ids {
        for tree_id in owned_tree(conn, id)? {
            if seen.insert(tree_id.clone()) {
                all.push(tree_id);
            }
        }
    }
    if all.is_empty() {
        return Ok(());
    }
    conn.execute_batch("pragma foreign_keys = on").storage()?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .storage()?;
    for chunk in all.chunks(SQL_ID_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        for sql in [
            format!("delete from input_history where session_id in ({marks})"),
            format!("delete from dwf_run where parent_session_id in ({marks})"),
            format!("delete from workflow_run where parent_session_id in ({marks})"),
            format!("delete from session where id in ({marks})"),
        ] {
            tx.execute(&sql, params_from_iter(chunk.iter())).storage()?;
        }
    }
    tx.commit().storage()?;
    Ok(())
}

/// Node `listOwnedSessionTrees` for several roots, in the order given.
pub(crate) fn owned_trees(
    conn: &Connection,
    roots: &[String],
) -> Result<Vec<(String, Vec<String>)>, StoreError> {
    roots
        .iter()
        .map(|root| Ok((root.clone(), owned_tree(conn, root)?)))
        .collect()
}

/// Node `listArtifactReferrers`: for each target, the other undeleted sessions whose parts name `zcode-artifact://<target>/`
/// (the scan is over parts only, by value, as Node does). A session never refers to its own artifacts.
pub(crate) fn artifact_referrers(
    conn: &Connection,
    targets: &[String],
) -> Result<Vec<(String, Vec<String>)>, StoreError> {
    let targets: HashSet<&str> = targets.iter().map(String::as_str).collect();
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, String)> = conn
        .prepare(
            "select p.session_id, p.data from part p join session s on s.id = p.session_id
             where s.time_deleted is null and instr(p.data, ?1) > 0",
        )
        .storage()?
        .query_map([ARTIFACT_SCHEME], |row| Ok((row.get(0)?, row.get(1)?)))
        .storage()?
        .collect::<rusqlite::Result<_>>()
        .storage()?;
    let mut referrers: Vec<(String, Vec<String>)> = Vec::new();
    for (session, body) in rows {
        for target in artifact_sessions(&body)? {
            if target == session || !targets.contains(target.as_str()) {
                continue;
            }
            match referrers.iter_mut().find(|(known, _)| *known == target) {
                Some((_, sessions)) => {
                    if !sessions.contains(&session) {
                        sessions.push(session.clone());
                    }
                }
                None => referrers.push((target, vec![session.clone()])),
            }
        }
    }
    Ok(referrers)
}

/// Node's `zcode-artifact://(<session>)/` matches in a body (the session only, the path after it is not needed).
fn artifact_sessions(body: &str) -> Result<Vec<String>, StoreError> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(offset) = body[from..].find(ARTIFACT_SCHEME) {
        let start = from + offset + ARTIFACT_SCHEME.len();
        let rest = &body[start..];
        let end = rest.find(|c: char| matches!(c, '/' | '"' | '\\') || c.is_whitespace());
        match end {
            Some(end) if end > 0 && rest[end..].starts_with('/') => {
                found.push(decode_component(&rest[..end])?);
                from = start + end + 1;
            }
            _ => from = start,
        }
    }
    Ok(found)
}

/// Node `purgeSessions` for the given sessions (their owned trees, in one transaction).
pub(crate) fn purge_rows(conn: &mut Connection, sessions: &[String]) -> Result<(), StoreError> {
    purge_sessions(conn, sessions)
}

fn fork_json(fork: &DeletionFork) -> String {
    format!(
        "{{\"sessionId\":{},\"title\":{}}}",
        json_string(&fork.session_id),
        json_string(&fork.title)
    )
}

fn reference_json(reference: &DeletionReference) -> String {
    let referrers: Vec<String> = reference
        .referrers
        .iter()
        .map(|referrer| {
            format!(
                "{{\"sessionId\":{},\"title\":{}}}",
                json_string(&referrer.session_id),
                json_string(&referrer.title)
            )
        })
        .collect();
    format!(
        "{{\"sessionId\":{},\"artifactId\":{},\"referrers\":[{}]}}",
        json_string(&reference.session_id),
        json_string(&reference.artifact_id),
        referrers.join(",")
    )
}

/// `JSON.stringify` of a string: the same escapes for the values a session row carries.
fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn json_array(values: &[String]) -> String {
    format!(
        "[{}]",
        values
            .iter()
            .map(|value| json_string(value))
            .collect::<Vec<_>>()
            .join(",")
    )
}

#[cfg(test)]
#[path = "session_deletion_tests.rs"]
mod tests;
