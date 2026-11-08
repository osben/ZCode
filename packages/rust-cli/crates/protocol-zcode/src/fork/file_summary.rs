//! Fork: the App's per-turn file summary surface (Node `V4Gateway.fileChanges` /
//! `fileRewindPreview` and the `applyFileRewind` command; specs/fork-rust-agent-parity.md).
//!
//! Both queries are stale-read guarded like Node's `resolveQueryRowTarget`: the caller's
//! `baseLogEpoch` / `baseRevision` must match the live conversation, and the row must resolve to
//! the turn header that offers the action. The command restores only that turn's checkpoints
//! (kernel `RewindTurnFiles`); the conversation is not cut and the turn header flips to
//! `reverted` when the events arrive.

use std::sync::Arc;

use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command, CommandResult, TurnFileChanges};
use rust_cli_protocol_core::rpc::RpcError;
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::commands::{payload, send};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::projection::RowAction;
use crate::server::{Server, kernel_error};

const EXECUTION_FAILED: &str = "fault.command.executionFailed";

/// `{rowId, entityId}` (conversationRowTargetSchema).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    row_id: u64,
    entity_id: String,
}

/// `{sessionId, target, baseRevision, baseLogEpoch}` (the two queries' params schema).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    #[serde(default)]
    session_id: String,
    target: Target,
    base_revision: u64,
    base_log_epoch: String,
}

#[derive(Deserialize)]
struct TargetPayload {
    target: Target,
}

/// A Node reason code carried as RPC error data (the codes the App matches on).
fn coded(code: &str, message: &str) -> RpcError {
    RpcError::internal(message).with_data(json!({"reasonCode": code}))
}

