//! Fork: `session/releaseUnderDirectory` (Node `releaseSessionsUnderDirectory` in
//! `zcode-protocol/server-operations.ts`; docs/git/worktree.md §8.3). The Host calls it before it removes a managed
//! worktree: every open session whose cwd is inside the directory is released (its runtime is closed, nothing is
//! deleted), unless one of them is busy, and then nothing is released. The rules are in
//! specs/fork-rust-agent-parity.md "Upstream 3.18.0 gaps (wave 2)", A3.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use rust_cli_kernel_api::env_files::PathStyle;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command, EndReason};
use rust_cli_protocol_core::rpc::RpcError;
use rust_cli_protocol_core::sessions::Bridged;
use serde_json::{Value, json};

use crate::commands::send;
use crate::live::Live;
use crate::server::Server;

/// Ids of the lease commands: the kernel ignores a command id it has seen, so every lease gets fresh ones.
static LEASES: AtomicU64 = AtomicU64::new(0);

pub(crate) async fn release(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let directory = directory(params)?;
    let style = PathStyle::infer(&directory);
    let mut matched: Vec<(String, Arc<Bridged<Live>>)> = server
        .bridge
        .sessions()
        .into_iter()
        .filter(|open| style.is_within(&open.sink.cwd(), &directory))
        .map(|open| (open.handle.id().as_str().to_owned(), open))
        .collect();
    matched.sort_by(|left, right| left.0.cmp(&right.0));
    // Node checks the busy facts and starts the unload with no await in between. Here the owners answer: each actor
    // takes the release lease only when it is idle by its own state, and while it holds the lease it refuses every
    // command and starts no turn, so nothing admitted after the check reaches a session that is about to close.
    let lease = LEASES.fetch_add(1, Ordering::Relaxed);
    let mut busy = Vec::new();
    let mut leased = Vec::with_capacity(matched.len());
    for (id, open) in matched {
        let take = send(
            open.handle.as_ref(),
            &format!("release-lease:{lease}:take"),
            Command::ReserveRelease { reserved: true },
        )
        .await;
        if matches!(take, KernelAck::Accepted { .. }) {
            leased.push((id, open));
        } else {
            busy.push(id);
        }
    }
    // With the lease held no new background work or submission can start: the kernel's registry and the protocol's
    // own preparation give the rest of Node's busy facts.
    for (id, open) in &leased {
        let background = open
            .handle
            .background_tasks()
            .await
            .map_or(true, |works| !works.is_empty());
        if background || open.sink.preparing() {
            busy.push(id.clone());
        }
    }
    if !busy.is_empty() {
        busy.sort();
        for (_, open) in &leased {
            // Returning the lease resumes the drain as a turn end would.
            send(
                open.handle.as_ref(),
                &format!("release-lease:{lease}:return"),
                Command::ReserveRelease { reserved: false },
            )
            .await;
        }
        return Ok(json!({"released": [], "busy": busy}));
    }
    let mut released = Vec::with_capacity(leased.len());
    for (id, open) in leased {
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
