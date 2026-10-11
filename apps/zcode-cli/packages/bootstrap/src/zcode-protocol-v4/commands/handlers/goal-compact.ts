// Goal/compact command group: compact / sendGoalCommand / pauseGoal / resumeGoal.
// Semantics were moved from the old server-operations compactSession/goalSession/
// continueGoalAfterChange. Decisions (compact deduplication / active-turn barrier / goal
// continuation) call core directly instead of going through old protocol operations.
//
// Mapping to the old protocol path (fidelity baseline):
// - compactSession（server-operations.ts:1805）→ compact
// - goalSession action:"set" (:1919, including duplicate-set replacement) → sendGoalCommand
// - goalSession action:"resume"（:1980）→ resumeGoal
// - continueGoalAfterChange / runGoalContinuationInBackground (:2204-2269) → a shared private function in this group
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { SteerTurnOptions, SubmitPromptOptions } from "../../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../../zcode-protocol/session-residency.js";
import { inputIntentMetadata } from "../input-intent.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";
import {
  applyHeldQueueDisposition,
  enqueueDeferredInputForBusyWork,
  resolveSubmittedExecutionState,
  V4InputAdmissionRejectedError,
} from "../input-admission.js";

/** Rejection reasons for the goal/compact group (gateway catches them into a failed ACK and passes the message through to the client). */
export class V4GoalCompactRejectedError extends Error {
  constructor(
    readonly reasonCode:
      | "activeTurn"
      | "compactOperationLock"
      | "restoreWarning"
      | "guard.planGoalMutuallyExclusive"
      | "emptyObjective",
    message: string,
  ) {
    super(message);
    this.name = "V4GoalCompactRejectedError";
  }
}

// Before a manual compact is actually registered as a background turn, the next command
// may already complete admission. Checking only runtime activeTurn leaves a small window
// for duplicate compaction; the controller WeakSet closes only the synchronous boundary
// of the operation lock and does not duplicate queue or lifecycle state.
const manualCompactControllers = new WeakSet<AbortController>();

/**
 * compact: manual context compaction (v4 payload is an empty object; there is no instructions variant).
 *
 * Barrier semantics:
 * 1. Running / goal verifier / goal continuation / tool work → enqueue a typed compact intent in FIFO order.
 * 2. Held queue → append at the tail; do not bypass existing future intents.
 * 3. If a compact is running or queued → use compactOperationLock to prevent duplicates.
 */
