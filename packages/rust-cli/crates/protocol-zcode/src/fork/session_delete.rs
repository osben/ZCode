//! Fork: `deleteSession` (Node `commands/handlers/session-mgmt.ts` `deleteSession` plus the
//! v4-bridge execution face: soft-delete the session, then release the running instance and notify
//! the sessions index with `session.removed`). The payload is an empty object (`deleteSession:
//! z.object({})`) and Node returns no command result, so the accepted ACK carries none either.
//!
//! Node's order is "persist the soft delete first, close the runtime second"; the kernel owns the
//! inverse rule here (`Kernel::delete_session` refuses while the session's actor is open), so this
//! port closes first and soft-deletes second. That is the recoverable failure order: a failed
//! delete after a close leaves a closed-but-listed session the user can delete again, never a
//! deleted session with an actor still committing into it.

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::EndReason;
use rust_cli_protocol_core::sessions::Bridged;
use serde_json::Value;

use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::projection::state::Phase;
use crate::server::Server;

/// Node answers a failed `deleteSession` execution with this (any throw without a domain reason
/// code maps to it in the gateway's command error handling), so the running-turn refusal and
/// kernel errors share it.
const EXECUTION_FAILED: &str = "fault.command.executionFailed";

pub(super) async fn delete(
    server: &Server,
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let Some(session) = envelope.session_id.as_deref() else {
        // The dispatcher already refuses a missing session id; kept defensive, same code as it.
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.sessionRequired",
            "this command needs a sessionId",
            0,
        );
    };
    // Checked before any side effect: a running turn's actor would keep committing after the
    // delete, and the kernel refuses to delete an open session anyway. Node surfaces delete
    // failures as `fault.command.executionFailed`, so the refusal uses the same code.
    if live.sink.status().0 == Phase::Running {
        return Ack::refused(
            &envelope.command_id,
            Status::Failed,
            EXECUTION_FAILED,
            "a turn is running in this session",
            revision,
        );
    }
    let id = SessionId::new(session);
    // Read the row's workspace before anything closes: the sessions-index topic is keyed by it.
    let workspace = live
        .sink
        .summary()
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    // Stop forwarding this session's events (Node's equivalent tears the projection down the same
    // way around `closeSessionRuntime(context, sessionId, /* deleted */ true)`).
    server.bridge.close(&id);
    // End the kernel-side actor (SessionEnd hooks, per-session tables); without this the kernel
    // keeps the session open and refuses the delete. The hook notes are user-facing strings and
    // are neither logged nor answered, like Node's `app.close()` result here.
    live.handle.close(EndReason::Other).await;
    if let Err(error) = server.kernel.delete_session(&id).await {
        tracing::warn!(event = "protocol.session.delete_failed", error = %error, "deleting the session failed");
        return Ack::refused(
            &envelope.command_id,
            Status::Failed,
            EXECUTION_FAILED,
            error.to_string(),
            revision,
        );
    }
    // The list row goes away the way Node removes it (`session.removed`).
    server.topics.remove(&workspace, session);
    // Protocol-owned preference for this id; a later session with the same id starts default.
    server.followups.lock_unpoisoned().remove(&id);
    tracing::info!(
        event = "protocol.session.deleted",
        session,
        "the session was deleted"
    );
    Ack::accepted(&envelope.command_id, revision, None)
}

#[cfg(test)]
#[path = "session_delete_tests.rs"]
mod tests;
