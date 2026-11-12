//! Fork: the queue panel commands `deleteQueueItem`, `editQueueItem`, `reorderQueueItem`,
//! `setAutoDrain` and `sendQueuedNow` (Node `commands/handlers/queue.ts`; specs/fork-rust-agent-parity.md).
//! The App addresses queue items as `queue_<sourceCommandId>` (projection `queue_state`); the kernel
//! addresses queued inputs by that source command id and owns them in one place (the session actor's
//! inbox), so every kind maps to one kernel command and the queue projection follows `QueueChanged`.

use futures_util::StreamExt;
use rust_cli_kernel_api::goal::{GoalPhase, VerificationStatus};
use rust_cli_kernel_api::ids::CommandId;
use rust_cli_kernel_api::session_api::{
    Ack as KernelAck, Command, CommandResult, Delivery, KernelEvent, QUEUE_EDIT_LOCK_LOST,
    QUEUE_EDIT_LOCK_MISSING, QUEUE_ITEM_EDIT_LOCKED, QUEUE_ITEM_MISSING, QUEUE_ITEM_NOT_EDITABLE,
    QueueEditLock, QueuedAttachments, QueuedEdit,
};
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;
use serde_json::Value;

use crate::commands::{ack_of, payload, send};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::projection::InputMeta;
use crate::server::Server;

