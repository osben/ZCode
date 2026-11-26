//! Fork: the v4 command `createSelectionSideSession` (Node `commands/handlers/selection-side-session.ts`, the host's
//! `createSelectionSideSession` in `v4-bridge.ts`; specs/fork-rust-selection-side-chat.md).
//!
//! The parent session forks a `selection_side_chat` child through the kernel ([`Command::ForkSelectionSideChat`]); the
//! child opens like a forked session. A `firstInput` starts in the child only, as a `createSession` first input does:
//! the parent's queue, turn state and messages are never read or written here.

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command, CommandResult};
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;
use serde_json::json;

use crate::commands::{Input, payload, selection, send, submit_first};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::server::Server;

/// The `createSelectionSideSession` payload: `firstInput` is `{text, modelSelection?}` (the inbound schema checks it).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    first_input: Option<Input>,
}

pub(super) async fn create(
    server: &Server,
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: Payload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    // Node: the first input's model overrides the child's selection only; absent keeps the parent's current one (the
    // actor reads it, so the choice and the copied history come from the same moment).
    let chosen = body
        .first_input
        .as_ref()
        .and_then(|first| selection(first.model_selection.as_ref()));
    let command = Command::ForkSelectionSideChat { selection: chosen };
    let forked = match send(live.handle.as_ref(), &envelope.command_id, command).await {
        KernelAck::Accepted {
            result: CommandResult::Forked(forked),
        } => forked,
        KernelAck::Accepted { .. } | KernelAck::Duplicate => {
            return failed(envelope, "the side chat returned no session", revision);
        }
        KernelAck::Rejected { reason } => return failed(envelope, &reason, revision),
    };
    // Node `host.createSelectionSideSession`: the child keeps the parent's follow-up mode (mode, model and thought
    // level travel in the forked session's own state).
    let parent_followup = server
        .followups
        .lock_unpoisoned()
        .get(live.handle.id())
        .copied();
    if let Some(followup) = parent_followup {
        server
            .followups
            .lock_unpoisoned()
            .insert(forked.session.clone(), followup);
    }
    // The child is opened now, so it is registered before the App subscribes to it or its first input starts.
    let child = match server.live(&forked.session).await {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(event = "protocol.side_chat.open_failed", error = %error, "opening the side chat failed");
            return failed(envelope, "opening the side chat failed", revision);
        }
    };
    crate::subscribe::announce(&child);
    let mut result = json!({
        "type": "createSelectionSideSession",
        "sessionId": forked.session.as_str(),
    });
    if let Some(first) = body.first_input.as_ref() {
        match submit_first(server, &child, envelope, first, None).await {
            Ok(Some(input)) => result["input"] = input,
            Ok(None) => {}
            Err(ack) => return *ack,
        }
    }
    tracing::info!(
        event = "protocol.side_chat.created",
        copied = forked.copied,
        first_input = body.first_input.is_some(),
        "createSelectionSideSession completed"
    );
    Ack::accepted(&envelope.command_id, revision, Some(result))
}

/// Node throws from the handler and the gateway answers `failed` with the execution-failure code.
fn failed(envelope: &Envelope, message: &str, revision: u64) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Failed,
        "fault.command.executionFailed",
        message.to_owned(),
        revision,
    )
}
