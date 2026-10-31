import { normalizeGenUiInput } from "@zcode/core";
// Session-flow command group: sendText / stop (template pattern).
// One file per command group: handlers are pure functions (host, envelope) → CommandResult|undefined,
// decision logic drives core directly, environment capabilities go through host hooks (see the transition notes in ../types.ts).
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { createTurnCancelReason } from "@zcode/core";
import { isHighspeedProviderId } from "@zcode/shared";
import { createModelExecutionContext } from "../../../session-execution/index.js";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import {
  applyHeldQueueDisposition,
  hasPromptInput,
  holdFollowingQueue,
  isStopCancelInFlight,
  pauseActiveGoal,
  releaseFollowingQueue,
  resolveOrdinaryQueueModelSelection,
  resolveSubmittedExecutionState,
  V4InputAdmissionRejectedError,
} from "../input-admission.js";
import { inputIntentMetadata } from "../input-intent.js";
import {
  resolveTurnAutomationId,
  startPromptTurn,
  turnBackgroundAttributionOf,
  V4PromptRejectedError,
} from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import { V4CommandNoopError } from "../../v4-gateway.js";
import type { V4CommandCoreHost, V4SessionRecordView, V4TurnExecution } from "../types.js";

/** Wait-for-idle polling parameters: 25ms interval, 5s timeout. */
const IDLE_POLL_INTERVAL_MS = 25;
const IDLE_POLL_TIMEOUT_MS = 5_000;
const HIGHSPEED_QUEUE_FALLBACK_REASON = "highspeed.requiresQueue";

/** Wait-for-idle timeout (the active turn's finally did not release the lock within 5s) → give up retrying and error out. */
export class V4SessionIdleTimeoutError extends Error {
  constructor(sessionId: string) {
    super(`v4 timed out waiting for session idle: ${sessionId}`);
    this.name = "V4SessionIdleTimeoutError";
  }
}

/**
 * sendText: performs only protocol/held/model/attachment validation; start/queue is left to the
 * same session's Core admission. When held (choice), the heldQueueDisposition still decides.
 */
