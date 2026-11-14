//! Fork: the request gate of the session runtime presence protocol (Node `server.ts`, `assertSessionNotDeleting`
//! before dispatch; specs/fork-rust-agent-parity.md "Session runtime presence on the shared database").
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::store::{SESSION_DATA_DELETING, StoreError, StoreQueries};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::Value;

/// Node `collectResidencySessionIds`: `sessionId`, the conversation topic's session and `commands[].sessionId`.
pub(crate) fn session_ids(params: &Value) -> Vec<SessionId> {
    let topic = params["topic"]
        .as_str()
        .and_then(|topic| topic.strip_prefix("conversation/"));
    let commands = params["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|command| command["sessionId"].as_str());
    let mut ids: Vec<&str> = Vec::new();
    for id in [params["sessionId"].as_str(), topic]
        .into_iter()
        .chain(commands)
        .flatten()
    {
        if !id.is_empty() && !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.into_iter().map(SessionId::new).collect()
}

/// Refuses a request for a session whose purge started elsewhere, as Node's `Error("session-data.deleting")`
/// reaches the wire (`-32603`, that message). The deletion methods are not gated (Node skips them).
pub(crate) async fn check(
    queries: &dyn StoreQueries,
    method: &str,
    params: &Value,
) -> Result<(), RpcError> {
    if DELETION_METHODS.contains(&method) {
        return Ok(());
    }
    let ids = session_ids(params);
    if ids.is_empty() {
        return Ok(());
    }
    match queries.assert_not_deleting(&ids).await {
        Err(StoreError::Deleting) => Err(RpcError::internal(SESSION_DATA_DELETING)),
        Err(error) => Err(RpcError::internal(error.to_string())),
        Ok(()) => Ok(()),
    }
}

/// Node `V4_METHODS.sessionDeletionPreview` / `sessionDeletionExecute` (zcode-rs does not serve them).
const DELETION_METHODS: [&str; 2] = [
    "v4/storage/sessionData/deletionPreview",
    "v4/storage/sessionData/deletionExecute",
];

#[cfg(test)]
#[path = "presence_gate_tests.rs"]
mod tests;