/// Node `V4QueueItemTextUnavailableError` carries no domain reason code, so the gateway settles it as
/// the generic execution failure.
const ITEM_UNAVAILABLE: &str = "fault.command.executionFailed";
/// Node `V4QueuePromotionCommitError`: the promotion started but the queue item could not be removed.
const PROMOTION_COMMIT_FAILED: &str = "fault.command.queuePromotionCommitFailed";
/// Node `V4QueueItemReservedError`: another `sendQueuedNow` is already promoting this item.
const ITEM_RESERVED: &str = "guard.queueItemReserved";
/// Node `V4QueuePromotionLeaseUnavailableError`: the foreground is not available for the promotion.
const PROMOTION_BUSY: &str = "guard.queuePromotionBusy";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemPayload {
    queue_item_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditPayload {
    queue_item_id: String,
    /// Required by the schema for `editQueueItem`; absent for the config-only edits of `applyQueueItemsConfig`.
    #[serde(default)]
    new_text: Option<String>,
    #[serde(default)]
    editor_id: Option<String>,
    #[serde(default)]
    attachments: Option<Vec<Value>>,
    #[serde(default)]
    conversation_quotes: Option<Value>,
    #[serde(default)]
    model_selection: Option<Value>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    plan_enabled: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockPayload {
    queue_item_id: String,
    editor_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApplyConfigPayload {
    queue_item_ids: Vec<String>,
    #[serde(default)]
    model_selection: Option<Value>,
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderPayload {
    queue_item_id: String,
    before_queue_item_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoDrainPayload {
    auto_drain: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendNowPayload {
    queue_item_id: String,
    #[serde(default)]
    model_selection: Option<Value>,
}

/// The App's queue item id `queue_<commandId>` → the kernel's source command id.
fn source_of(queue_item_id: &str) -> &str {
    queue_item_id
        .strip_prefix("queue_")
        .unwrap_or(queue_item_id)
}

/// A kernel rejection of a queue edit: Node logs a miss and still acks accepted (the item drained
/// between render and edit), so the refusal is swallowed into the accepted ack.
fn accepted_despite_miss(envelope: &Envelope, revision: u64, reason: &str) -> Ack {
    tracing::warn!(
        event = "protocol.queue.item_missed",
        reason = %reason,
        "the queue item is no longer queued"
    );
    Ack::accepted(&envelope.command_id, revision, None)
}

/// A kernel refusal of a queue command, as the App's code: the lock and compaction guards are rejections, a
/// missing item (or a stale release) is a noop (Node `V4CommandNoopError`). Other reasons are misses too.
fn queue_refusal(envelope: &Envelope, revision: u64, reason: &str) -> Ack {
    let (status, code) = match reason {
        QUEUE_ITEM_EDIT_LOCKED | QUEUE_EDIT_LOCK_LOST | QUEUE_ITEM_NOT_EDITABLE => {
            (Status::Rejected, reason)
        }
        QUEUE_EDIT_LOCK_MISSING => (Status::Noop, QUEUE_EDIT_LOCK_MISSING),
        _ => (Status::Noop, QUEUE_ITEM_MISSING),
    };
    Ack::refused(&envelope.command_id, status, code, reason, revision)
}

/// `deleteQueueItem` → kernel `Dequeue`. A miss is Node's `queue.itemMissing` noop, not a failure; a composer
/// edit lock refuses the removal (`guard.queueItemEditLocked`).
pub(super) async fn delete_queue_item(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: ItemPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let command = Command::Dequeue {
        command: CommandId::new(source_of(&body.queue_item_id)),
    };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    ack_of(
        kernel,
        Ack::accepted(&envelope.command_id, revision, None),
        |reason| queue_refusal(envelope, revision, &reason),
    )
}

/// `editQueueItem` → kernel `EditQueued`: the item is edited in place, its position kept. The body's fields the App
/// did not send keep their values (Node: `newText` is the text; `attachments` replaces the refs, `[]` clears them).
/// The refs are resolved into content blocks before the kernel sees the edit (Node maps them before the write-back), so
/// a ref that cannot be resolved refuses the edit and changes nothing; the chips (the protocol's input metadata) follow
/// once the kernel accepted it. Node's `guard.queueItemNotEditable` is the kernel's refusal of a compaction.
pub(super) async fn edit_queue_item(
    server: &Server,
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: EditPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let source = source_of(&body.queue_item_id);
    let attachments = match &body.attachments {
        None => None,
        Some(refs) => match queued_attachments(server, live, envelope, refs, revision).await {
            Ok(attachments) => Some(attachments),
            Err(ack) => return *ack,
        },
    };
    let command = Command::EditQueued {
        command: CommandId::new(source),
        edit: QueuedEdit {
            editor_id: body.editor_id.clone(),
            text: body.new_text.clone(),
            conversation_quotes: body.conversation_quotes.clone(),
            model_selection: crate::commands::selection(body.model_selection.as_ref()),
            intent_model_selection: body
                .model_selection
                .clone()
                .filter(|value| !value.is_null()),
            mode: body.mode.clone(),
            plan_enabled: body.plan_enabled,
            attachments,
        },
    };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    match kernel {
        KernelAck::Accepted { .. } => {
            if let Some(attachments) = body.attachments {
                live.sink.set_queued_attachments(source, attachments).await;
            }
            Ack::accepted(&envelope.command_id, revision, None)
        }
        KernelAck::Duplicate => {
            crate::inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None))
        }
        KernelAck::Rejected { reason } => queue_refusal(envelope, revision, &reason),
    }
}

/// The edit's attachments as the kernel queues them: the refs as sent, and their content blocks without the typed text
/// (the queue owns the text). The refusals are `sendText`'s: a ref that does not match the schema is invalid, material
/// that cannot be written fails.
async fn queued_attachments(
    server: &Server,
    live: &Bridged<Live>,
    envelope: &Envelope,
    refs: &[Value],
    revision: u64,
) -> Result<QueuedAttachments, Box<Ack>> {
    let parsed = crate::attachments::parse_refs(refs).map_err(|error| {
        Box::new(Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            "proto.invalidPayload",
            error.message,
            revision,
        ))
    })?;
    let content = if parsed.is_empty() {
        Vec::new()
    } else {
        crate::attachments::content(server, live.handle.id(), "", parsed)
            .await
            .map_err(|error| {
                Box::new(Ack::refused(
                    &envelope.command_id,
                    Status::Failed,
                    &error.message,
                    error.message.clone(),
                    revision,
                ))
            })?
    };
    Ok(QueuedAttachments {
        refs: Value::Array(refs.to_vec()),
        content,
    })
}

/// `lockQueueItemEdit` → kernel `LockQueuedEdit` (Node `lockQueueItemEdit`). The protocol holds the item's promotion
/// reservation for the command, so a lock and a `sendQueuedNow` of one item never overlap (Node
/// `pendingInputReservations` vs `pendingInputEditLocks`); the lock itself is the inbox's.
pub(super) async fn lock_queue_item_edit(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: LockPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let source = source_of(&body.queue_item_id);
    let Some(_reservation) = live.sink.reserve_promotion(source) else {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            ITEM_RESERVED,
            ITEM_RESERVED,
            revision,
        );
    };
    let command = Command::LockQueuedEdit {
        command: CommandId::new(source),
        lock: QueueEditLock {
            editor_id: body.editor_id,
            client_id: envelope.client_id.clone(),
            input_origin: envelope.input_origin.clone(),
        },
    };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    match kernel {
        KernelAck::Accepted { .. } => Ack::accepted(&envelope.command_id, revision, None),
        KernelAck::Duplicate => {
            crate::inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None))
        }
        KernelAck::Rejected { reason } => queue_refusal(envelope, revision, &reason),
    }
}