async function sendText(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const originalPayload = envelope.payload as CommandPayloadMap["sendText"];
  const rawPayload = {
    ...originalPayload,
    ...normalizeGenUiInput(originalPayload.text, originalPayload.genUiContext),
  };
  const record = requireRecord(host, envelope.sessionId);
  // Bug root cause: the old check looked only at the body, so an attachment-only query already allowed by the UI was misjudged as empty by the CLI.
  if (
    !hasPromptInput(rawPayload.text, rawPayload.attachments) &&
    !rawPayload.conversationQuotes?.length
  ) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  const activeAutomationId = resolveTurnAutomationId({
    automationId: rawPayload.automationId,
  });
  // Bug root cause: Highspeed admission and automation dispatch come from different upstreams;
  // contract drift could send automationId, highspeedMeta, and accelerated execution material to
  // the same round. The scheduled-execution identity must win: neither send requests with
  // accelerated-card credentials nor persist ordinary model output as Highspeed messages.
  const dropsHighspeed =
    activeAutomationId !== undefined &&
    (rawPayload.highspeedMeta !== undefined ||
      isHighspeedProviderId(rawPayload.modelSelection?.providerId));
  const payload: CommandPayloadMap["sendText"] = dropsHighspeed
    ? {
        ...rawPayload,
        highspeedMeta: undefined,
        modelSelection: undefined,
        modelExecution: undefined,
      }
    : rawPayload;
  // The canonical intent must see the same sanitized payload as admission, or the transcript keeps an accelerated marker with no credentials.
  const intentEnvelope = { ...envelope, payload } as CommandEnvelope;
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, payload.attachments);
  const submittedExecutionState = resolveSubmittedExecutionState(record, payload);
  const submissionIntent = (options: Parameters<typeof inputIntentMetadata>[1]) =>
    inputIntentMetadata(intentEnvelope, {
      ...options,
      ...submittedExecutionState,
      genUiContext: payload.genUiContext,
    });
  const routingMode = host.getInputRoutingMode?.(envelope.sessionId ?? "") ?? null;
  const forceStartNow = payload.requestedDelivery === "startNow";
  // An accelerated round is expressed as "standard Selection pointing at an accelerated provider
  // + one-shot execution material"; detection must use the Family predicate, not a comparison
  // against a single provider-id constant, or a BigModel account's card would be silently dropped as a normal round.
  const highspeedExecution: V4TurnExecution | undefined = isHighspeedProviderId(
    payload.modelSelection?.providerId,
  )
    ? payload.modelExecution
    : undefined;
  const highspeedActiveTurn = highspeedExecution
    ? record.app.runtime?.getActiveTurnInfo?.()
    : undefined;
  const highspeedRequiresQueue =
    !forceStartNow &&
    highspeedExecution !== undefined &&
    (record.activeAbortController !== undefined ||
      highspeedActiveTurn !== undefined ||
      routingMode === "enqueue" ||
      routingMode === "guide");

  const queueHighspeedTurn = async (): Promise<CommandResult | undefined> => {
    const highspeedSelection = payload.modelSelection;
    if (!highspeedExecution || !highspeedSelection) {
      throw new V4InputAdmissionRejectedError(
        "fault.command.inputRejected",
        "Highspeed queue requires turn execution material",
      );
    }
    const ordinarySelection = resolveOrdinaryQueueModelSelection(
      record,
      highspeedExecution.selectionFallback?.target,
    );
    const retainQueuedTurnExecution = host.retainQueuedTurnExecution;
    // Bug root cause: the queue once persisted a single-round Highspeed Selection into the
    // QueueItem; withdrawing the edit restored it to the Composer and polluted the next fallback.
    // The queue stores only the ordinary submitted model; the accelerated Selection and its
    // credentials must stay resident in CLI memory as one execution bundle.
    if (retainQueuedTurnExecution) {
      retainQueuedTurnExecution(record.app.sessionId, envelope.commandId, {
        modelSelection: highspeedSelection,
        modelExecution: highspeedExecution,
      });
    }
    try {
      const requestedDelivery = routingMode === "guide" ? "guide" : "queue";
      const intent = submissionIntent({
        text: payload.text,
        requestedDelivery,
        admittedDelivery: "queue",
        ...(routingMode === "guide" ? { fallbackReasonCode: HIGHSPEED_QUEUE_FALLBACK_REASON } : {}),
        attachmentRefs: payload.attachments,
      });
      intent.modelSelection = ordinarySelection;
      if (!retainQueuedTurnExecution) delete intent.highspeed;
      // Enqueueing matches canonical edit enqueueing and submits only the ordinary Selection:
      // Core writes the session's resident model with it; execution does not enter admission and
      // is applied only at the promotion boundary from the staged bundle.
      const queued = await startPromptTurn(host, record, {
        content: payload.text,
        ...(payload.browserAmbientContext
          ? { browserAmbientContext: payload.browserAmbientContext }
          : {}),
        inputId: envelope.commandId,
        intent,
        requireQueue: true,
        ...(attachments ? { attachments } : {}),
        toolDisallowlist: payload.toolDisallowlist,
      });
      if (queued.admission.kind !== "queued") {
        throw new V4InputAdmissionRejectedError(
          "fault.command.inputRejected",
          "Highspeed input was not admitted to the queue",
        );
      }
      return {
        type: "inputAccepted",
        delivery: "queue",
        inputId: envelope.commandId,
      };
    } catch (error) {
      if (retainQueuedTurnExecution) {
        host.deleteQueuedTurnExecution?.(record.app.sessionId, envelope.commandId);
      }
      throw error;
    }
  };

  if (highspeedRequiresQueue) {
    // Bug root cause: a temporary Highspeed provider cannot be guided into the current turn; hand
    // it to Core's requireQueue atomic admission so a cross-layer busy snapshot going stale across
    // an await cannot start it directly with the ordinary model.
    return await queueHighspeedTurn();
  }
  const foregroundPromotionLeaseId = forceStartNow ? `send-now:${envelope.commandId}` : undefined;
  let foregroundPromotionLeaseAcquired = false;
  const releaseForegroundPromotionLease = () => {
    if (!foregroundPromotionLeaseAcquired || !foregroundPromotionLeaseId) return;
    record.app.runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    foregroundPromotionLeaseAcquired = false;
  };
  if (forceStartNow) {
    // Bug root cause: Highspeed prepare makes "send now" likelier to land in Core busy admission;
    // hold the foreground lease and preempt the current turn first so requestedDelivery=startNow
    // is not silently changed to queue.
    const leaseResult = record.app.runtime.acquireForegroundPromotionLease({
      leaseId: foregroundPromotionLeaseId!,
      mode: "after-current",
      promotedInputId: envelope.commandId,
    });
    if (leaseResult.kind !== "acquired") {
      throw new V4InputAdmissionRejectedError(
        "fault.command.inputRejected",
        "send now foreground promotion is busy",
      );
    }
    foregroundPromotionLeaseAcquired = true;
    try {
      // One message's delivery only decides when the new input is consumed; it cannot bypass the existing queue's user decision.
      await applyHeldQueueDisposition(
        host,
        record,
        payload.heldQueueDisposition,
        payload.expectedHeldQueueItemIds,
      );
      await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 sendText startNow preempts active turn",
        goalPausedMutationReason: "send_now_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
      });
    } catch (error) {
      releaseForegroundPromotionLease();
      throw error;
    }
  }
  if (!forceStartNow) {
    await applyHeldQueueDisposition(
      host,
      record,
      payload.heldQueueDisposition,
      payload.expectedHeldQueueItemIds,
    );
  }
  let started;
  // Attachment command surface: AttachmentRef → TurnAttachment is mapped after the gate (active turn already excluded).
  try {
    const intent = submissionIntent({
      text: payload.text,
      inputOrigin: payload.inputOrigin,
      botGroupSource: payload.botGroupSource,
      conversationQuotes: payload.conversationQuotes,
      requestedDelivery:
        payload.requestedDelivery ??
        (routingMode === "guide" ? "guide" : routingMode === "enqueue" ? "queue" : "startNow"),
      ...(payload.requestedDelivery !== "guide" && routingMode === "guide" && attachments?.length
        ? { fallbackReasonCode: "guide.attachmentsUnsupported" }
        : {}),
      attachmentRefs: payload.attachments,
      sharedContextRefs: payload.context_refs,
      ...(payload.source ? { source: payload.source } : {}),
    });
    started = await startPromptTurn(host, record, {
      content: payload.text,
      ...(payload.browserAmbientContext
        ? { browserAmbientContext: payload.browserAmbientContext }
        : {}),
      inputId: envelope.commandId,
      // Send-now is the user's new instruction: after preemption, start a new round as a normal
      // user message just like when idle, with no mid-turn hint.
      // Fix reason: it used to be marked user_steer after preemption, and the model saw a
      // "continue in the current turn" hint; with MCS off that hint was also merged into the
      // tool_result already sent by the previous request, rewriting that request's cache entry.
      intent,
      ...(payload.context_refs ? { sharedContextRefs: payload.context_refs } : {}),
      ...turnBackgroundAttributionOf(payload),
      ...(payload.botDeliveryTarget ? { botDeliveryTarget: payload.botDeliveryTarget } : {}),
      toolDisallowlist: payload.toolDisallowlist,
      ...(payload.modelExecution
        ? { modelExecution: createModelExecutionContext(payload.modelExecution) }
        : {}),
      ...(attachments ? { attachments } : {}),
      // The promotion lease itself belongs to Core's busy authority; without requireIdle, the
      // post-preemption startNow first lands in the deferred queue and is auto-drained after the lease is released.
      ...(forceStartNow ? { requireIdle: true } : {}),
    });
  } catch (error) {
    if (
      highspeedExecution &&
      error instanceof V4PromptRejectedError &&
      error.reasonCode === "activePrompt"
    ) {
      // Bug root cause: a new reservation can appear between Bootstrap reading idle and Core
      // admission. Then Highspeed must neither be lost by downgrade nor have its accelerated
      // credentials injected into the current turn — Core force-queues it instead.
      return await queueHighspeedTurn();
    }
    throw error;
  } finally {
    releaseForegroundPromotionLease();
  }
  if (started.admission.kind === "queued") {
    return {
      type: "inputAccepted",
      delivery: "queue",
      inputId: envelope.commandId,
    };
  }
  return {
    type: "inputAccepted",
    delivery: "startNow",
    inputId: envelope.commandId,
  };
}

