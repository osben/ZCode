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
        "session/lifecycle/getState" => lifecycle_state(server, &params).await,
        "v4/conversation/plans" => plans(server, &params).await,
        // zcode-rs has no dynamic workflows (P4): there are never runs to list.
        "v4/conversation/workflowRuns" => Ok(json!({"runs": []})),
        "session/debug" => session_debug(&params),
        _ => return None,
    };
    Some(result.map(Reply::new))
}

/// Node `SessionLifecycleController.getState` without an operation in flight: an open session is `ready`, a stored
/// one is `unloaded`. zcode-rs opens sessions on demand and never fails an activation it reports, so `generation`
/// and `revision` stay 0 and `lastError` is null.
async fn lifecycle_state(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let Some(id) = params["sessionId"].as_str().filter(|id| !id.is_empty()) else {
        return Err(RpcError::invalid_params("sessionId is required"));
    };
    let session = SessionId::new(id);
    let state = if server.bridge.get(&session).is_some() {
        "ready"
    } else {
        server
            .kernel
            .session_snapshot(&session)
            .await
            .map_err(|error| kernel_error(&error))?;
        "unloaded"
    };
    Ok(json!({"sessionId": id, "state": state, "generation": 0, "revision": 0, "lastError": null}))
}

fn session_id(params: &Value) -> Result<SessionId, RpcError> {
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
