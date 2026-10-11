// Queue command group: deleteQueueItem / editQueueItem / reorderQueueItem / setAutoDrain /
// setFollowupMode / sendQueuedNow (native implementation; see session-flow.ts for the group template).
// Decision logic directly invokes core (the app-level queue API was migrated in batch 1). queueItemId ≡
// core pendingInputId (same ID space, no translation needed). Queue-change events originate in the
// core runtime and advance the v4 projection through gateway ingest, so this group needs no legacy broadcast hook.
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import { createModelExecutionContext } from "../../../zcode-protocol/model-execution.js";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromQueueItem } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import {
  applyGoalCommand,
  parseGoalObjectiveFromCommandText,
  startManualCompact,
  V4GoalCompactRejectedError,
} from "./goal-compact.js";
import { resolveSessionFallbackModelSelection } from "../input-admission.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { commandExecutionContextOf } from "../executor.js";
export { V4SessionIdleTimeoutError } from "./session-flow.js";

/** sendQueuedNow cannot find the item's source text in the projection (drained/deleted or invalid ID) -> reject. */
export class V4QueueItemTextUnavailableError extends Error {
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item text unavailable: ${queueItemId}`);
    this.name = "V4QueueItemTextUnavailableError";
  }
}

export class V4QueueItemReservedError extends Error {
  readonly reasonCode = "guard.queueItemReserved";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item already reserved: ${queueItemId}`);
    this.name = "V4QueueItemReservedError";
  }
}