/// `releaseQueueItemEdit` → kernel `ReleaseQueuedEdit`: no lock is the noop `queue.editLockMissing`.
pub(super) async fn release_queue_item_edit(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: ItemPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let command = Command::ReleaseQueuedEdit {
        command: CommandId::new(source_of(&body.queue_item_id)),
    };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    ack_of(
        kernel,
        Ack::accepted(&envelope.command_id, revision, None),
        |reason| queue_refusal(envelope, revision, &reason),
    )
}

/// `applyQueueItemsConfig` → kernel `ApplyQueuedConfig` (Node `applyQueueItemsConfig`). Items that a promotion
/// holds (Node: not `queued`) are skipped here through their reservation; the kernel skips the missing, compact and
/// locked ones. Nothing applied is the noop `queue.itemMissing`.
pub(super) async fn apply_queue_items_config(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: ApplyConfigPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let mut commands = Vec::new();
    let mut held = Vec::new();
    for id in &body.queue_item_ids {
        let source = source_of(id);
        if let Some(reservation) = live.sink.reserve_promotion(source) {
            held.push(reservation);
            commands.push(CommandId::new(source));
        }
    }
    if commands.is_empty() {
        return queue_refusal(envelope, revision, QUEUE_ITEM_MISSING);
    }
    let command = Command::ApplyQueuedConfig {
        commands,
        edit: QueuedEdit {
            model_selection: crate::commands::selection(body.model_selection.as_ref()),
            intent_model_selection: body.model_selection.filter(|value| !value.is_null()),
            mode: body.mode,
            ..QueuedEdit::default()
        },
    };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    drop(held);
    match kernel {
        KernelAck::Accepted { .. } => Ack::accepted(&envelope.command_id, revision, None),
        KernelAck::Duplicate => {
            crate::inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None))
        }
        KernelAck::Rejected { reason } => queue_refusal(envelope, revision, &reason),
    }
}

/// `reorderQueueItem` → kernel `ReorderQueued`: before another queued item, or to the end when the
/// anchor is null. A miss is accepted with a warn, exactly like Node; a locked item is refused.
pub(super) async fn reorder_queue_item(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: ReorderPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let before = body
        .before_queue_item_id
        .as_deref()
        .map(|id| CommandId::new(source_of(id)));
    let command = Command::ReorderQueued {
        command: CommandId::new(source_of(&body.queue_item_id)),
        before,
    };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    match kernel {
        KernelAck::Accepted { .. } => Ack::accepted(&envelope.command_id, revision, None),
        KernelAck::Duplicate => {
            crate::inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None))
        }
        KernelAck::Rejected { reason } if reason == QUEUE_ITEM_EDIT_LOCKED => {
            queue_refusal(envelope, revision, &reason)
        }
        KernelAck::Rejected { reason } => accepted_despite_miss(envelope, revision, &reason),
    }
}