/** Polls until both the Bootstrap turn's and the Core turn's finally release authority. */
export async function waitForSessionIdle(record: V4SessionRecordView): Promise<void> {
  const deadline = Date.now() + IDLE_POLL_TIMEOUT_MS;
  while (true) {
    // Bug root cause: Bootstrap's abort/foreground flags clear before Core's activeTurn cleanup;
    // an edit rewound inside this window and re-admitted gets turn_not_steerable. Core's
    // activeTurn is the authoritative closing boundary for prompt admission and must be waited on too.
    const coreTurnActive = record.app.runtime?.getActiveTurnInfo?.() !== undefined;
    if (
      record.activeAbortController === undefined &&
      record.app.runtime?.getActiveForegroundExecutionId?.() === undefined &&
      !coreTurnActive
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new V4SessionIdleTimeoutError(record.app.sessionId);
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_INTERVAL_MS));
  }
}

export async function preemptActiveTurnAndWait(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  options: {
    abortMessage: string;
    goalPausedMutationReason: string;
    preserveQueueAutoDrainOnCancel?: boolean;
  },
): Promise<void> {
  const bootstrapAbortController = record.activeAbortController;
  // A background notification's model-only turn holds foreground authority independently via a
  // Core runtime command and creates no Bootstrap activeAbortController. Ignoring that
  // misjudges idle and then steers a promoted queue item back into the old notification turn.
  const runtimeStop = record.app.runtime?.stopActiveForegroundExecution?.({
    preserveQueueAutoDrainOnCancel: options.preserveQueueAutoDrainOnCancel === true,
    reason: options.abortMessage,
  });
  if (bootstrapAbortController || runtimeStop?.kind === "stopped") {
    const pausedGoal = await pauseActiveGoal(host, record);
    if (runtimeStop?.kind !== "stopped") {
      bootstrapAbortController?.abort(
        createTurnCancelReason(options.abortMessage, {
          preserveQueueAutoDrainOnCancel: options.preserveQueueAutoDrainOnCancel === true,
        }),
      );
    }
    if (pausedGoal) {
      await host.afterLegacyStateMutation?.(record, options.goalPausedMutationReason);
    }
  }
  await waitForSessionIdle(record);
}

