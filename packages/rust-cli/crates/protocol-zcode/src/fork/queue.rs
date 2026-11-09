//! Fork: the queue panel commands `deleteQueueItem`, `editQueueItem`, `reorderQueueItem`,
//! `setAutoDrain` and `sendQueuedNow` (Node `commands/handlers/queue.ts`; specs/fork-rust-agent-parity.md).
//! The App addresses queue items as `queue_<sourceCommandId>` (projection `queue_state`); the kernel
//! addresses queued inputs by that source command id and owns them in one place (the session actor's
//! inbox), so every kind maps to one kernel command and the queue projection follows `QueueChanged`.

use futures_util::StreamExt;
use rust_cli_kernel_api::goal::{GoalPhase, VerificationStatus};
use rust_cli_kernel_api::ids::CommandId;
use rust_cli_kernel_api::session_api::{Ack as KernelAck, Command, Delivery, KernelEvent};
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;
use serde_json::Value;

use crate::commands::{ack_of, payload, send};
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::projection::InputMeta;

/// Node `deleteQueueItem` throws `V4CommandNoopError("queue.itemMissing")` when the item already
/// drained or was deleted, so the client does not restore a consumed item into the composer.
const ITEM_MISSING: &str = "queue.itemMissing";
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
    new_text: String,
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

/// `deleteQueueItem` → kernel `Dequeue`. A miss is Node's `queue.itemMissing` noop, not a failure.
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
        |reason| {
            Ack::refused(
                &envelope.command_id,
                Status::Noop,
                ITEM_MISSING,
                reason,
                revision,
            )
        },
    )
}

/// `editQueueItem` → kernel `EditQueued`: the text is replaced in place, the position kept. Node's
/// `guard.queueItemNotEditable` (compact entries) has no counterpart: this agent's queue only holds
/// typed inputs.
pub(super) async fn edit_queue_item(
    live: &Bridged<Live>,
    envelope: &Envelope,
    revision: u64,
) -> Ack {
    let body: EditPayload = match payload(envelope) {
        Ok(body) => body,
        Err(ack) => return *ack,
    };
    let command = Command::EditQueued {
        command: CommandId::new(source_of(&body.queue_item_id)),
        text: body.new_text,
    };
    let kernel = send(live.handle.as_ref(), &envelope.command_id, command).await;
    match kernel {
        KernelAck::Accepted { .. } => Ack::accepted(&envelope.command_id, revision, None),
        KernelAck::Duplicate => {
            crate::inbox::duplicate(&Ack::accepted(&envelope.command_id, revision, None))
        }
        KernelAck::Rejected { reason } => accepted_despite_miss(envelope, revision, &reason),
    }
}

/// `reorderQueueItem` → kernel `ReorderQueued`: before another queued item, or to the end when the
/// anchor is null. A miss is accepted with a warn, exactly like Node.
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
async fn settle_running_turn(live: &Bridged<Live>, envelope: &Envelope) -> Result<(), String> {
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
/// Not ported: Node's reservation (`guard.queueItemReserved`) — the kernel has a single queue owner
/// and no competing promotions; queued attachments — a promoted item restarts without them.
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
    let part = |suffix: &str| format!("{}:{suffix}", envelope.command_id);
    // The release restores the user's own hold (`setAutoDrain: false`) instead of clearing it.
    let user_held = !live.sink.auto_drain();
    let release = || Command::HoldQueue { held: user_held };
    // The promotion lease: while the window is open the drain cannot start another queued item.
    send(handle, &part("hold"), Command::HoldQueue { held: true }).await;
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
    if let KernelAck::Rejected { reason } = taken {
        send(handle, &part("resume"), release()).await;
        return failed(PROMOTION_COMMIT_FAILED, reason);
    }
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
            attachments: Vec::new(),
        },
    );
    let submitted = send(
        handle,
        &part("send"),
        Command::SubmitWith {
            kind: item.kind,
            text: item.text,
            content: Vec::new(),
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
    // Release the promotion hold: with the promoted turn running it only clears the flag; if the turn
    // could not start, the release lets the queue drain again as a turn end would.
    send(handle, &part("resume"), release()).await;
    ack
}
