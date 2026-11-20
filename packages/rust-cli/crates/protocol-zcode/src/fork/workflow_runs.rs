//! Fork: the `v4/conversation/workflowRuns` read, answered by the Rust run service (specs/fork-rust-workflow-engine.md,
//! 9.29, W7-5a-4).
//!
//! Node answers the read from the journal (`listRunsForSession`), with the live roster taking precedence for the runs it
//! holds. The Rust run service does the same through its per-session port, so this module only validates the params and
//! hands the session over. The params follow Node's strict schema: `sessionId` is required, `workspace` is an optional
//! strict workspace reference, `limit` is an optional integer from 1 to 64 (default 16), and an unknown key is refused.

use rust_cli_base::js::string::trim;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::server::Server;

/// Node `DEFAULT_LIST_RUNS_LIMIT`.
pub(crate) const DEFAULT_LIMIT: usize = 16;
/// Node `MAX_LIST_RUNS_LIMIT`.
const MAX_LIMIT: usize = 64;
const KEYS: [&str; 3] = ["workspace", "sessionId", "limit"];

/// The validated params of the read.
#[derive(Debug, PartialEq)]
pub(crate) struct SessionRunsParams {
    pub session_id: String,
    pub limit: usize,
}

/// Node's zod failure carries a field detail after the dash; the code (-32602) is the contract.
fn invalid(detail: impl std::fmt::Display) -> RpcError {
    RpcError::invalid_params(format!("Invalid params — {detail}"))
}

/// Node `zcodeWorkspaceRefSchema` (`zcode-protocol-legacy-types.ts`), strict: `workspacePath` and `workspaceKey` are
/// required, `workspaceIdentity` and `remoteSessionId` are optional, every string is non-empty after JS trim, and no
/// other key is allowed.
fn workspace_ref_is_valid(value: &Value) -> bool {
    const KEYS: [&str; 4] = [
        "workspacePath",
        "workspaceIdentity",
        "remoteSessionId",
        "workspaceKey",
    ];
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.keys().any(|key| !KEYS.contains(&key.as_str())) {
        return false;
    }
    let non_empty = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|text| !trim(text).is_empty())
    };
    let optional_non_empty = |key: &str| object.get(key).is_none_or(|_| non_empty(key));
    non_empty("workspacePath")
        && non_empty("workspaceKey")
        && optional_non_empty("workspaceIdentity")
        && optional_non_empty("remoteSessionId")
}

/// Validates the params as Node's strict schema does (`v4ConversationWorkflowRunsParamsSchema`).
pub(crate) fn parse(params: &Value) -> Result<SessionRunsParams, RpcError> {
    let object = params
        .as_object()
        .ok_or_else(|| invalid("expected an object"))?;
    if let Some(key) = object.keys().find(|key| !KEYS.contains(&key.as_str())) {
        return Err(invalid(format!("unrecognized key {key}")));
    }
    // Node's `v4ColdResumeWorkspaceSchema` is optional; when present it is the strict workspace reference.
    if let Some(workspace) = object.get("workspace")
        && !workspace_ref_is_valid(workspace)
    {
        return Err(invalid("workspace must be a workspace reference"));
    }
    let session_id = match object.get("sessionId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_owned(),
        _ => return Err(invalid("sessionId must be a non-empty string")),
    };
    let limit = match object.get("limit") {
        None => DEFAULT_LIMIT,
        Some(value) => value
            .as_f64()
            .filter(|n| n.fract() == 0.0 && *n >= 1.0 && *n <= MAX_LIMIT as f64)
            .map(|n| n as usize)
            .ok_or_else(|| invalid("limit must be an integer from 1 to 64"))?,
    };
    Ok(SessionRunsParams { session_id, limit })
}

/// Answers the read through the run service, or with an empty list when the composition has not installed one.
pub(crate) async fn list(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let parsed = parse(params)?;
    let Some(sessions) = server.context.dynamic_workflow_runs() else {
        return Ok(json!({ "runs": [] }));
    };
    sessions
        .for_session(&SessionId::new(parsed.session_id))
        .list_runs_for_session(parsed.limit)
        .await
        .map_err(|error| RpcError::internal(error.message))
}

#[cfg(test)]
#[path = "workflow_runs_tests.rs"]
mod tests;
