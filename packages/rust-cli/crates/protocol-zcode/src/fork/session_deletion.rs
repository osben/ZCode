//! Fork: `v4/storage/sessionData/deletionPreview` and `deletionExecute` (Node `zcode-protocol/session-data/
//! permanent-deletion.ts`). The store owns the barrier rows (`node-store/src/session_deletion.rs`); this module owns the
//! process-local facts (open runtimes, running turns), the per-session files ([`super::session_data_files`]) and the
//! Node result shapes. Order and reasons follow Node: a blocked preview is never executed, and once the barrier is
//! written a failure leaves the deletion `incomplete` (retry finishes it), not `blocked`.
//!
//! Not served here: `sessionDataPurge` and `sessionDataMeasure` (the Node module's other two methods), which stay
//! `method_not_found` (specs/fork-rust-agent-parity.md "Context composition, session deletion and model-request
//! metrics").

use std::path::PathBuf;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::EndReason;
use rust_cli_kernel_api::session_deletion::{
    DeletionBegin, DeletionReference, DeletionReferrer, SessionDeletionSnapshot,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::session_data_files::{self, FileError, FileKind, SessionFile};
use super::session_tree::{running_session_ids, store_error};
use crate::server::Server;

const PREVIEW: &str = "v4/storage/sessionData/deletionPreview";
const EXECUTE: &str = "v4/storage/sessionData/deletionExecute";

/// The request the two methods share: `{sessionId, workspace}`, plus `revision` and `operationId` for execute.
struct Request {
    session_id: String,
    workspace_path: String,
    workspace_identity: Option<String>,
    revision: String,
    operation_id: String,
}

/// Zod `z.string().min(1)`: a non-empty string, untrimmed.
fn non_empty_text(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn parse(params: &Value, execute: bool) -> Result<Request, RpcError> {
    let invalid = |detail: &str| {
        RpcError::invalid_params(format!("Invalid session deletion params: {detail}"))
    };
    let object = params
        .as_object()
        .ok_or_else(|| invalid("an object is required"))?;
    let allowed: &[&str] = if execute {
        &["sessionId", "workspace", "revision", "operationId"]
    } else {
        &["sessionId", "workspace"]
    };
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("unknown key"));
    }
    let session_id = object
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| super::session_data_files::is_safe_session_id(id))
        .ok_or_else(|| invalid("sessionId must be a plain session id"))?;
    let workspace = object
        .get("workspace")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("workspace is required"))?;
    if workspace
        .keys()
        .any(|key| key != "workspacePath" && key != "workspaceIdentity")
    {
        return Err(invalid("unknown workspace key"));
    }
    let workspace_path = workspace
        .get("workspacePath")
        .and_then(non_empty_text)
        .ok_or_else(|| invalid("workspacePath is required"))?;
    let workspace_identity = match workspace.get("workspaceIdentity") {
        None => None,
        Some(value) => Some(
            non_empty_text(value)
                .ok_or_else(|| invalid("workspaceIdentity must be a non-empty string"))?
                .to_owned(),
        ),
    };
    let (revision, operation_id) = if execute {
        (
            non_empty_text(&params["revision"])
                .ok_or_else(|| invalid("revision is required"))?
                .to_owned(),
            non_empty_text(&params["operationId"])
                .ok_or_else(|| invalid("operationId is required"))?
                .to_owned(),
        )
    } else {
        (String::new(), String::new())
    };
    Ok(Request {
        session_id: session_id.to_owned(),
        workspace_path: workspace_path.to_owned(),
        workspace_identity,
        revision,
        operation_id,
    })
}

/// Node `retainedArtifacts` entry: a reference, with the file that carries it (or the artifact id when none does).
struct Retained {
    session_id: String,
    artifact_id: String,
    file_name: String,
    referrers: Vec<DeletionReferrer>,
}

/// Node `inspect`: the snapshot with its checks, the files of the tree, the retained artifacts, the blocker and the
/// revision. The checks and the revision are Node's, so a preview from either build is accepted by the other.
struct Inspection {
    snapshot: SessionDeletionSnapshot,
    retained: Vec<Retained>,
    deleted_files: usize,
    blocked: Option<&'static str>,
    revision: String,
}

fn cli_root(server: &Server) -> Result<PathBuf, RpcError> {
    server
        .context
        .storage_root()
        .map(|root| root.join("cli"))
        .ok_or_else(|| RpcError::internal("session-data.unavailable"))
}

fn file_failure(error: FileError) -> RpcError {
    match error {
        FileError::Refused(code) => RpcError::internal(code),
        FileError::Io(error) => RpcError::internal(error.to_string()),
    }
}

