//! Fork: `setAssistantFeedback` and `setRowPinned` (Node `commands/handlers/assistant-feedback.ts` and `row-pin.ts`;
//! specs/fork-rust-feedback-and-pins.md). The row is resolved against the projection like Node's gateway does before
//! the handler, then one kernel command asks the session to commit the mark and report it as an event.

use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message_mark::{Feedback, MARK_STALE, MarkRequest};
use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command};
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;

use super::row_commands::target_refused;
use crate::commands::{payload, send};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::projection::{MarkKind, TargetMiss};

const EXECUTION_FAILED: &str = "fault.command.executionFailed";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    row_id: u64,
    entity_id: String,
}

#[derive(Debug, Deserialize)]
struct FeedbackPayload {
    target: Target,
    /// `like`, `dislike` or null (cleared); the inbound schema has refused any other value.
    feedback: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PinPayload {
    target: Target,
    pinned: bool,
}

pub(super) async fn set_feedback(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let body: FeedbackPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let feedback = match body.feedback.as_deref().map(Feedback::parse) {
        None => None,
        Some(Some(feedback)) => Some(feedback),
        Some(None) => {
            return Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                "proto.invalidPayload",
                "feedback must be like, dislike or null".to_owned(),
                revision,
            );
        }
    };
    mark(
        live,
        envelope,
        revision,
        (&body.target, MarkKind::Feedback),
        MarkRequest::Feedback(feedback),
    )
    .await
}

pub(super) async fn set_pinned(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let body: PinPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    mark(
        live,
        envelope,
        revision,
        (&body.target, MarkKind::Pin),
        MarkRequest::Pin(body.pinned),
    )
    .await
}

async fn mark(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
    (target, kind): (&Target, MarkKind),
    request: MarkRequest,
) -> Ack {
    let message = match live
        .sink
        .mark_target(target.row_id, &target.entity_id, kind)
    {
        Ok(message) => message,
        Err(miss) => {
            return target_refused(
                envelope,
                miss,
                format!("row {} cannot take this mark", target.row_id),
                revision,
            );
        }
    };
    let command = Command::MarkMessage {
        message: MessageId::new(message),
        request,
    };
    match send(live.handle.as_ref(), &envelope.command_id, command).await {
        KernelAck::Accepted { .. } => Ack::accepted(&envelope.command_id, revision, None),
        KernelAck::Duplicate => {
            crate::inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None))
        }
        // The message left the history between the projection and the session (a rewind): the row is stale.
        KernelAck::Rejected { reason } if reason == MARK_STALE => target_refused(
            envelope,
            TargetMiss::Stale,
            format!("row {} is no longer in the history", target.row_id),
            revision,
        ),
        KernelAck::Rejected { reason } => Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            EXECUTION_FAILED,
            reason,
            revision,
        ),
    }
}

#[cfg(test)]
#[path = "message_marks_tests.rs"]
mod tests;
