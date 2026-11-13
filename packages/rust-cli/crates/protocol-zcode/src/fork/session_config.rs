//! Fork: session configuration commands the kernel already models: `renameSession`,
//! `switchModelConfig`, `switchCollaborationMode` and `compact` (Node
//! `commands/handlers/model-config.ts` and `session-mgmt.ts`; specs/fork-rust-agent-parity.md).

use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, COMPACT_LOCKED, Command, Delivery, QueuedKind,
};
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;

use crate::commands::{ack_of, payload, send};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::projection::InputMeta;
use crate::projection::state::Phase;

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

/// The session's model, permission mode and plan switch as the session holds them. The projection learns of a switch
/// only when its event arrives, so a switch back sent before that would compare against the stale value and answer
/// `config.unchanged` while the session stays switched; the projection is the fallback when the actor cannot answer.
pub(crate) async fn held_config(live: &Bridged<Live>) -> (ModelSelection, PermissionMode, bool) {
    match live.handle.view().await {
        Ok(view) => (view.selection, view.mode, view.plan),
        Err(_) => live.sink.current_config(),
    }
}

/// The switch gate never closes; were it closed, the switch is refused rather than run unserialized.
fn switch_refused(envelope: &Envelope, revision: u64, reason: &str) -> Ack {
    Ack::refused(
        &envelope.command_id,
        Status::Rejected,
        "fault.command.inputRejected",
        reason.to_owned(),
        revision,
    )
}

/// Same rule as Node `switchModelConfig`: a different model switches model and reasoning; the same
/// model switches only an explicit, different reasoning level; anything else is `config.unchanged`.
pub(super) async fn switch_model(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let body: SwitchModelPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let _turn = match live.sink.config_switch().await {
        Ok(turn) => turn,
        Err(reason) => return switch_refused(envelope, revision, reason),
    };
    let (current, _, _) = held_config(live).await;
    apply_model(live, envelope, revision, &current, body).await
}

/// Node `setThoughtLevel`: the reasoning level of the session's current model, read once inside the switch turn, so a
/// concurrent model switch is neither reverted nor compared against a second read.
pub(crate) async fn switch_thought(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
    thought: &str,
) -> Ack {
    let _turn = match live.sink.config_switch().await {
        Ok(turn) => turn,
        Err(reason) => return switch_refused(envelope, revision, reason),
    };
    let (current, _, _) = held_config(live).await;
    let body = SwitchModelPayload {
        provider: current.provider.clone(),
        model: current.model.clone(),
        thought: thought.to_owned(),
    };
    apply_model(live, envelope, revision, &current, body).await
}

/// The `switchModelConfig` decision against the config held when the switch turn started.
async fn apply_model(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
    current: &ModelSelection,
    body: SwitchModelPayload,
) -> Ack {
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

/// Node `setMode`: `plan` opens plan (the permission mode is kept); every other mode sets the
/// permission mode and closes plan. The plan switch alone travels with the input (`sendText`'s
/// `planEnabled`, `independentPlanState`).
pub(super) async fn switch_mode(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let body: SwitchModePayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let handle = live.handle.as_ref();
    let _turn = match live.sink.config_switch().await {
        Ok(turn) => turn,
        Err(reason) => return switch_refused(envelope, revision, reason),
    };
    let (_, current_mode, plan) = held_config(live).await;
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
/// Node `compact`: idle it starts at once; behind a running turn it is a queued maintenance item
/// (`kind: compact`, not a user row) that drains in order. A compaction that runs or is queued
/// already refuses another with `compactOperationLock`.
/// The `compact` payload (`SessionPane` `{ modelSelection }`).
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompactPayload {
    model_selection: Option<serde_json::Value>,
}

pub(super) async fn compact(
    live: &Bridged<Live>,
    envelope: &Envelope,
    phase: Phase,
    revision: u64,
) -> Ack {
    // Node `compact`: busy, or idle behind a held queue, the compaction joins the queue tail.
    let behind_held = !live.sink.auto_drain() && live.sink.has_queue();
    let admitted = if phase == Phase::Running || behind_held {
        "queue"
    } else {
        "startNow"
    };
    live.sink.remember_input(
        &envelope.command_id,
        InputMeta {
            client: envelope.client_id.clone(),
            origin: envelope.input_origin.clone(),
            text: "/compact".to_owned(),
            admitted_at: 0,
            requested: "queue",
            admitted,
            attachments: Vec::new(),
            automation: None,
        },
    );
    // The App pins the Composer selection on the compaction (`payload.modelSelection`); a queued
    // compaction keeps it frozen, so a later menu change does not move the summary's model.
    let pinned: CompactPayload = if envelope.payload.is_null() {
        CompactPayload::default()
    } else {
        match payload(envelope) {
            Ok(pinned) => pinned,
            Err(ack) => return *ack,
        }
    };
    let execution = match crate::commands::selection(pinned.model_selection.as_ref()) {
        Some(chosen) => {
            let (_, mode, plan) = live.sink.current_config();
            Some(rust_cli_kernel_api::session_api::InputExecution {
                state: rust_cli_kernel_api::permission::ExecutionState { mode, plan },
                selection: Some(chosen),
                limits: Default::default(),
                keeps_session_state: false,
            })
        }
        None => None,
    };
    let command = Command::SubmitWith {
        intent: None,
        kind: QueuedKind::Compact,
        text: "/compact".to_owned(),
        content: Vec::new(),
        delivery: Delivery::Queue,
        execution,
        behind_held: true,
        lease: None,
    };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    if let KernelAck::Rejected { reason } = &kernel
        && reason == COMPACT_LOCKED
    {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "compactOperationLock",
            reason.clone(),
            revision,
        );
    }
    kernel_ack(envelope, revision, "fault.command.inputRejected", kernel)
}