async function compact(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const activeTurn = record.app.runtime.getActiveTurnInfo();
  const activeController = record.activeAbortController;
  if (
    activeTurn?.kind === "compact" ||
    (activeController ? manualCompactControllers.has(activeController) : false) ||
    host.hasQueueItemKind?.(record.app.sessionId, "compact")
  ) {
    host.logger?.info?.("v4 compact already running or queued, rejected", {
      commandId: envelope.commandId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
    throw new V4GoalCompactRejectedError(
      "compactOperationLock",
      "Compact is already running or queued",
    );
  }
  if (record.restoreWarning) {
    // Same gate as prompt-turn: do not silently continue a session whose restoration failed (including a compact turn).
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }

  const routingMode = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  const busy = Boolean(record.activeAbortController) || Boolean(activeTurn);
  if (busy || routingMode === "enqueue" || routingMode === "guide" || routingMode === "choice") {
    const intent = inputIntentMetadata(envelope, {
      requestedDelivery: "queue",
      text: "/compact",
    });
    const queueOptions = {
      commandKind: "compact" as const,
      inputId: envelope.commandId,
      intent,
      queryId: envelope.commandId as NonNullable<SteerTurnOptions["queryId"]>,
    };
    if (await enqueueDeferredInputForBusyWork(record, "/compact", queueOptions)) {
      return undefined;
    }
    const queued = await record.app.steerTurn("/compact", {
      ...queueOptions,
      delivery: "queue",
    });
    if (queued.kind === "rejected") {
      throw new V4InputAdmissionRejectedError(
        queued.reason === "input_too_large"
          ? "proto.payloadTooLarge"
          : queued.reason === "empty_input"
            ? "proto.invalidPayload"
            : "fault.command.inputRejected",
        `compact input queue rejected: ${queued.reason}`,
      );
    }
    return undefined;
  }

  await startManualCompact(host, record, envelope.commandId);
  return undefined;
}

/** Queue promotion and direct commands share the only manual compact launch path. */
export async function startManualCompact(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  inputId: string,
  foregroundPromotionLeaseId?: string,
): Promise<void> {
  if (record.restoreWarning) {
    throw new V4GoalCompactRejectedError("restoreWarning", record.restoreWarning.message);
  }
  // After cold recovery, the user may invoke /compact directly without sendText. Its
  // background model request also needs a model-readiness check; see the hook in types.ts.
  await host.ensureModelReady?.(record);
  const abortController = new AbortController();
  // The compact model request runs in the background, but Stop still interrupts it via
  // record.activeAbortController. Without registering the controller, compaction would
  // continue until the request finishes naturally.
  record.activeAbortController = abortController;
  manualCompactControllers.add(abortController);
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(host, record, {
      abortController,
      foregroundPromotionLeaseId,
      inputId,
    }),
  ).catch(() => {
    // Report background-compact errors through the event stream (CompactStarted/terminal marker); guard against unhandled rejection.
  });
}

async function runCompactTurnInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  let lifecycleStatus: "success" | "failed" | "cancelled" = "success";
  host.logger?.info?.("v4 background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt("/compact", {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
  } catch (error) {
    lifecycleStatus = params.abortController.signal.aborted ? "cancelled" : "failed";
    mutationReason =
      lifecycleStatus === "cancelled" ? "session_compact_cancelled" : "session_compact_failed";
    if ((host.getQueueLength?.(record.app.sessionId) ?? 0) > 0) {
      try {
        // A queued compact is a FIFO barrier. If auto-drain continued after failure/Stop,
        // later text would overtake the user's explicit maintenance intent. Move it to
        // held, matching ordinary Stop behavior.
        await record.app.setQueueAutoDrain(false);
      } catch (holdError) {
        host.logger?.warn?.("v4 compact failed to hold following queue", {
          error: holdError instanceof Error ? holdError.message : String(holdError),
          inputId: params.inputId,
          sessionId: record.app.sessionId,
        });
      }
    }
    host.logger?.warn?.("v4 background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    manualCompactControllers.delete(params.abortController);
    if (record.activeAbortController === params.abortController) {
      // Ready-boundary constraint: release the active lock before broadcasting after
      // compaction; otherwise a queued prompt or next /compact can briefly encounter the
      // old controller at the ready boundary.
      record.activeAbortController = undefined;
    }
  }
  try {
    // compact has no user message, so it cannot rely on SessionInputPromoted to unpin it.
    // Regardless of lifecycle success/failure/cancellation, record the timeline command
    // fact so a restart does not prompt to replay an already executed command.
    await host.recordPersistentCommandFact?.(
      record.app.sessionId,
      "timeline",
      {
        commandId: params.inputId,
        status: "accepted",
        revisionAtDecision: 0,
      },
      { lifecycleStatus },
    );
  } catch (error) {
    // Compaction already ran; a failure in the deduplication side write must not be misreported as model execution failure.
    host.logger?.warn?.("v4 compact persistent command fact failed", {
      commandId: params.inputId,
      error: error instanceof Error ? error.message : String(error),
      sessionId: record.app.sessionId,
    });
  }
  // The old protocol path called afterStateMutation here; this hook is the equivalent (removed with the old broadcast).
  await host.afterLegacyStateMutation?.(record, mutationReason);
}

/**
 * sendGoalCommand: set/update the goal (old goalSession action:"set").
 *
 * Barrier semantics (preserving the old protocol path and completing v4 queue behavior):
 * 1. Active turn → enqueue as sendGoalCommand: /goal writes target state, it is not an
 *    ordinary prompt. Do not change the target while running, but do not discard the
 *    command either. Preserve its command identity in the queue and execute it at the ready boundary.
 * 2. Repeated set converges on replacement semantics (key constraint): `/goal new target`
 *    in the input box is the user's explicit new target. Continuing to require replace
 *    when a target exists would make the user think it changed while the database kept
 *    the old target. If a target exists, use the replacement path (only the broadcast reason differs).
 */
async function sendGoalCommand(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendGoalCommand"];
  const record = requireRecord(host, envelope.sessionId);
  const objective = payload.text.trim();
  if (objective.length === 0) {
    throw new V4GoalCompactRejectedError("emptyObjective", "Usage: /goal <objective>");
  }
  const submittedExecutionState = resolveSubmittedExecutionState(record, payload);
  if (submittedExecutionState.planEnabled) {
    throw new V4GoalCompactRejectedError(
      "guard.planGoalMutuallyExclusive",
      "Plan and Goal cannot be active at the same time.",
    );
  }
  const submissionIntent = (options: Parameters<typeof inputIntentMetadata>[1]) =>
    inputIntentMetadata(envelope, { ...options, ...submittedExecutionState });
  const routingMode = host.getInputRoutingMode?.(record.app.sessionId) ?? null;
  if (record.activeAbortController || routingMode === "enqueue" || routingMode === "guide") {
    // /goal is a target-control command and cannot write the target during an active
    // turn, but product semantics allow it to queue while running/compacting/goal
    // verification is active. The busy projection may arrive before controller
    // registration, so also inspect inputRouting. commandKind preserves control-command
    // identity so the item is later consumed by sendGoalCommand, not as an ordinary user prompt.
    const queuedText = goalCommandQueueText(payload.displayText, objective);
    if (
      await enqueueDeferredInputForBusyWork(record, queuedText, {
        commandKind: "sendGoalCommand",
        inputId: envelope.commandId,
        queryId: envelope.commandId as SteerTurnOptions["queryId"],
        intent: submissionIntent({ requestedDelivery: "queue", text: objective }),
      })
    ) {
      return undefined;
    }
    const queued = await record.app.steerTurn(queuedText, {
      commandKind: "sendGoalCommand",
      inputId: envelope.commandId,
      queryId: envelope.commandId as SteerTurnOptions["queryId"],
      intent: submissionIntent({ requestedDelivery: "queue", text: objective }),
    });
    if (queued.kind === "rejected") {
      throw new V4InputAdmissionRejectedError(
        queued.reason === "input_too_large"
          ? "proto.payloadTooLarge"
          : queued.reason === "empty_input"
            ? "proto.invalidPayload"
            : "fault.command.inputRejected",
        `goal input queue rejected: ${queued.reason}`,
      );
    }
    return undefined;
  }
  await applyGoalCommand(host, record, {
    displayText: goalCommandQueueText(payload.displayText, objective),
    heldQueueDisposition: payload.heldQueueDisposition,
    expectedHeldQueueItemIds: payload.expectedHeldQueueItemIds,
    inputId: envelope.commandId,
    objective,
    intent: submissionIntent({ requestedDelivery: "startNow", text: objective }),
  });
  return undefined;
}

export async function applyGoalCommand(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    displayText?: string;
    heldQueueDisposition?: "clearQueueAndSend" | "keepQueueAndSend";
    expectedHeldQueueItemIds?: readonly string[];
    inputId: string;
    objective: string;
    foregroundPromotionLeaseId?: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  // Resolve the held-queue choice (same as sendText / sendGoalCommand).
  await applyHeldQueueDisposition(
    host,
    record,
    params.heldQueueDisposition,
    params.expectedHeldQueueItemIds,
  );
  const replacesExistingGoal = Boolean(await record.app.readTarget());
  // Goal submission also freezes execution state; first close the Plan explicitly cancelled by this request, rather than blocking continuation based on stale runtime state.
  if (params.intent?.planEnabled !== undefined) {
    if (params.intent.planEnabled)
      throw new V4GoalCompactRejectedError(
        "guard.planGoalMutuallyExclusive",
        "Plan and Goal cannot be active at the same time.",
      );
    await record.app.runtime.setExecutionState(
      { mode: params.intent.mode, planEnabled: false },
      record.traceContext,
    );
  }
  await record.app.setTarget({
    ...(params.displayText ? { displayText: params.displayText } : {}),
    objective: params.objective,
    status: "active",
    ...(params.intent ? { intent: params.intent } : {}),
  });
  await continueGoalAfterChange(host, record, {
    foregroundPromotionLeaseId: params.foregroundPromotionLeaseId,
    inputId: params.inputId,
    intent: params.intent,
    reason: replacesExistingGoal ? "goal_replaced" : "goal_set",
  });
}

export function parseGoalObjectiveFromCommandText(text: string): string {
  const trimmed = text.trim();
  const match = /^\/(?:goal|target)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return trimmed;
  const args = match[1]?.trim() ?? "";
  return args.replace(/^replace\s+/i, "").trim();
}

function goalCommandQueueText(displayText: string | undefined, objective: string): string {
  const trimmed = displayText?.trim();
  return trimmed ? trimmed : `/goal ${objective}`;
}

/**
 * pauseGoal: independent target control; do not reuse the generic stop queue hold/disposition.
 * Old V4 supported only stop, so it could not pause a target without an active controller
 * and the UI could not accurately distinguish “pause target” from “end this turn”. First
 * settle the target's active run, then terminate the current goal work.
 */
async function pauseGoal(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return undefined;
  }

  const activeController = record.activeAbortController;
  const paused = await record.app.updateTargetStatus("paused");
  if (!paused) return undefined;

  activeController?.abort(new Error("v4 goal paused"));
  await host.afterLegacyStateMutation?.(record, "goal_paused");
  return undefined;
}