async fn inspect(server: &Server, method: &str, request: &Request) -> Result<Inspection, RpcError> {
    let root = SessionId::new(&request.session_id);
    let snapshot = server
        .kernel
        .queries()
        .inspect_session_deletion(&root)
        .await
        .map_err(|error| store_error(method, error))?;
    if let Some(path) = snapshot
        .workspace_path
        .as_deref()
        .filter(|path| !path.is_empty())
    {
        let identity = snapshot.workspace_identity.as_deref().unwrap_or("");
        let requested = request.workspace_identity.as_deref().unwrap_or("");
        if path != request.workspace_path || identity != requested {
            return Err(RpcError::internal("session-data.identity-mismatch"));
        }
    }
    let cli = cli_root(server)?;
    let mut files = Vec::new();
    for id in &snapshot.session_ids {
        for file in session_data_files::list(&cli, id)
            .await
            .map_err(file_failure)?
        {
            files.push((id.clone(), file));
        }
    }
    let mut retained = Vec::new();
    for reference in &snapshot.references {
        let matched: Vec<&SessionFile> = files
            .iter()
            .filter(|(session, file)| {
                session == &reference.session_id
                    && file.kind == FileKind::Artifact
                    && file.name.contains(reference.artifact_id.as_str())
            })
            .map(|(_, file)| file)
            .collect();
        if matched.is_empty() {
            retained.push(retained_entry(reference, reference.artifact_id.clone()));
        } else {
            for file in matched {
                retained.push(retained_entry(reference, file.name.clone()));
            }
        }
    }
    let deleted_files = files
        .iter()
        .filter(|(session, file)| {
            !retained.iter().any(|kept| {
                &kept.session_id == session
                    && kept.file_name == file.name
                    && file.kind == FileKind::Artifact
            })
        })
        .count();
    let blocked = if snapshot.foreign_runtime
        || snapshot
            .local_runtime_ids
            .iter()
            .any(|id| server.bridge.get(&SessionId::new(id)).is_none())
    {
        Some("in-use")
    } else if snapshot.pending_work || !busy_session_ids(server, &snapshot.session_ids).is_empty() {
        Some("running")
    } else if snapshot.session_ids.is_empty() {
        Some("not-found")
    } else {
        None
    };
    let file_pairs: Vec<String> = files
        .iter()
        .map(|(_, file)| format!("[{},{}]", json_string(&file.relative_path), file.bytes))
        .collect();
    let blocked_json = blocked.map_or("null".to_owned(), json_string);
    let source = format!(
        "[{},[{}],{blocked_json}]",
        json_string(&snapshot.revision),
        file_pairs.join(",")
    );
    let revision = format!("{:x}", Sha256::digest(source.as_bytes()));
    Ok(Inspection {
        snapshot,
        retained,
        deleted_files,
        blocked,
        revision,
    })
}

/// Node `busy(id)` over the tree: a running turn, a pending interaction or a queued input (`residency_busy`), or a
/// running subagent in the tree (`running_session_ids`). Order follows `ids`.
pub(crate) fn busy_session_ids(server: &Server, ids: &[String]) -> Vec<String> {
    let mut busy: std::collections::HashSet<String> =
        running_session_ids(server, ids).into_iter().collect();
    for bridged in server.bridge.sessions() {
        let id = bridged.handle.id().as_str().to_owned();
        if ids.contains(&id) && bridged.sink.residency_busy() {
            busy.insert(id);
        }
    }
    // Node `sessionRequestCounts` and `sessionCreationIds`: a request or a create in flight for the session.
    for id in ids {
        if server.in_flight.busy(id) {
            busy.insert(id.clone());
        }
    }
    ids.iter()
        .filter(|id| busy.contains(*id))
        .cloned()
        .collect()
}

fn retained_entry(reference: &DeletionReference, file_name: String) -> Retained {
    Retained {
        session_id: reference.session_id.clone(),
        artifact_id: reference.artifact_id.clone(),
        file_name,
        referrers: reference.referrers.clone(),
    }
}

/// `v4/storage/sessionData/deletionPreview` (`V4SessionDeletionPreview`).
pub(crate) async fn preview(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let request = parse(params, false)?;
    let inspection = inspect(server, PREVIEW, &request).await?;
    let snapshot = &inspection.snapshot;
    let mut value = json!({
        "sessionId": request.session_id,
        "revision": inspection.revision,
        "sessionIds": snapshot.session_ids,
        "forks": snapshot.forks.iter().map(|fork| json!({"sessionId": fork.session_id, "title": fork.title})).collect::<Vec<_>>(),
        "retainedArtifacts": inspection.retained.iter().map(retained_json).collect::<Vec<_>>(),
        "deletedFiles": inspection.deleted_files,
        "incomplete": snapshot.deleting,
        "completed": snapshot.completed,
    });
    if let Some(reason) = inspection.blocked {
        value["blockedReason"] = json!(reason);
    }
    Ok(value)
}