export async function stop(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const payload = envelope.payload as CommandPayloadMap["stop"];
  const hadActivePrompt = Boolean(record.activeAbortController);
  const activeExecutionId = record.app.runtime?.getActiveForegroundExecutionId?.();
  // Only a stop that will really cancel holds the queue before aborting (ISSUE-010, holdFollowingQueue).
  const willCancel =
    activeExecutionId !== undefined
      ? payload.expectedForegroundExecutionId === undefined ||
        payload.expectedForegroundExecutionId === activeExecutionId
      : hadActivePrompt && payload.expectedForegroundExecutionId === undefined;
  const legacyController = record.activeAbortController;
  // A controller already aborted before this stop means any cancel (a Steer, a goal pause, ...) is in flight, not torn down.
  const legacyAbortedBefore = legacyController?.signal.aborted === true;
  const held = await holdFollowingQueue(host, record, willCancel);
  // The hold write yields, so the target seen above may have ended or been replaced meanwhile. A compat
  // target is its controller: replaced means a new turn, cleared means the turn ended on its own.
  const compatTarget = held && activeExecutionId === undefined;
  const compatReplaced =
    compatTarget &&
    record.activeAbortController !== undefined &&
    record.activeAbortController !== legacyController;
  const compatEnded = compatTarget && record.activeAbortController === undefined;
  // After a hold write, pin the runtime stop to the execution observed before it.
  const stopTargetId =
    payload.expectedForegroundExecutionId ?? (held ? activeExecutionId : undefined);
  const runtimeStop =
    compatReplaced || compatEnded
      ? undefined
      : record.app.runtime?.stopActiveForegroundExecution?.({
          expectedForegroundExecutionId: stopTargetId,
          reason: "v4 session stopped",
        });
  host.logger?.info?.("v4 stop foreground execution inspected", {
    activeForegroundExecutionId:
      runtimeStop?.kind === "mismatch"
        ? runtimeStop.activeForegroundExecutionId
        : runtimeStop?.kind === "stopped"
          ? runtimeStop.foregroundExecutionId
          : undefined,
    event: "v4.stop.foreground_execution_inspected",
    expectedForegroundExecutionId: payload.expectedForegroundExecutionId,
    module: "bootstrap.zcode_protocol_v4.commands",
    runtimeStopKind: runtimeStop?.kind ?? "unsupported",
    sessionId: record.app.sessionId,
  });
  const cancelInFlight = isStopCancelInFlight({
    held,
    runtimeIdle: runtimeStop?.kind === "idle",
    // Only the pinned target counts: core returns idle for an aborted active execution before the expected-id check.
    runtimeIdRegistered:
      stopTargetId !== undefined &&
      record.app.runtime?.getActiveForegroundExecutionId?.() === stopTargetId,
    compatAbortedBefore: activeExecutionId === undefined && legacyAbortedBefore && !compatReplaced && !compatEnded,
  });
  // A stop that cancels nothing undoes its own hold: the turn-end drain check already saw autoDrain=false.
  const cancelledNothing =
    compatReplaced ||
    compatEnded ||
    (!cancelInFlight && (runtimeStop?.kind === "idle" || runtimeStop?.kind === "mismatch"));
  if (held && cancelledNothing) await releaseFollowingQueue(host, record);
  if (
    compatReplaced ||
    (stopTargetId !== undefined &&
      !cancelInFlight &&
      (runtimeStop?.kind === "idle" || runtimeStop?.kind === "mismatch"))
  ) {
    // Stop has an async window from renderer to host; if the verifier already ended and the next
    // round started, continuing to abort the outer controller would kill a new execution the user
    // has not seen. An execution-id mismatch can only noop.
    throw new V4CommandNoopError("guard.stopTargetChanged");
  }
  if (runtimeStop?.kind === "stopped") {
    // Break the runtime-owned verifier/continuation first, then wait for the goal pause;
    // otherwise the verifier might pass before the pause RPC completes and join the next continuation.
    record.activeAbortController?.abort(new Error("v4 session stopped"));
    const pausedGoal = await pauseActiveGoal(host, record);
    if (pausedGoal) {
      await host.afterLegacyStateMutation?.(record, "session_stop_goal_paused");
    }
    return undefined;
  }

  // Compact and legacy-client compat: they have no runtime foreground execution token, and the
  // bootstrap outer controller still provides the cancellation window.
  let pausedGoal = false;
  if (hadActivePrompt) {
    pausedGoal = await pauseActiveGoal(host, record);
  }
  record.activeAbortController?.abort(new Error("v4 session stopped"));
  if (pausedGoal) {
    await host.afterLegacyStateMutation?.(record, "session_stop_goal_paused");
  }
  return undefined;
}

export const sessionFlowHandlers = { sendText, stop };
