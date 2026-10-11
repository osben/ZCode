// Session-flow command group: sendText / stop (template for other groups).
// One file per command group: the handler is a pure function (host, envelope) -> CommandResult|undefined.
// Decision logic directly invokes core; environment capabilities use Host hooks (see the migration notes in ../types.ts).
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import { createModelExecutionContext } from "../../../zcode-protocol/model-execution.js";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import {
  applyHeldQueueDisposition,
  hasPromptInput,
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
import type { V4CommandCoreHost, V4QueuedTurnExecution, V4SessionRecordView } from "../types.js";
import { V4CommandNoopError } from "../../v4-gateway.js";

/** Idle polling parameters: 25 ms interval, 5 s timeout. */
const IDLE_POLL_INTERVAL_MS = 25;
const IDLE_POLL_TIMEOUT_MS = 5_000;
const HIGHSPEED_QUEUE_FALLBACK_REASON = "highspeed.requiresQueue";

/** Wait for idle; if the active turn's finally block does not release the lock within 5 s, fail instead of resending. */
export class V4SessionIdleTimeoutError extends Error {
  constructor(sessionId: string) {
    super(`v4 timed out waiting for session idle: ${sessionId}`);
    this.name = "V4SessionIdleTimeoutError";
  }
}

/**
 * sendText: validate the protocol, held queue, model, and attachments; delegate start/queue
 * to Core admission for the same session. When held (choice), still honor heldQueueDisposition.
 */
async function sendText(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const rawPayload = envelope.payload as CommandPayloadMap["sendText"];
  const record = requireRecord(host, envelope.sessionId);
  // Bug root cause: the old validation checked only the body, so attachment-only queries allowed
  // by the UI were incorrectly treated as empty by the CLI.
  if (!hasPromptInput(rawPayload.text, rawPayload.attachments) && !rawPayload.conversationQuotes?.length) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  const activeAutomationId = resolveTurnAutomationId({
    automationId: rawPayload.automationId,
    inputId: envelope.commandId,
  });
  // Bug root cause: Highspeed admission and automation dispatch come from different upstreams;
  // contract drift could send automationId, highspeedMeta, and acceleration execution material
  // to the same turn. The scheduled-execution identity must take priority: never issue requests
  // with acceleration-card credentials, and never persist ordinary model output as a Highspeed
  // message.
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
  // The canonical intent must see the same payload as admission; otherwise the transcript keeps
  // an acceleration marker without credentials.
  const intentEnvelope = dropsHighspeed ? ({ ...envelope, payload } as CommandEnvelope) : envelope;
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, payload.attachments);
  const submittedExecutionState = resolveSubmittedExecutionState(record, payload);
  const submissionIntent = (options: Parameters<typeof inputIntentMetadata>[1]) =>
    inputIntentMetadata(intentEnvelope, { ...options, ...submittedExecutionState });
  const routingMode = host.getInputRoutingMode?.(envelope.sessionId ?? "") ?? null;
  const forceStartNow = payload.requestedDelivery === "startNow";
  // An accelerated turn is expressed as "standard Selection pointing at an acceleration Provider
  // + one-shot execution material"; detection must use the Family predicate rather than compare
  // against a single provider id constant, or a BigModel account's card would be silently
  // dropped as an ordinary turn.
  const highspeedExecution: V4QueuedTurnExecution | undefined = isHighspeedProviderId(
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
    if (!highspeedExecution) {
      throw new V4InputAdmissionRejectedError(
        "fault.command.inputRejected",
        "Highspeed queue requires turn execution material",
      );
    }
    // Acceleration credentials live only in CLI memory: retrieved at promotion time by
    // (sessionId, sourceCommandId) and never stored in queue events.
    host.retainQueuedTurnExecution?.(record.app.sessionId, envelope.commandId, highspeedExecution);
    try {
      const requestedDelivery = routingMode === "guide" ? "guide" : "queue";
      // The accelerated turn's Selection must enter the canonical intent: at promotion time the
      // model is read only from the queue item, never re-read from the session.
      const intent = submissionIntent({
        text: payload.text,
        requestedDelivery,
        admittedDelivery: "queue",
        ...(routingMode === "guide" ? { fallbackReasonCode: HIGHSPEED_QUEUE_FALLBACK_REASON } : {}),
        attachmentRefs: payload.attachments,
      });
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
      host.deleteQueuedTurnExecution?.(record.app.sessionId, envelope.commandId);
      throw error;
    }
  };

  if (highspeedRequiresQueue) {
    // Bug root cause: a temporary Highspeed provider cannot be guided onto the current turn;
    // hand it to Core's requireQueue atomic admission so a cross-layer busy snapshot that goes
    // stale across an await does not start it directly with an ordinary model.
    return await queueHighspeedTurn();
  }
  const foregroundPromotionLeaseId = forceStartNow ? `send-now:${envelope.commandId}` : undefined;
  let foregroundPromotionLeaseAcquired = false;
  let preempted = false;
  const releaseForegroundPromotionLease = () => {
    if (!foregroundPromotionLeaseAcquired || !foregroundPromotionLeaseId) return;
    record.app.runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    foregroundPromotionLeaseAcquired = false;
  };
  if (forceStartNow) {
    // Bug root cause: Highspeed prepare makes "send now" more likely to land in Core busy
    // admission; hold the foreground lease and preempt the current turn first so
    // requestedDelivery=startNow is not silently downgraded to queue.
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
      // A message's delivery only determines when new input is consumed; it cannot bypass the
      // user's decision about the existing queue.
      await applyHeldQueueDisposition(
        host,
        record,
        payload.heldQueueDisposition,
        payload.expectedHeldQueueItemIds,
      );
      preempted = await preemptActiveTurnAndWait(host, record, {
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
  // Attachment command surface: map AttachmentRef → TurnAttachment after the gate (active turn excluded).
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
      // Send-now switches the runtime turn, which would omit the human hint for an in-progress input.
      // Mark plain text only when Core confirms actual preemption; idle and attachment inputs keep the existing path.
      ...(preempted && !attachments?.length ? { inputPresentation: "user_steer" as const } : {}),
      intent,
      ...(payload.context_refs ? { sharedContextRefs: payload.context_refs } : {}),
      ...turnBackgroundAttributionOf(payload),
      ...(payload.botDeliveryTarget ? { botDeliveryTarget: payload.botDeliveryTarget } : {}),
      toolDisallowlist: payload.toolDisallowlist,
      ...(payload.modelExecution
        ? { modelExecution: createModelExecutionContext(payload.modelExecution) }
        : {}),
      ...(attachments ? { attachments } : {}),
      // The promotion lease itself is part of Core's busy authority. Without requireIdle,
      // startNow after preemption would enter the deferred queue and drain automatically after lease release.
      ...(forceStartNow ? { requireIdle: true } : {}),
    });
  } catch (error) {
    if (
      highspeedExecution &&
      error instanceof V4PromptRejectedError &&
      error.reasonCode === "activePrompt"
    ) {
      // Bug root cause: a new reservation may appear between Bootstrap's idle read and Core
      // admission. Highspeed must not be lost to degradation, nor may acceleration credentials
      // be inserted into the current turn; let Core force it into the queue instead.
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

/** Stop the exact runtime foreground execution visible in the projection and mark the active goal as paused. */
async function stop(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const payload = envelope.payload as CommandPayloadMap["stop"];
  const runtimeStop = record.app.runtime?.stopActiveForegroundExecution?.({
    expectedForegroundExecutionId: payload.expectedForegroundExecutionId,
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
  if (
    payload.expectedForegroundExecutionId !== undefined &&
    (runtimeStop?.kind === "idle" || runtimeStop?.kind === "mismatch")
  ) {
    // There is an async window between Renderer and Host. If the verifier has finished and the
    // next turn has started, aborting the outer controller would kill an execution the user has
    // not seen. A mismatched execution id must be a no-op.
    throw new V4CommandNoopError("guard.stopTargetChanged");
  }
  if (runtimeStop?.kind === "stopped") {
    // Interrupt the runtime-owned verifier/continuation before waiting for goal pause; otherwise,
    // the verifier may pass and attach the next continuation before the pause RPC completes.
    record.activeAbortController?.abort(new Error("v4 session stopped"));
    if ((host.getQueueLength?.(record.app.sessionId) ?? 0) > 0) {
      try {
        // The verifier has passed the ordinary turn catch, so do not rely on TurnComplete(cancelled)
        // to flip the runtime queue gate. Explicitly set false to keep the future queue held in place.
        await record.app.setQueueAutoDrain(false);
      } catch (error) {
        host.logger?.warn?.("v4 stop failed to hold following queue", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: record.app.sessionId,
        });
      }
    }
    const pausedGoal = await pauseActiveGoal(host, record);
    if (pausedGoal) {
      await host.afterLegacyStateMutation?.(record, "session_stop_goal_paused");
    }
    return undefined;
  }

  // Compatibility for compact and legacy clients: they have no runtime foreground execution
  // token, so the outer Bootstrap controller still provides the cancellation window.
  const hadActivePrompt = Boolean(record.activeAbortController);
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

/** Shared goal-pause barrier reused by stop and sendQueuedNow (preempt and resend). */
export async function pauseActiveGoal(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
): Promise<boolean> {
  // Call the method through app; do not destructure it because the implementation may depend on this binding.
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return false;
  }
  try {
    const paused = await record.app.updateTargetStatus("paused");
    return Boolean(paused);
  } catch (error) {
    host.logger?.warn?.("v4 stop failed to pause active goal", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: record.app.sessionId,
    });
    return false;
  }
}

/** Poll until both Bootstrap turns and Core turns release authority in finally blocks. */
export async function waitForSessionIdle(record: V4SessionRecordView): Promise<void> {
  const deadline = Date.now() + IDLE_POLL_TIMEOUT_MS;
  while (true) {
    // Bug root cause: Bootstrap's abort/foreground flags clear before Core cleans up activeTurn,
    // so an edit that rewinds and re-enters admission within this window receives
    // turn_not_steerable. Core's activeTurn is the authoritative closing boundary for prompt
    // admission and must be awaited together.
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

/** Wait for the previous execution to release and return whether Core actually stopped the foreground execution. */
export async function preemptActiveTurnAndWait(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  options: {
    abortMessage: string;
    goalPausedMutationReason: string;
    preserveQueueAutoDrainOnCancel?: boolean;
  },
): Promise<boolean> {
  const bootstrapAbortController = record.activeAbortController;
  // A model-only background notification turn holds foreground authority independently through
  // a Core runtime command; it does not create a Bootstrap activeAbortController. Ignoring this
  // would falsely detect idle and steer the promoted queue item back to the old notification turn.
  const runtimeStop = record.app.runtime?.stopActiveForegroundExecution?.({
    preserveQueueAutoDrainOnCancel: options.preserveQueueAutoDrainOnCancel === true,
    reason: options.abortMessage,
  });
  if (bootstrapAbortController || runtimeStop?.kind === "stopped") {
    const pausedGoal = await pauseActiveGoal(host, record);
    if (runtimeStop?.kind !== "stopped") {
      bootstrapAbortController?.abort(new Error(options.abortMessage));
    }
    if (pausedGoal) {
      await host.afterLegacyStateMutation?.(record, options.goalPausedMutationReason);
    }
  }
  await waitForSessionIdle(record);
  return runtimeStop?.kind === "stopped";
}

export const sessionFlowHandlers = { sendText, stop };