/// Node's `resolveQueryRowTarget`: the base must match the live conversation (`proto.stale*`),
/// then the row must resolve to a turn header offering the action (`guard.actionUnavailable`).
/// Returns the live session and the turn's typed user message (the kernel's per-turn anchor).
async fn resolve(
    server: &Server,
    params: &Params,
    action: RowAction,
) -> Result<(Arc<Bridged<Live>>, String), RpcError> {
    if params.session_id.is_empty() {
        return Err(RpcError::invalid_params("sessionId is required"));
    }
    let live = server
        .live(&SessionId::new(&params.session_id))
        .await
        .map_err(|error| kernel_error(&error))?;
    // The topic epoch and the projection revision at read time (Node's snapshot.logEpoch /
    // revision): the plans catalog is the existing reader of the epoch, the status pair of the
    // revision.
    let (_, revision) = live.sink.status();
    let epoch = live.sink.plans()["atLogEpoch"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if params.base_log_epoch != epoch {
        return Err(coded(
            "proto.staleLogEpoch",
            "proto.staleLogEpoch: the conversation log moved on",
        ));
    }
    if params.base_revision != revision {
        return Err(coded(
            "proto.staleRevision",
            "proto.staleRevision: the conversation changed",
        ));
    }
    let Some(target) = live
        .sink
        .row_target(params.target.row_id, &params.target.entity_id, action)
    else {
        return Err(coded(
            "guard.actionUnavailable",
            "guard.actionUnavailable: the row does not offer this action",
        ));
    };
    Ok((live, target.user_message))
}

/// `v4/conversation/fileChanges` (`v4ConversationFileChangesResultSchema`).
pub(crate) async fn file_changes(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let body: Params = serde_json::from_value(params.clone()).map_err(|error| {
        RpcError::invalid_params(format!("Invalid fileChanges params: {error}"))
    })?;
    let (live, turn) = resolve(server, &body, RowAction::FileChanges).await?;
    let changes = live
        .handle
        .turn_file_changes(&MessageId::new(&turn))
        .await
        .map_err(|error| kernel_error(&error))?;
    Ok(changes_json(&changes))
}

/// `v4/conversation/fileRewindPreview` (`v4ConversationFileRewindPreviewResultSchema`).
pub(crate) async fn file_rewind_preview(
    server: &Server,
    params: &Value,
) -> Result<Value, RpcError> {
    let body: Params = serde_json::from_value(params.clone()).map_err(|error| {
        RpcError::invalid_params(format!("Invalid fileRewindPreview params: {error}"))
    })?;
    let (live, turn) = resolve(server, &body, RowAction::FileRewind).await?;
    let preview = live
        .handle
        .turn_rewind_preview(&MessageId::new(&turn))
        .await
        .map_err(|error| kernel_error(&error))?;
    Ok(super::row_commands::preview_json(&preview))
}

/// Node's per-turn summary result: totals over the items, `state` from the turn's restore state.
fn changes_json(changes: &TurnFileChanges) -> Value {
    let additions: u64 = changes.items.iter().map(|item| item.additions).sum();
    let deletions: u64 = changes.items.iter().map(|item| item.deletions).sum();
    json!({
        "files": changes.items.len(),
        "additions": additions,
        "deletions": deletions,
        "state": if changes.reverted { "reverted" } else { "active" },
        "items": changes.items.iter().map(item_json).collect::<Vec<_>>(),
    })
}

fn item_json(item: &rust_cli_kernel_api::session_api::TurnFileItem) -> Value {
    json!({
        "path": item.path,
        "additions": item.additions,
        "deletions": item.deletions,
        "writeCount": item.write_count,
        "toolNames": item.tool_names,
        "patches": item.patches,
    })
}

/// Fork: the `applyFileRewind` command (Node `commands/handlers/file-rewind.ts`): restore only
/// the turn's checkpoints without cutting the conversation. Unsafe files, or nothing left to
/// restore, return an accepted result with `applied: false` and the preview, like Node — nothing
/// changes. The kernel's reply waits for the restore transaction, so the accepted result reports
/// what it actually restored.
pub(super) async fn apply(live: &Bridged<Live>, envelope: &Envelope, revision: u64) -> Ack {
    let body: TargetPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let Some(target) = live.sink.row_target(
        body.target.row_id,
        &body.target.entity_id,
        RowAction::FileRewind,
    ) else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "guard.actionUnavailable",
            format!("row {} does not offer the file rewind", body.target.row_id),
            revision,
        );
    };
    let turn = MessageId::new(&target.user_message);
    let preview = match live.handle.turn_rewind_preview(&turn).await {
        Ok(preview) => preview,
        Err(error) => {
            return Ack::refused(
                &envelope.command_id,
                Status::Failed,
                EXECUTION_FAILED,
                error.to_string(),
                revision,
            );
        }
    };
    // Node's `canApply`: unsafe files block, and there must be something to restore.
    if !preview.unsafe_files.is_empty() || preview.safe.is_empty() {
        return Ack::accepted(
            &envelope.command_id,
            revision,
            Some(json!({
                "type": "applyFileRewind",
                "applied": false,
                "preview": super::row_commands::preview_json(&preview),
                "response": "File rewind was not applied because at least one file is unsafe.",
            })),
        );
    }
    let command = Command::RewindTurnFiles { target: turn };
    let restored = match send(live.handle.as_ref(), &envelope.command_id, command).await {
        KernelAck::Accepted {
            result: CommandResult::Rewound { restored, .. },
        } => Some(restored),
        // A replay of an already-executed command: the same accepted result, counting the plan.
        KernelAck::Accepted { .. } | KernelAck::Duplicate => None,
        KernelAck::Rejected { reason } => {
            return Ack::refused(
                &envelope.command_id,
                Status::Rejected,
                EXECUTION_FAILED,
                reason,
                revision,
            );
        }
    };
    // Node counts the plan's safe files (`plan.safeFiles.length`); the kernel's receipt counts the
    // files it restored — the same set for the machines the App talks to.
    let files = restored.map_or_else(|| preview.safe.len(), |files| files.len());
    let response = format!(
        "Rewound {files} file{} from summary checkpoints.",
        if files == 1 { "" } else { "s" }
    );
    Ack::accepted(
        &envelope.command_id,
        revision,
        Some(json!({
            "type": "applyFileRewind",
            "applied": true,
            "preview": super::row_commands::preview_json(&preview),
            "response": response,
        })),
    )
}
