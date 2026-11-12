//! Fork: `session/releaseUnderDirectory` (Node `releaseSessionsUnderDirectory` in
//! `zcode-protocol/server-operations.ts`; docs/git/worktree.md §8.3). The Host calls it before it removes a managed
//! worktree: every open session whose cwd is inside the directory is released (its runtime is closed, nothing is
//! deleted), unless one of them is busy, and then nothing is released. The rules are in
//! specs/fork-rust-agent-parity.md "Upstream 3.18.0 gaps (wave 2)", A3.

use std::sync::Arc;

use rust_cli_kernel_api::env_files::PathStyle;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::EndReason;
use rust_cli_protocol_core::rpc::RpcError;
use rust_cli_protocol_core::sessions::Bridged;
use serde_json::{Value, json};

use crate::live::Live;
use crate::server::Server;

pub(crate) async fn release(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let directory = directory(params)?;
    let style = PathStyle::infer(&directory);
    // Node checks busy and starts the unload with no await in between, so a command admitted after the check cannot
    // reach a session that is being unloaded. Everything up to the first close is synchronous.
    let mut matched: Vec<(String, Arc<Bridged<Live>>)> = server
        .bridge
        .sessions()
        .into_iter()
        .filter(|open| style.is_within(&open.sink.cwd(), &directory))
        .map(|open| (open.handle.id().as_str().to_owned(), open))
        .collect();
    matched.sort_by(|left, right| left.0.cmp(&right.0));
    let busy: Vec<String> = matched
        .iter()
        .filter(|(_, open)| open.sink.residency_blocking())
        .map(|(id, _)| id.clone())
        .collect();
    if !busy.is_empty() {
        return Ok(json!({"released": [], "busy": busy}));
    }
    let mut released = Vec::with_capacity(matched.len());
    for (id, open) in matched {
        let session = SessionId::new(&id);
        // Same unload as `session/lifecycle/stop`: the bridge stops forwarding, the kernel actor ends, and the App
        // sees `unloaded`. The store is not touched.
        server.bridge.close(&session);
        open.handle.close(EndReason::Other).await;
        server.announce_lifecycle(&session, "unloaded").await;
        released.push(id);
    }
    Ok(json!({"released": released, "busy": []}))
}

/// `{directory}` only (Node's strict params schema): the directory is a non-empty string.
fn directory(params: &Value) -> Result<String, RpcError> {
    let object = params
        .as_object()
        .ok_or_else(|| RpcError::invalid_params("params must be an object"))?;
    if let Some(field) = object.keys().find(|key| key.as_str() != "directory") {
        return Err(RpcError::invalid_params(format!("unknown field {field}")));
    }
    object
        .get("directory")
        .and_then(Value::as_str)
        .filter(|directory| !directory.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RpcError::invalid_params("directory is required"))
}

#[cfg(test)]
#[path = "release_under_directory_tests.rs"]
mod tests;
