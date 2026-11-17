//! Fork: `v4/storage/sessionData/measure` and `purge` (Node `zcode-protocol/session-data/index.ts`). A tree is its root
//! and its owned descendants: a tree is kept whole or deleted whole. A tree with a busy session is `running`; a tree an
//! artifact of which another session still names is `referenced`, transitively. Files go before rows, so a failure
//! leaves the rows for the retry. Node's `failureCode` is the errno name, or `unknown`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::EndReason;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use super::session_data_files::{self, FileError};
use super::session_data_size::{measure_path, measure_session, project_memory_folder};
use super::session_deletion::busy_session_ids;
use super::session_tree::store_error;
use crate::server::Server;

const MEASURE: &str = "v4/storage/sessionData/measure";
const PURGE: &str = "v4/storage/sessionData/purge";
/// Node `UNKNOWN_FAILURE_CODE`: a failure that carries no errno (a Node `Error` has no `code`).
const UNKNOWN: &str = "unknown";

struct Directory {
    workspace_path: String,
    workspace_identity: Option<String>,
}

struct Request {
    session_ids: Vec<String>,
    directories: Vec<Directory>,
}

fn parse(params: &Value) -> Result<Request, RpcError> {
    let invalid =
        |detail: &str| RpcError::invalid_params(format!("Invalid session data params: {detail}"));
    let object = params
        .as_object()
        .ok_or_else(|| invalid("an object is required"))?;
    if object.len() != 2
        || object
            .keys()
            .any(|key| key != "sessionIds" && key != "directories")
    {
        return Err(invalid(
            "sessionIds and directories are required, and only those",
        ));
    }
    let non_empty = |value: &Value| {
        value
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let session_ids = params["sessionIds"]
        .as_array()
        .ok_or_else(|| invalid("sessionIds must be an array"))?
        .iter()
        .map(|value| {
            non_empty(value).ok_or_else(|| invalid("sessionIds entries must be non-empty strings"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let directories = params["directories"]
        .as_array()
        .ok_or_else(|| invalid("directories must be an array"))?
        .iter()
        .map(|entry| {
            let object = entry
                .as_object()
                .ok_or_else(|| invalid("directories entries must be objects"))?;
            if object
                .keys()
                .any(|key| key != "workspacePath" && key != "workspaceIdentity")
            {
                return Err(invalid("unknown directory key"));
            }
            let workspace_path = object
                .get("workspacePath")
                .and_then(non_empty)
                .ok_or_else(|| invalid("workspacePath is required"))?;
            let workspace_identity = match object.get("workspaceIdentity") {
                None => None,
                Some(value) => Some(
                    non_empty(value)
                        .ok_or_else(|| invalid("workspaceIdentity must be non-empty"))?,
                ),
            };
            Ok(Directory {
                workspace_path,
                workspace_identity,
            })
        })
        .collect::<Result<Vec<_>, RpcError>>()?;
    Ok(Request {
        session_ids,
        directories,
    })
}

fn cli_root(server: &Server) -> Result<PathBuf, RpcError> {
    server
        .context
        .storage_root()
        .map(|root| root.join("cli"))
        .ok_or_else(|| RpcError::internal("session-data.unavailable"))
}

/// Node `trees`: each root with its owned tree; a root that has no row still counts as itself, so leftover files go.
async fn trees(
    server: &Server,
    method: &str,
    roots: &[String],
) -> Result<Vec<(String, Vec<String>)>, RpcError> {
    let ids: Vec<SessionId> = roots.iter().map(SessionId::new).collect();
    let owned = server
        .kernel
        .queries()
        .list_owned_session_trees(&ids)
        .await
        .map_err(|error| store_error(method, error))?;
    let mut trees = Vec::with_capacity(roots.len());
    for root in roots {
        let found = owned
            .iter()
            .find(|(id, _)| id.as_str() == root)
            .map(|(_, members)| {
                members
                    .iter()
                    .map(|id| id.as_str().to_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let members = if found.is_empty() {
            vec![root.clone()]
        } else {
            found
        };
        trees.push((root.clone(), members));
    }
    Ok(trees)
}

/// `v4/storage/sessionData/measure` (`V4SessionDataMeasureResult`).
pub(crate) async fn measure(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let request = parse(params)?;
    let cli = cli_root(server)?;
    let mut sessions = Vec::new();
    for (root, members) in trees(server, MEASURE, &request.session_ids).await? {
        let mut bytes = 0;
        for id in &members {
            bytes += measure_session(&cli, id).await.map_err(file_failure)?;
        }
        sessions.push(json!({"sessionId": root, "bytes": bytes}));
    }
    let mut memory = Vec::new();
    for directory in &request.directories {
        let folder = project_memory_folder(
            &cli,
            &directory.workspace_path,
            directory.workspace_identity.as_deref(),
        );
        let bytes = measure_path(&folder).await.map_err(file_failure)?;
        memory.push(json!({"workspacePath": directory.workspace_path, "bytes": bytes}));
    }
    Ok(json!({"sessions": sessions, "memory": memory}))
}

/// `v4/storage/sessionData/purge` (`V4SessionDataPurgeResult`).
pub(crate) async fn purge(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let request = parse(params)?;
    let cli = cli_root(server)?;
    let trees = trees(server, PURGE, &request.session_ids).await?;
    let all: Vec<String> = trees
        .iter()
        .flat_map(|(_, members)| members.clone())
        .collect();
    let busy = busy_session_ids(server, &all);
    let running: HashSet<&str> = trees
        .iter()
        .filter(|(_, members)| members.iter().any(|id| busy.contains(id)))
        .map(|(root, _)| root.as_str())
        .collect();
    let candidates: Vec<&(String, Vec<String>)> = trees
        .iter()
        .filter(|(root, _)| !running.contains(root.as_str()))
        .collect();
    let referenced = referenced_roots(server, &candidates).await?;

    let mut deleted = Vec::new();
    let mut kept = Vec::new();
    let mut failed = Vec::new();
    for (root, members) in &trees {
        if running.contains(root.as_str()) {
            kept.push(json!({"sessionId": root, "reason": "running"}));
        } else if referenced.contains(root) {
            kept.push(json!({"sessionId": root, "reason": "referenced"}));
        } else {
            match delete_tree(server, &cli, root, members, &busy).await {
                Ok(bytes) => deleted.push(json!({"sessionId": root, "bytes": bytes})),
                Err(code) => failed.push(json!({"sessionId": root, "code": code})),
            }
        }
    }
    let mut memory = Vec::new();
    for directory in &request.directories {
        let folder = project_memory_folder(
            &cli,
            &directory.workspace_path,
            directory.workspace_identity.as_deref(),
        );
        let outcome = async {
            let bytes = measure_path(&folder).await?;
            rust_cli_fs::remove_path_force(&folder)
                .await
                .map_err(FileError::Io)?;
            Ok::<u64, FileError>(bytes)
        }
        .await;
        match outcome {
            Ok(bytes) => {
                memory.push(json!({"workspacePath": directory.workspace_path, "bytes": bytes}))
            }
            Err(error) => failed.push(
                json!({"workspacePath": directory.workspace_path, "code": failure_code(&error)}),
            ),
        }
    }
    tracing::info!(
        event = "zcode_protocol.session_data.purged",
        deleted = deleted.len() as u64,
        kept = kept.len() as u64,
        failed = failed.len() as u64,
        "session data purged"
    );
    Ok(json!({"deleted": deleted, "kept": kept, "failed": failed, "memory": memory}))
}

/// Node `referencedRoots`: a tree is referenced when one of its artifacts is named by a session outside the trees that
/// are still removed. Removing a referenced tree makes its own sessions referrers, so the set is iterated to a fixed point.
async fn referenced_roots(
    server: &Server,
    candidates: &[&(String, Vec<String>)],
) -> Result<HashSet<String>, RpcError> {
    let all: Vec<SessionId> = candidates
        .iter()
        .flat_map(|(_, members)| members.iter().map(SessionId::new))
        .collect();
    let listed = server
        .kernel
        .queries()
        .list_artifact_referrers(&all)
        .await
        .map_err(|error| store_error(PURGE, error))?;
    let referrers: HashMap<&str, Vec<&str>> = listed
        .iter()
        .map(|(target, sessions)| {
            (
                target.as_str(),
                sessions.iter().map(SessionId::as_str).collect(),
            )
        })
        .collect();
    let mut removable: HashSet<&str> = candidates
        .iter()
        .flat_map(|(_, members)| members.iter().map(String::as_str))
        .collect();
    let mut referenced: HashSet<String> = HashSet::new();
    for _ in 0.. {
        let mut changed = false;
        for (root, members) in candidates {
            if referenced.contains(root) {
                continue;
            }
            let outside = members.iter().any(|id| {
                referrers.get(id.as_str()).is_some_and(|sessions| {
                    sessions.iter().any(|session| !removable.contains(session))
                })
            });
            if !outside {
                continue;
            }
            referenced.insert(root.clone());
            for id in members {
                removable.remove(id.as_str());
            }
            changed = true;
        }
        if !changed {
            break;
        }
    }
    Ok(referenced)
}

/// Node `removeTree`: release the idle loaded sessions, remove their files, then the rows, then forget them from the
/// sessions index. Returns the bytes, or the failure code of the first step that fails.
async fn delete_tree(
    server: &Server,
    cli: &Path,
    root: &str,
    members: &[String],
    busy: &[String],
) -> Result<u64, String> {
    for id in members {
        if busy.contains(id) {
            continue;
        }
        if let Some(bridged) = server.bridge.close(&SessionId::new(id)) {
            bridged.handle.close(EndReason::Other).await;
        }
    }
    let mut bytes = 0;
    for id in members {
        bytes += session_data_files::remove(cli, id, &[])
            .await
            .map_err(|error| failure_code(&error))?;
    }
    server
        .kernel
        .queries()
        .purge_session_rows(&[SessionId::new(root)])
        .await
        .map_err(|_| UNKNOWN.to_owned())?;
    // Node `forgetIndexedSession` is global: the session leaves every loaded index, whichever directory it was listed under.
    for id in members {
        server.topics.remove_everywhere(id);
    }
    Ok(bytes)
}

/// Node `failureCode`: the errno name when the error has one, else `unknown`. A refused id (Node's plain `Error`) has none.
fn failure_code(error: &FileError) -> String {
    match error {
        FileError::Refused(_) => UNKNOWN.to_owned(),
        FileError::Io(error) => {
            rust_cli_fs::error_code(error).map_or_else(|| UNKNOWN.to_owned(), str::to_owned)
        }
    }
}

fn file_failure(error: FileError) -> RpcError {
    match error {
        FileError::Refused(code) => RpcError::internal(code),
        FileError::Io(error) => RpcError::internal(error.to_string()),
    }
}

#[cfg(test)]
#[path = "session_data_tests.rs"]
mod tests;