fn retained_json(retained: &Retained) -> Value {
    json!({
        "sessionId": retained.session_id,
        "artifactId": retained.artifact_id,
        "fileName": retained.file_name,
        "referrers": retained.referrers.iter().map(|referrer| json!({"sessionId": referrer.session_id, "title": referrer.title})).collect::<Vec<_>>(),
    })
}

/// `v4/storage/sessionData/deletionExecute` (`V4SessionDeletionResult`).
pub(crate) async fn execute(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let request = parse(params, true)?;
    let inspection = inspect(server, EXECUTE, &request).await?;
    let snapshot = &inspection.snapshot;
    let mut result = json!({
        "sessionId": request.session_id,
        "sessionIds": snapshot.session_ids,
        "retainedArtifacts": inspection.retained.len(),
    });
    let outcome = if snapshot.completed {
        Outcome::Deleted
    } else if let Some(reason) = inspection.blocked {
        Outcome::Blocked(reason.to_owned())
    } else if !snapshot.deleting && inspection.revision != request.revision {
        Outcome::Blocked("changed".to_owned())
    } else if !busy_session_ids(server, &snapshot.session_ids).is_empty() {
        Outcome::Blocked("running".to_owned())
    } else {
        // Node: a failure before the barrier is written is `blocked`; after it, `incomplete` (a retry finishes it).
        let mut admitted = snapshot.deleting;
        match run(server, &request, &inspection, &mut admitted).await {
            Ok(()) => Outcome::Deleted,
            Err(reason) if admitted => Outcome::Incomplete(reason),
            Err(reason) => Outcome::Blocked(reason),
        }
    };
    match outcome {
        Outcome::Deleted => result["status"] = json!("deleted"),
        Outcome::Blocked(reason) => {
            result["status"] = json!("blocked");
            result["reason"] = json!(reason);
        }
        Outcome::Incomplete(reason) => {
            result["status"] = json!("incomplete");
            result["reason"] = json!(reason);
        }
    }
    tracing::info!(
        event = "session.permanent_delete",
        status = %result["status"],
        retained_artifacts = inspection.retained.len() as u64,
        "session permanent deletion"
    );
    Ok(result)
}

enum Outcome {
    Deleted,
    Blocked(String),
    Incomplete(String),
}

/// Node's admission and erase: the barrier, the runtimes released, the files, the rows, then the index forgets the
/// sessions. `admitted` turns true once the barrier is written. Errors are the reasons Node reports.
async fn run(
    server: &Server,
    request: &Request,
    inspection: &Inspection,
    admitted: &mut bool,
) -> Result<(), String> {
    let snapshot = &inspection.snapshot;
    let queries = server.kernel.queries();
    let root = SessionId::new(&request.session_id);
    let retained: Vec<(SessionId, String)> = inspection
        .retained
        .iter()
        .map(|retained| {
            (
                SessionId::new(&retained.session_id),
                retained.artifact_id.clone(),
            )
        })
        .collect();
    match queries
        .begin_session_deletion(&root, &snapshot.revision, &request.operation_id, &retained)
        .await
    {
        Ok(DeletionBegin::Admitted) => {}
        Ok(DeletionBegin::Running) => return Err("running".to_owned()),
        Ok(DeletionBegin::Changed) => return Err("changed".to_owned()),
        Err(_) => return Err("unavailable".to_owned()),
    }
    *admitted = true;
    // Release the idle runtimes without a removal announcement (Node `deactivateSessionRecord`): the session still exists
    // until its rows are gone.
    for id in &snapshot.session_ids {
        if let Some(bridged) = server.bridge.close(&SessionId::new(id)) {
            bridged.handle.close(EndReason::Other).await;
        }
    }
    let cli = cli_root(server).map_err(|_| "unavailable".to_owned())?;
    for id in &snapshot.session_ids {
        let kept: Vec<String> = inspection
            .retained
            .iter()
            .filter(|retained| &retained.session_id == id)
            .map(|retained| retained.artifact_id.clone())
            .collect();
        session_data_files::remove(&cli, id, &kept)
            .await
            .map_err(|error| error.code_or("unavailable"))?;
    }
    queries
        .complete_session_deletion(&root)
        .await
        .map_err(|_| "unavailable".to_owned())?;
    // Node `forgetIndexedSession` is global: the session leaves every loaded index, not only its own workspace's.
    for id in &snapshot.session_ids {
        server.topics.remove_everywhere(id);
    }
    Ok(())
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

#[cfg(test)]
#[path = "session_deletion_tests.rs"]
mod tests;
