//! Fork: session configuration commands the kernel already models: `renameSession`,
//! `switchModelConfig`, `switchCollaborationMode` and `compact` (Node
//! `commands/handlers/model-config.ts` and `session-mgmt.ts`; specs/fork-rust-agent-parity.md).

use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command};
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;

use crate::commands::{ack_of, payload, send};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;

/// Node's no-op reason for a switch to the value already in effect.
const CONFIG_UNCHANGED: &str = "config.unchanged";

#[derive(Deserialize)]
struct RenamePayload {
    title: String,
}

#[derive(Deserialize)]
struct SwitchModelPayload {
    provider: String,
    model: String,
    thought: String,
}

#[derive(Deserialize)]
struct SwitchModePayload {
    mode: String,
}

fn kernel_ack(envelope: &Envelope, revision: u64, code: &str, kernel: KernelAck) -> Ack {
    ack_of(
        kernel,
        Ack::accepted(&envelope.command_id, revision, None),
        |reason| {
            Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                code,
                reason,
                revision,
            )
        },
    )
}

fn unchanged(envelope: &Envelope, revision: u64) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Noop,
        CONFIG_UNCHANGED,
        "the value is already in effect",
        revision,
    )
}

pub(super) async fn rename(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let body: RenamePayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let title = body.title.trim().to_owned();
    if title.is_empty() {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            "the title is empty",
            revision,
        );
    }
    let kernel = send(
        live.handle.as_ref(),
        &envelope.command_id,
        Command::Rename { title },
    )
    .await;
    kernel_ack(envelope, revision, "proto.invalidPayload", kernel)
}

/// Same rule as Node `switchModelConfig`: a different model switches model and reasoning; the same
/// model switches only an explicit, different reasoning level; anything else is `config.unchanged`.
pub(super) async fn switch_model(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let body: SwitchModelPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let (current, _, _) = live.sink.current_config();
    let thought = body.thought.trim();
    let identity_changed = current.provider != body.provider || current.model != body.model;
    let thought_changed = !thought.is_empty() && current.reasoning.as_deref() != Some(thought);
    if !identity_changed && !thought_changed {
        return unchanged(envelope, revision);
    }
    let selection = ModelSelection {
        reasoning: (!thought.is_empty()).then(|| thought.to_owned()),
        ..ModelSelection::new(body.provider, body.model)
    };
    let command = Command::SetModel { selection };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    kernel_ack(envelope, revision, "fault.command.inputRejected", kernel)
}

/// Without independent plan state the App lists plan as one of the modes, so `plan` opens plan and
/// every other mode sets the permission mode and closes plan.
pub(super) async fn switch_mode(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let body: SwitchModePayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let handle = live.handle.as_ref();
    let (_, current_mode, plan) = live.sink.current_config();
    if body.mode == "plan" {
        if plan {
            return unchanged(envelope, revision);
        }
        let kernel = send(
            handle,
            &envelope.command_id,
            Command::SetPlan { enabled: true },
        )
        .await;
        return kernel_ack(envelope, revision, "fault.command.inputRejected", kernel);
    }
    let Some(mode) = PermissionMode::from_node_name(&body.mode) else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            format!("unknown mode {}", body.mode),
            revision,
        );
    };
    if mode == current_mode && !plan {
        return unchanged(envelope, revision);
    }
    if mode != current_mode {
        let kernel = send(handle, &envelope.command_id, Command::SetMode { mode }).await;
        let ack = kernel_ack(envelope, revision, "fault.command.inputRejected", kernel);
        if ack.status != Status::Accepted || !plan {
            return ack;
        }
    }
    let plan_command = format!("{}:plan", envelope.command_id);
    let kernel = send(handle, &plan_command, Command::SetPlan { enabled: false }).await;
    kernel_ack(envelope, revision, "fault.command.inputRejected", kernel)
}

/// `modelSelection` in the payload is not used: the kernel compacts with the session's model.
pub(super) async fn compact(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let command = Command::Compact { instructions: None };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    kernel_ack(envelope, revision, "fault.command.inputRejected", kernel)
}
