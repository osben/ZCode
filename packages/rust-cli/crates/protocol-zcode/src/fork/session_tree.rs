//! Fork: `session/treeCounts` and `session/eraseTree` (Node `zcode-protocol/session-tree.ts`,
//! specs `session-deletion-cascade.md` §4-§6). The store owns the database rows; this module
//! owns the process-local facts the store cannot know (live runtimes, busy turns) and the
//! per-session directories under the CLI storage root.

use std::collections::HashSet;
use std::path::Path;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::EndReason;
use rust_cli_kernel_api::store::StoreError;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::projection::state::Phase;
use crate::server::Server;

/// Directories under `<storageRoot>/cli` that are keyed by exactly the session id (tool
/// artifacts, derived media caches, script-workflow files). bash-startup and persisted exec
/// output are keyed under roots this server does not know, so they are left in place.
const PER_SESSION_DIRECTORIES: [&str; 5] = [
    "artifacts",
    "image-cache",
    "pdf-cache",
    "video-cache",
    "sessions",
];

/// Node `SAFE_SEGMENT` (`/^[A-Za-z0-9._-]{1,120}$/u` plus the `.`/`..` refusal): matches what the
/// artifact store's path sanitizer leaves unchanged, so the segment equals the id. The charset
/// is ASCII-only, so bytes equal code points here.
fn is_plain_segment(session_id: &str) -> bool {
    (1..=120).contains(&session_id.len())
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && session_id != "."
        && session_id != ".."
}

/// The params schema both methods share (`zcodeSessionTreeCountsParamsSchema`):
/// `z.object({ sessionIds: z.array(nonEmptyString).min(1).max(5000) })`, parsed strictly.
fn parse_session_ids(params: &Value) -> Result<Vec<String>, RpcError> {
    let invalid =
        |detail: &str| RpcError::invalid_params(format!("Invalid session tree params: {detail}"));
    let Some(object) = params.as_object() else {
        return Err(invalid("an object with sessionIds is required"));
    };
    if object.len() != 1 {
        return Err(invalid("only sessionIds is allowed"));
    }
    let Some(list) = object["sessionIds"].as_array() else {
        return Err(invalid("sessionIds must be an array"));
    };
    if list.is_empty() {
        return Err(invalid("sessionIds must have at least 1 entry"));
    }
    if list.len() > 5000 {
        return Err(invalid("sessionIds must have at most 5000 entries"));
    }
    let mut ids = Vec::with_capacity(list.len());
    for entry in list {
        let Some(id) = entry.as_str() else {
            return Err(invalid("sessionIds entries must be strings"));
        };
        // `nonEmptyString` trims before the length check, and the trimmed value is what the
        // methods receive.
        let trimmed = id.trim();
        if trimmed.is_empty() {
            return Err(invalid("sessionIds entries must not be blank"));
        }
        ids.push(trimmed.to_owned());
    }
    Ok(ids)
}

/// A store without the shared database answers like Node's "Session tree operations are not
/// supported": the same code as an unknown method, so callers have a single unsupported path.
fn store_error(method: &str, error: StoreError) -> RpcError {
    match error {
        StoreError::Unsupported { .. } => RpcError::method_not_found(method),
        other => RpcError::internal(other.to_string()),
    }
}

/// Node `findRunningSessionIds` for this agent: sessions of the tree whose live runtime is busy.
/// Only already-open sessions count (a cold one has no live turn to protect, and opening here
/// would race the erase). Node also asks its v4 gateway for detached child sessions; the Rust
/// agent has no detached gateway children, so there is nothing to add.
fn running_session_ids(server: &Server, tree_ids: &[String]) -> Vec<String> {
    let mut open_running: HashSet<String> = HashSet::new();
    for bridged in server.bridge.sessions() {
        if bridged.sink.status().0 == Phase::Running {
            open_running.insert(bridged.handle.id().as_str().to_owned());
        }
    }
    tree_ids
        .iter()
        .filter(|id| open_running.contains(*id))
        .cloned()
        .collect()
}

/// Node `removeSessionDirectories`: delete each session's per-session directories, counting
/// failures. Missing directories are not failures (`rm … force: true`). Without a storage root
/// there is nothing to resolve; the rows are still erased.
async fn remove_session_directories(storage_root: Option<&Path>, session_ids: &[String]) -> usize {
    let Some(root) = storage_root else {
        return 0;
    };
    let mut failures = 0;
    for session_id in session_ids {
        if !is_plain_segment(session_id) {
            continue;
        }
        for directory in PER_SESSION_DIRECTORIES {
            let base = root.join("cli").join(directory);
            let target = base.join(session_id);
            // Defense in depth: only ever delete a direct child of a known root.
            let direct_child = target
                .parent()
                .is_some_and(|parent| parent == base.as_path())
                && target.file_name() == Some(std::ffi::OsStr::new(session_id));
            if !direct_child {
                failures += 1;
                continue;
            }
            if rust_cli_fs::remove_dir_all_optional(&target).await.is_err() {
                failures += 1;
            }
        }
    }
    failures
}