export class V4QueuePromotionCommitError extends Error {
  readonly reasonCode = "fault.command.queuePromotionCommitFailed";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow started but failed to remove queue item: ${queueItemId}`);
    this.name = "V4QueuePromotionCommitError";
  }
}

export class V4QueueItemNotEditableError extends Error {
  readonly reasonCode = "guard.queueItemNotEditable";
  constructor(queueItemId: string) {
    super(`v4 queue item is not editable: ${queueItemId}`);
    this.name = "V4QueueItemNotEditableError";
  }
}

export class V4QueuePromotionLeaseUnavailableError extends Error {
  readonly reasonCode = "guard.queuePromotionBusy";
  constructor(activeLeaseId?: string) {
    super(
      activeLeaseId
        ? `v4 queue promotion is owned by another lease: ${activeLeaseId}`
        : "v4 queue promotion requires an idle Core runtime",
    );
    this.name = "V4QueuePromotionLeaseUnavailableError";
  }
}

async function deleteQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["deleteQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  // A miss caused by concurrent drain or duplicate deletion is a no-op, not a failure; keep a
  // warning for observability.
  const removed = await record.app.removeQueueItem(payload.queueItemId);
  if (!removed) {
    host.logger?.warn?.("v4 deleteQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
    // A miss previously returned undefined, which the gateway treated as accepted during a
    // concurrent drain or duplicate delete. Queue undo could then restore an already-consumed old
    // projection to the composer.
    throw new V4CommandNoopError("queue.itemMissing");
  }
  if (queueItem) {
    host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
  }
  return undefined;
}

async function editQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  if (queueItem?.kind === "compact") {
    // compact is a typed maintenance intent. Allowing its text to change would make it look like
    // ordinary input while commandKind remained compact, causing a compaction side effect that
    // does not match the UI copy when consumed.
    throw new V4QueueItemNotEditableError(payload.queueItemId);
  }
  // The core reducer updates the same id in place without changing its position. A miss is a
  // no-op plus a warning, matching delete's race semantics.
  const edited = await record.app.editQueueItem(payload.queueItemId, payload.newText);
  if (!edited) {
    host.logger?.warn?.("v4 editQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

async function reorderQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["reorderQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  // beforeQueueItemId = null moves the item to the end (the protocol matches the app API, so pass
  // it through).
  const moved = await record.app.reorderQueueItem(payload.queueItemId, payload.beforeQueueItemId);
  if (!moved) {
    host.logger?.warn?.("v4 reorderQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

async function setAutoDrain(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setAutoDrain"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setQueueAutoDrain(payload.autoDrain);
  if (payload.autoDrain) {
    // Toggling authorization alone is insufficient: an idle paused queue has no active turn to
    // start its head item. Reuse the CLI's authoritative ready hook; arm it while busy, and promote
    // atomically through sendQueuedNow when idle.
    await host.afterLegacyStateMutation?.(record, "queue_auto_drain_resumed");
  }
  return undefined;
}

async function setFollowupMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setFollowupMode"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setFollowupMode(payload.mode);
  return undefined;
}

/**
 * sendQueuedNow：reserve → Core promotion lease → stop barrier → start/promote → remove。
 * - Read the complete QueueItem; do not use the text-only fallback because it loses
 *   sourceCommandId, attachments, client, and order.
 * - Reuse session-flow stop semantics: cross the goal-pause barrier (otherwise the queue cannot
 *   drain before the verifier receives abort), then abort without awaiting.
 * - To wait for idle, wait for the background turn's finally block to release the lock (see item 3
 *   in prompt-turn's file header). Resending immediately after abort can hit "A prompt is already
 *   running", so poll until the lock is released.
 * - If any step fails before start, release the reservation and keep the item in place; remove it
 *   only after start succeeds.
 */
async function sendQueuedNow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendQueuedNow"];
  const record = requireRecord(host, envelope.sessionId);
  const reservationId = envelope.commandId;
  const autoDrainPromotion = commandExecutionContextOf(envelope)?.autoDrainPromotion === true;
  const foregroundPromotionLeaseId = `queue-promotion:${reservationId}`;
  const traceOptions = { traceContext: record.traceContext };
  let queueItemReserved = false;
  let startAdmitted = false;
  let leaseReleaseOwnedByBackground = false;
  let foregroundPromotionLeaseAcquired = false;
  try {
    const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
    if (queueItem === null) {
      throw new V4QueueItemTextUnavailableError(payload.queueItemId);
    }
    const acquirePromotionLease = (mode: "after-current" | "idle-only"): void => {
      const leaseResult = record.app.runtime.acquireForegroundPromotionLease({
        leaseId: foregroundPromotionLeaseId,
        mode,
        promotedInputId: queueItem.sourceCommandId,
      });
      if (leaseResult.kind !== "acquired") {
        throw new V4QueuePromotionLeaseUnavailableError(
          leaseResult.kind === "conflict" ? leaseResult.leaseId : undefined,
        );
      }
      foregroundPromotionLeaseAcquired = true;
    };
    if (autoDrainPromotion) acquirePromotionLease("idle-only");
    if (!(await record.app.reserveQueueItem(payload.queueItemId, reservationId, traceOptions))) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    queueItemReserved = true;
    const objective =
      queueItem.kind === "sendGoalCommand"
        ? parseGoalObjectiveFromCommandText(queueItem.text)
        : undefined;
    if (queueItem.kind === "sendGoalCommand" && !objective) {
      throw new V4GoalCompactRejectedError("emptyObjective", "Usage: /goal <objective>");
    }
    const attachments =
      queueItem.kind === "compact"
        ? undefined
        : await mapAttachmentRefsToTurnAttachments(record.app, queueItem.attachments);
    if (!autoDrainPromotion) acquirePromotionLease("after-current");
    let preempted = false;
    if (!autoDrainPromotion) {
      preempted = await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 sendQueuedNow preempts active turn",
        goalPausedMutationReason: "send_queued_now_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
      });
    }
    if (
      !(await record.app.markQueueItemPromoting(payload.queueItemId, reservationId, traceOptions))
    ) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    if (queueItem.kind === "compact") {
      await startManualCompact(host, record, queueItem.sourceCommandId, foregroundPromotionLeaseId);
      leaseReleaseOwnedByBackground = true;
    } else if (queueItem.kind === "sendGoalCommand") {
      const intent = inputIntentMetadataFromQueueItem(queueItem, objective ?? queueItem.text);
      const goalContinuationWillStart = !(
        intent.planEnabled ??
        record.app.runtime?.getPlanEnabled?.() ??
        record.app.getMode?.() === "plan"
      );
      await applyGoalCommand(host, record, {
        displayText: queueItem.text,
        foregroundPromotionLeaseId,
        inputId: queueItem.sourceCommandId,
        intent,
        objective: objective!,
      });
      leaseReleaseOwnedByBackground = goalContinuationWillStart;
    } else {
      const intent = inputIntentMetadataFromQueueItem(queueItem, queueItem.text);
      // Manual promotion lets the Renderer supply a fresh execution-material set for the same card;
      // a different card is always ignored to avoid swapping credentials across cards.
      const refreshedHighspeedMatchesQueue =
        payload.highspeedMeta !== undefined &&
        queueItem.highspeed !== undefined &&
        payload.highspeedMeta.cardId === queueItem.highspeed.cardId &&
        payload.highspeedMeta.taskId === queueItem.highspeed.taskId;
      if (refreshedHighspeedMatchesQueue && payload.highspeedMeta) {
        intent.highspeed = payload.highspeedMeta;
        // Selection and execution materials must be replaced as one batch (the protocol's
        // superRefine already guarantees they arrive as a pair).
        if (payload.modelSelection) intent.modelSelection = payload.modelSelection;
      }
      // Credentials never enter the queue's persisted surface: prefer the materials supplied with
      // this call, then the CLI's in-memory staging keyed by sourceCommandId.
      const stagedExecution =
        (refreshedHighspeedMatchesQueue ? payload.modelExecution : undefined) ??
        host.readQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
      const highspeedSelected = isHighspeedProviderId(intent.modelSelection?.providerId);
      // Rule 9: a card may expire while its item sits queued. Re-validate before promotion; an
      // expired card or missing credentials both fall back to the session model.
      const highspeedStillValid =
        highspeedSelected &&
        intent.highspeed !== undefined &&
        intent.highspeed.expiresAt > Date.now() &&
        stagedExecution !== undefined;
      if (highspeedSelected && !highspeedStillValid) {
        if (intent.highspeed && intent.highspeed.expiresAt > Date.now()) {
          // Bug cause: in the field, queued items holding a valid card silently fell back to the
          // normal model on manual promotion; the original log covered only provider-installation
          // failures and could not distinguish "missing staged credentials" from "card expired".
          host.logger?.warn?.("v4 queued Highspeed execution unavailable; using session model", {
            cardId: intent.highspeed.cardId,
            queueItemId: queueItem.queueItemId,
            reason: "execution_missing",
            sessionId: record.app.sessionId,
          });
        }
        // The fallback must rewrite Selection too: deleting only the card marker would leave this
        // turn on the accelerated provider with no credentials.
        // Reuse the same fallback resolver as retry/edit resends (spec §3 rule 13).
        delete intent.highspeed;
        intent.modelSelection = resolveSessionFallbackModelSelection(record);
        host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
      }
      const started = await startPromptTurn(host, record, {
        content: queueItem.text,
        inputId: queueItem.sourceCommandId,
        // A manual promotion that actually preempts an old execution is also a human steer;
        // automatic drain does not set this marker.
        ...(preempted && !attachments?.length ? { inputPresentation: "user_steer" as const } : {}),
        intent,
        requireIdle: true,
        toolDisallowlist: queueItem.toolDisallowlist,
        ...(highspeedStillValid && stagedExecution
          ? { modelExecution: createModelExecutionContext(stagedExecution) }
          : {}),
        ...(attachments ? { attachments } : {}),
      });
      // Older fake apps or compatibility commands may not return an admission receipt; the real
      // app already validates started at Core admission. Only explicit queued/rejected receipts
      // mean the promotion did not start.
      if (started.admission.kind === "queued" || started.admission.kind === "rejected") {
        throw new V4QueuePromotionLeaseUnavailableError();
      }
      // Credentials are frozen into Core with this turn; destroy the staged copy immediately after
      // a successful start, and keep it on failure paths so retries can still accelerate.
      host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
    }
    startAdmitted = true;
    const removed = await record.app.removeQueueItem(payload.queueItemId, {
      reason: "promoted",
      reservationId,
      ...traceOptions,
    });
    if (!removed) throw new V4QueuePromotionCommitError(payload.queueItemId);
    if (queueItem.kind === "compact") {
      // A no-op compact may finish before the promoting item is deleted. Its ready hook still sees
      // dispatch=promoting and cannot consume the next typed intent. Cross another mutation
      // boundary after deletion to close this race; a normally slow compact has an active
      // controller and will not drain twice.
      await host.afterLegacyStateMutation?.(record, "queue_compact_promoted");
    }
    return undefined;
  } finally {
    if (foregroundPromotionLeaseAcquired && !leaseReleaseOwnedByBackground) {
      record.app.runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    }
    // Once start is admitted, do not release the reservation: if remove fails, another side could
    // execute the item again. Keep it promoting for explicit resync/failure handling. A failure
    // before start can safely roll back to queued.
    if (queueItemReserved && !startAdmitted) {
      await record.app.releaseQueueItemReservation(
        payload.queueItemId,
        reservationId,
        traceOptions,
      );
    }
  }
}

export const queueHandlers = {
  deleteQueueItem,
  editQueueItem,
  reorderQueueItem,
  setAutoDrain,
  setFollowupMode,
  sendQueuedNow,
};