/// `setAutoDrain` → kernel `HoldQueue` (`held` is `!autoDrain`). Releasing while idle starts the head
/// of the queue in the actor, standing in for Node's ready-hook promotion on
/// `queue_auto_drain_resumed`. Node always acks accepted; so does the kernel flag.
pub(super) async fn set_auto_drain(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: AutoDrainPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let command = Command::HoldQueue {
        held: !body.auto_drain,
    };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    if matches!(kernel, KernelAck::Accepted { .. }) {
        live.sink.set_auto_drain(body.auto_drain).await;
    }
    ack_of(
        kernel,
        Ack::accepted(&envelope.command_id, revision, None),
        |reason| {
            Ack::refused(
                &envelope.command_id,
                Status::Failed,
                ITEM_UNAVAILABLE,
                reason,
                revision,
            )
        },
    )
}

/// Node preempts the active turn before a promotion: interrupt it and wait for its `TurnFinished`
/// (the same settlement the row commands use for edit and retry).
pub(crate) async fn settle_running_turn(
    live: &Bridged<Live>,
    envelope: &Envelope,
) -> Result<(), String> {
    let view = live
        .handle
        .view()
        .await
        .map_err(|error| error.to_string())?;
    // A goal completion verification is foreground work too: Node preempts the verifier (specs/fork-rust-goal-verifier.md §1.8).
    let verifying = view
        .goal
        .as_ref()
        .is_some_and(|goal| goal.status == GoalPhase::Verifying);
    if !view.running && !verifying {
        return Ok(());
    }
    let mut events = live.handle.subscribe(Some(view.last_seq));
    let stop = format!("{}:stop", envelope.command_id);
    if let KernelAck::Rejected { reason } =
        send(live.handle.as_ref(), &stop, Command::Interrupt).await
    {
        return Err(reason);
    }
    while let Some(event) = events.next().await {
        match &event.event {
            KernelEvent::TurnFinished { .. } => return Ok(()),
            KernelEvent::GoalVerification { verification, .. }
                if !view.running && verification.status != VerificationStatus::Started =>
            {
                return Ok(());
            }
            _ => {}
        }
    }
    Err("the session ended before the running turn stopped".to_owned())
}