/**
 * resumeGoal: paused → active (the inverse of stopPausesActiveGoalTarget).
 * No target → idempotent success (the old protocol path returned "No goal to resume." without changing state or throwing).
 */
async function resumeGoal(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (record.activeAbortController) {
    // As with sendGoalCommand, resume is a non-pause action from old goalSession and is rejected while running.
    throw new V4GoalCompactRejectedError(
      "activeTurn",
      "Cannot manage goals while a prompt is running",
    );
  }
  // Skipping only the continuation would leave an active Goal + Plan; check before resuming the target instead of writing first and rejecting afterward.
  const planEnabled = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  if (planEnabled && (await record.app.readTarget())) {
    throw new V4GoalCompactRejectedError(
      "guard.planGoalMutuallyExclusive",
      "Plan and Goal cannot be active at the same time.",
    );
  }
  const target = await record.app.updateTargetStatus("active");
  if (!target) {
    host.logger?.info?.("v4 resumeGoal without target, noop", {
      commandId: envelope.commandId,
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
  await continueGoalAfterChange(host, record, {
    inputId: envelope.commandId,
    reason: "goal_resumed",
  });
  return undefined;
}

/**
 * Continue after a goal change (moved from old continueGoalAfterChange and shared by set/resume):
 * do not continue in plan mode or when an active turn exists (persist only the goal and
 * let the user explicitly proceed later); otherwise check model readiness, acquire the
 * lock, and call continueActiveTarget in the background.
 */
async function continueGoalAfterChange(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
    reason: string;
  },
): Promise<void> {
  const isPlanMode = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget is a required App capability; continuation depends only on the current mode and whether a turn is already active.
  const canContinue = !isPlanMode && !record.activeAbortController;
  if (canContinue) {
    await host.ensureModelReady?.(record);
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(host, record, {
        abortController,
        foregroundPromotionLeaseId: params.foregroundPromotionLeaseId,
        inputId: params.inputId,
        intent: params.intent,
      }),
    ).catch(() => {
      // Report background goal-continuation failures through the event stream; guard against unhandled rejection.
    });
  }
  // The old protocol path called afterStateMutation(goal_set/goal_replaced/goal_resumed)
  // immediately after continuation started; this is the equivalent hook. The v4
  // projection settles naturally through the TargetChanged event.
  await host.afterLegacyStateMutation?.(record, params.reason);
}

async function runGoalContinuationInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
      intent: params.intent,
      queryId: params.inputId as SubmitPromptOptions["queryId"],
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    if (record.activeAbortController === params.abortController) {
      // Release the active lock as soon as continuation ends; broadcasting is a later
      // action. Holding the lock longer would make a subsequent /goal look like an
      // already-active turn.
      record.activeAbortController = undefined;
    }
  }
  await host.afterLegacyStateMutation?.(record, mutationReason);
}

export const goalCompactHandlers = { compact, pauseGoal, resumeGoal, sendGoalCommand };
