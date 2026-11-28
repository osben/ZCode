//! Fork: `discardSharedContext` (Node `commands/handlers/session-mgmt.ts` `discardSharedContext` and the bridge's
//! `discardSharedContext`; specs/fork-rust-imported-history.md, Shared context). The state owner is the store: the entry
//! of the context goes `pending` to `discarded` (the context message stays and never reaches the model).

use rust_cli_kernel_api::store::SharedContextTransition;
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;

use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::server::Server;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    context_id: String,
}

/// Node throws `V4InputAdmissionRejectedError("fault.command.inputRejected", "shared context is not pending")`, which the
/// gateway answers as a failed command.
fn not_pending(envelope: &Envelope, revision: u64) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Failed,
        "fault.command.inputRejected",
        "shared context is not pending",
        revision,
    )
}

pub(crate) async fn discard(
    server: &Server,
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let payload: Payload = match crate::commands::payload(envelope) {
        Ok(payload) => payload,
        Err(ack) => return *ack,
    };
    let moved = server
        .kernel
        .queries()
        .transition_shared_context(
            live.handle.id(),
            &SharedContextTransition {
                context_id: payload.context_id,
                expected: vec!["pending".to_owned()],
                status: "discarded".to_owned(),
                source_id: None,
            },
        )
        .await;
    match moved {
        Ok(true) => Ack::accepted(&envelope.command_id, revision, None),
        Ok(false) => not_pending(envelope, revision),
        Err(error) => {
            // No error text: a storage error can name the storage path.
            tracing::warn!(event = "protocol.shared_context.discard_failed", error = %error, "discarding the shared context failed");
            not_pending(envelope, revision)
        }
    }
}