/// `sendQueuedNow`: promote one queue item into a turn at once. Node's flow is reserve → foreground
/// promotion lease → preempt the active turn → start → remove; the kernel mapping is:
///
/// - read the queued text first — no item → Node's uncoded error (settled
///   `fault.command.executionFailed`);
/// - hold the queue for the window, standing in for the promotion lease so the drain after the
///   preempted turn cannot start another queued item first;
/// - `Interrupt` + wait `TurnFinished` when a turn is running (Node `preemptActiveTurnAndWait`);
/// - `Dequeue` the item — a miss here is Node's `fault.command.queuePromotionCommitFailed`;
/// - `Submit` the text; the session is idle, so the actor starts the turn at once, and a rejected
///   submit is Node's `guard.queuePromotionBusy`;
/// - restore the user's hold: with the promoted turn running, releasing only clears the flag and the
///   drain resumes at its end.
///
/// The promoted item keeps its kernel kind and frozen execution state (the body's
/// `modelSelection` overrides the frozen selection) and restarts under a fresh command id.
///
/// The promoted item keeps its attachments: the kernel's `Dequeue` hands back the queued content (Node passes the
/// item's attachments into the promoted turn), and the chips follow the intent's `attachmentRefs`.
pub(super) async fn send_queued_now(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: SendNowPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let handle = live.handle.as_ref();
    let source = source_of(&body.queue_item_id);
    let failed = |code: &str, message: String| {
        Ack::refused(
            &envelope.command_id,
            Status::Failed,
            code,
            message,
            revision,
        )
    };
    // Node `reserveQueueItem`: a second click on the same item is refused, so it cannot preempt the
    // turn the first promotion started or let the drain consume another item. Reserved before the read,
    // so a promotion that already finished has removed the item by then.
    let Some(_reservation) = live.sink.reserve_promotion(source) else {
        return failed(
            ITEM_RESERVED,
            format!(
                "v4 sendQueuedNow queue item already reserved: {}",
                body.queue_item_id
            ),
        );
    };
    // The full item is read up front (Node refuses a text-only fallback): no item, no promotion.
    let Some(item) = handle.view().await.ok().and_then(|view| {
        view.queue
            .into_iter()
            .find(|item| item.command.as_str() == source)
    }) else {
        return failed(
            ITEM_UNAVAILABLE,
            format!(
                "v4 sendQueuedNow queue item text unavailable: {}",
                body.queue_item_id
            ),
        );
    };
    // Node `sendQueuedNow` refuses a locked item (`guard.queueItemEditLocked`); the lock is read from the same view
    // as the item, and the reservation above keeps a lock from being taken while the promotion runs.
    if item.edit_lock.is_some() {
        return Ack::refused(
            &envelope.command_id,
            Status::Rejected,
            QUEUE_ITEM_EDIT_LOCKED,
            QUEUE_ITEM_EDIT_LOCKED,
            revision,
        );
    }
    let part = |suffix: &str| format!("{}:{suffix}", envelope.command_id);
    let release = || Command::ReserveForeground { reserved: false };
    // The promotion lease: while the window is open neither another queued item nor a background notice can start
    // (Node `dequeueNextRunnableBatch` returns only the promoted command). The user's own hold stays as it is.
    send(
        handle,
        &part("reserve"),
        Command::ReserveForeground { reserved: true },
    )
    .await;
    if let Err(reason) = settle_running_turn(live, envelope).await {
        send(handle, &part("resume"), release()).await;
        return failed(ITEM_UNAVAILABLE, reason);
    }
    // Removed only when the promotion is about to start, like Node's promotion commit.
    let taken = send(
        handle,
        &part("take"),
        Command::Dequeue {
            command: CommandId::new(source),
        },
    )
    .await;
    let content = match taken {
        KernelAck::Rejected { reason } => {
            send(handle, &part("resume"), release()).await;
            return failed(PROMOTION_COMMIT_FAILED, reason);
        }
        KernelAck::Accepted {
            result: CommandResult::Dequeued { content },
        } => content,
        KernelAck::Accepted { .. } | KernelAck::Duplicate => Vec::new(),
    };
    let chips = item
        .intent
        .as_ref()
        .and_then(|intent| intent.get(rust_cli_kernel_api::input_intent::ATTACHMENT_REFS))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // The item starts with its own frozen execution state; a selection the client re-sent with the
    // promotion overrides the item's model, like the row commands' resubmit.
    let mut execution = item.execution.clone();
    if let Some(chosen) = crate::commands::selection(body.model_selection.as_ref()) {
        let state = execution.as_ref().map_or_else(
            || {
                let (_, mode, plan) = live.sink.current_config();
                rust_cli_kernel_api::permission::ExecutionState { mode, plan }
            },
            |execution| execution.state,
        );
        execution = Some(rust_cli_kernel_api::session_api::InputExecution {
            state,
            selection: Some(chosen),
        });
    }
    live.sink.remember_input(
        &part("send"),
        InputMeta {
            client: envelope.client_id.clone(),
            origin: envelope.input_origin.clone(),
            text: item.text.clone(),
            admitted_at: 0,
            requested: "queue",
            admitted: "startNow",
            attachments: chips,
        },
    );
    let submitted = send(
        handle,
        &part("send"),
        Command::SubmitWith {
            // Node `inputIntentMetadataFromQueueItem`: the item's intent unchanged.
            intent: item.intent,
            kind: item.kind,
            text: item.text,
            content,
            delivery: Delivery::Queue,
            execution,
            behind_held: false,
        },
    )
    .await;
    let ack = match submitted {
        KernelAck::Accepted { .. } | KernelAck::Duplicate => {
            Ack::accepted(&envelope.command_id, revision, None)
        }
        KernelAck::Rejected { reason } => failed(PROMOTION_BUSY, reason),
    };
    // Release the promotion lease: with the promoted turn running it only clears the flag; if the turn
    // could not start, the release lets the queue drain again as a turn end would.
    send(handle, &part("resume"), release()).await;
    ack
}

#[cfg(test)]
#[path = "queue_tests.rs"]
mod tests;