/// `session/treeCounts` (`zcodeSessionTreeCountsResultSchema`): the tree mix plus how many of
/// its sessions are currently running.
pub(crate) async fn tree_counts(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let roots = parse_session_ids(params)?;
    let queries = server.kernel.queries();
    let counts = queries
        .session_tree_counts(roots.clone())
        .await
        .map_err(|error| store_error("session/treeCounts", error))?;
    let tree_ids = queries
        .session_tree_ids(roots)
        .await
        .map_err(|error| store_error("session/treeCounts", error))?;
    let running = running_session_ids(server, &tree_ids).len();
    Ok(json!({
        "total": counts.total,
        "sideChats": counts.side_chats,
        "subagents": counts.subagents,
        "workflowSessions": counts.workflow_sessions,
        "workflowRuns": counts.workflow_runs,
        "running": running,
    }))
}

/// `session/eraseTree` (`zcodeSessionEraseTreeResultSchema`): refuse while a tree session runs,
/// close idle runtimes, remove per-session directories (keeping those a surviving fork points
/// at), then erase the rows in one transaction. Any file failure erases nothing, so a retry
/// finds the same tree and finishes the cleanup.
pub(crate) async fn erase_tree(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let roots = parse_session_ids(params)?;
    let requested_root_count = roots.len();
    let queries = server.kernel.queries();
    let tree_ids = queries
        .session_tree_ids(roots.clone())
        .await
        .map_err(|error| store_error("session/eraseTree", error))?;

    // The running guard is process-local: the session database has no lease, so a turn running
    // in another window's agent is not visible here.
    let running = running_session_ids(server, &tree_ids);
    if !running.is_empty() {
        return Ok(json!({
            "erasedSessionIds": [],
            "blockedRunningSessionIds": running,
            "fileFailureCount": 0,
            "filesRetainedCount": 0,
        }));
    }

    // Close idle resident runtimes first so no late write can recreate a row after the delete.
    // The actor handle ends too (as session delete does): a bridge-only close would keep the
    // runtime, whose end-of-turn commits would recreate rows.
    for id in &tree_ids {
        if let Some(bridged) = server.bridge.close(&SessionId::new(id)) {
            bridged.handle.close(EndReason::Other).await;
        }
    }

    // Directories of sessions that a surviving fork points at are kept: the fork's copied parts
    // still resolve artifact and media URLs to the source session's directory. Ids that are not
    // a plain segment cannot be located safely and are left alone as well.
    let mut retained: HashSet<String> = queries
        .session_tree_ids_with_surviving_children(roots.clone())
        .await
        .map_err(|error| store_error("session/eraseTree", error))?
        .into_iter()
        .collect();
    for id in &tree_ids {
        if !is_plain_segment(id) {
            retained.insert(id.clone());
        }
    }
    // Files go before the rows (see the module doc): a failure must leave the tree intact.
    let removable: Vec<String> = tree_ids
        .iter()
        .filter(|id| !retained.contains(*id))
        .cloned()
        .collect();
    let storage_root = server.context.storage_root();
    let file_failure_count = remove_session_directories(storage_root, &removable).await;
    if file_failure_count > 0 {
        return Ok(json!({
            "erasedSessionIds": [],
            "blockedRunningSessionIds": [],
            "fileFailureCount": file_failure_count,
            "filesRetainedCount": retained.len(),
        }));
    }

    let erased = queries
        .erase_session_tree(roots)
        .await
        .map_err(|error| store_error("session/eraseTree", error))?;
    // A child created between the listing and the delete is erased too; its directory is best
    // effort. Node removes these late ids without a retained check (a fork of it cannot exist
    // yet), and so does this port.
    let known: HashSet<&String> = tree_ids.iter().collect();
    let late: Vec<String> = erased
        .erased_ids
        .iter()
        .filter(|id| !known.contains(*id))
        .cloned()
        .collect();
    let late_failures = remove_session_directories(storage_root, &late).await;
    // Fork: stop what the kernel still runs for the erased sessions (notice forwarders, background commands on every
    // machine), as Node's runtime close does (specs/fork-rust-agent-parity.md, "After a restart, and on a remote
    // executor").
    server
        .kernel
        .sessions_erased(erased.erased_ids.iter().map(SessionId::new).collect())
        .await;
    // Tell the sessions index each erased root is gone (the store returns the workspace the row
    // carried, read before the delete). Node's erase has no announcement; the Rust sessions
    // index needs one or the row lingers until the next reconcile.
    for (root, workspace) in &erased.erased_roots {
        server.topics.remove(workspace, root);
    }
    tracing::info!(
        event = "protocol.session.tree_erased",
        requested_root_count = requested_root_count as u64,
        erased_session_count = erased.erased_ids.len() as u64,
        file_failure_count = late_failures as u64,
        files_retained_count = retained.len() as u64,
        "the session tree was erased"
    );
    Ok(json!({
        "erasedSessionIds": erased.erased_ids,
        "blockedRunningSessionIds": [],
        "fileFailureCount": late_failures,
        "filesRetainedCount": retained.len(),
    }))
}
