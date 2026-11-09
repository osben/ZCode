//! Fork: JSON-RPC methods beyond the upstream P1 set. `None` means the method is not ported, and the
//! caller answers `-32601`.

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_protocol_core::connection::Reply;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::server::{Server, kernel_error};

pub(crate) async fn dispatch(
    server: &Server,
    method: &str,
    params: Value,
) -> Option<Result<Reply, RpcError>> {
    let result = match method {
        "v4/conversation/plans" => plans(server, &params).await,
        // Fork: the App's per-turn file summary queries (specs/fork-rust-agent-parity.md).
        "v4/conversation/fileChanges" => super::file_summary::file_changes(server, &params).await,
        "v4/conversation/fileRewindPreview" => {
            super::file_summary::file_rewind_preview(server, &params).await
        }
        // zcode-rs has no dynamic workflows (P4): there are never runs to list.
        "v4/conversation/workflowRuns" => Ok(json!({"runs": []})),
        // Fork: permanent session-tree erase and its counts (Node `zcode-protocol/session-tree.ts`).
        "session/treeCounts" => super::session_tree::tree_counts(server, &params).await,
        "session/eraseTree" => super::session_tree::erase_tree(server, &params).await,
        "session/debug" => session_debug(&params),
        "skills/referenceCatalog" => super::skills::reference_catalog(server, &params).await,
        // Fork: the App's subagent directory pane (Node `listSessionSubagents`).
        "session/subagents" => super::subagents::subagents(server, &params).await,
        // Fork: the App's usage surfaces.
        "v4/usage/stats" => super::usage::usage_stats(server, &params).await,
        "v4/conversation/usage" => super::usage::conversation_usage(server, &params).await,
        // Fork: the background Bash detail pane (Node `readBackgroundBashOutput`).
        "v4/conversation/backgroundBashOutput" => {
            super::background_work::bash_output(server, &params).await
        }
        _ => return None,
    };
    Some(result.map(Reply::new))
}

pub(super) fn session_id(params: &Value) -> Result<SessionId, RpcError> {
    params["sessionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(SessionId::new)
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))
}

/// Node `V4Gateway.plans`: a cold session is opened to read its rows.
async fn plans(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let session = session_id(params)?;
    let live = server
        .live(&session)
        .await
        .map_err(|error| kernel_error(&error))?;
    Ok(live.sink.plans())
}

/// `sessionDebugSnapshotSchema` without rounds: zcode-rs keeps no per-request debug records, so the panel shows an
/// empty history instead of an error.
fn session_debug(params: &Value) -> Result<Value, RpcError> {
    let session = session_id(params)?;
    Ok(json!({"sessionId": session.as_str(), "rounds": [], "networkEntries": [], "cache": null}))
}
