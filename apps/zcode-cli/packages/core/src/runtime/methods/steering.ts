import { parseRuntimeInputPresentation } from "@zcode/contracts";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "../permission-grant-recovery.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { refreshWorkspaceTrustAdmission } from "./mcp.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createMessageId,
  createQueryId,
  createSessionEvent,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CollaborationMode,
  MessageId,
  ModelSelection,
  ModelSelectionOrigin,
  PendingSteerInputInfo,
  PendingTurnInput,
  QueryId,
  SessionEvent,
  TraceContext,
  TurnSteerInput,
  TurnSteerRejectReason,
  TurnSteerResult,
  TurnSteerSource,
  TurnId,
} from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import { acceptSubmissionModelSelection, recordPublishedModelSelection } from "./turn-model.js";
import { createRuntimeModel } from "./runtime-model.js";
import {
  buildUserContentFromTurn,
  measureUtf8Bytes,
  MAX_TURN_STEER_INPUT_BYTES,
  previewInput,
  resolveTurnAttachments,
} from "../helpers/index.js";
import type {
  ActiveTurnKind,
  ActiveTurnSteeringState,
  DrainedPendingInputDiagnostics,
} from "../types.js";
import {
  attachGenUiContext,
  createRuntimeUserEntry,
  realUserRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";

function hasSteerInput(request: Pick<TurnSteerInput, "attachments" | "input" | "intent">): boolean {
  return (
    request.input.trim().length > 0 ||
    Boolean(request.attachments?.length) ||
    Boolean(request.intent?.conversationQuotes?.length)
  );
}

export async function steerTurn(
  this: AgentRuntimeInternal,
  input: string | TurnSteerInput,
): Promise<TurnSteerResult> {
  const request = typeof input === "string" ? { input } : input;
  const activeTurn = this.activeTurn;
  const inputSize = measureUtf8Bytes(request.input);
  const inputPreview = previewInput(request.input);

  // Attachment input may have no body; the old validation checked only input, preventing accepted attachments from entering the authoritative queue.
  if (!hasSteerInput(request)) {
    return await this.rejectTurnSteer("empty_input", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (inputSize > MAX_TURN_STEER_INPUT_BYTES) {
    return await this.rejectTurnSteer("input_too_large", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (!activeTurn) {
    return await this.rejectTurnSteer("no_active_turn", {
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (request.expectedTurnId !== undefined && request.expectedTurnId !== activeTurn.turnId) {
    return await this.rejectTurnSteer("expected_turn_mismatch", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (!activeTurn.steerable) {
    return await this.rejectTurnSteer("turn_not_steerable", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  const queryId = request.queryId ?? (request.inputId as QueryId | undefined) ?? createQueryId();
  const commandKind = request.commandKind;
  const source: TurnSteerSource | undefined = request.source;
  const delivery = request.delivery;
  const automationId = request.automationId;
  const toolDisallowlist = request.toolDisallowlist;
  const queuePosition = activeTurn.pendingInputs.length;
  const intent = request.intent
    ? {
        ...request.intent,
        admittedDelivery: request.delivery ?? request.intent.admittedDelivery,
        queuePosition,
      }
    : undefined;
  const pendingInput: PendingTurnInput = {
    id:
      request.pendingInputId ??
      request.intent?.queueItemId ??
      this.createPendingInputId(activeTurn.turnId),
    input: request.input,
    queuedAt: new Date(),
    traceId: activeTurn.traceContext.traceId,
    queryId,
    ...(commandKind ? { commandKind } : {}),
    ...(source ? { source } : {}),
    ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
    ...(delivery ? { delivery } : {}),
    ...(intent ? { intent } : {}),
    ...(request.attachments ? { attachments: request.attachments } : {}),
    ...(automationId ? { automationId } : {}),
    ...(toolDisallowlist ? { toolDisallowlist } : {}),
    turnId: activeTurn.turnId,
  };
  const selectionAccepted = acceptSubmissionModelSelection(
    this,
    intent,
    activeTurn.traceContext,
    request.modelSelectionScope
      ? {
          selectionScope: request.modelSelectionScope,
          highspeedFallbackSelection: request.highspeedFallbackSelection,
        }
      : undefined,
  );
  activeTurn.pendingInputs.push(pendingInput);
  // When the user steers by hand (the coordinator / inbox / tool follow-ups also route here and
  // do not count): like a prompt, give every run awaiting a decision a fresh pair of reminders.
  if (request.inputPresentation === "user_steer") this.workflowBlockedReminder?.userSpoke();
  const queueLength = activeTurn.pendingInputs.length;
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      inputId: request.inputId,
      queryId,
      pendingInputId: pendingInput.id,
      input: pendingInput.input,
      inputPreview,
      inputSize,
      ...(commandKind ? { commandKind } : {}),
      ...(source ? { source } : {}),
      ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
      ...(delivery ? { delivery } : {}),
      ...(intent ? { intent } : {}),
      ...(automationId ? { automationId } : {}),
      ...(toolDisallowlist ? { toolDisallowlist } : {}),
      targetTurnId: activeTurn.turnId,
      queueLength,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, activeTurn.traceContext);
  await selectionAccepted;
  this.logger?.debug("Turn steer queued", {
    ...traceContextToLogContext(activeTurn.traceContext),
    activeTurnKind: activeTurn.kind,
    activeTurnSteerable: activeTurn.steerable,
    inputId: request.inputId,
    queryId,
    event: "turn.steer.queued",
    expectedTurnId: request.expectedTurnId,
    inputPreview,
    inputSize,
    module: "core.runtime",
    pendingInputId: pendingInput.id,
    queueLength,
    ...(source ? { source } : {}),
    ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
    status: "waiting",
    targetTurnId: activeTurn.turnId,
  });

  return {
    kind: "queued",
    pendingInputId: pendingInput.id,
    queueLength,
    turnId: activeTurn.turnId,
  };
}

export async function enqueueDeferredInput(
  this: AgentRuntimeInternal,
  input: string | TurnSteerInput,
): Promise<TurnSteerResult> {
  const request = typeof input === "string" ? { input } : input;
  const inputSize = measureUtf8Bytes(request.input);
  const inputPreview = previewInput(request.input);
  const traceContext = request.traceContext ?? this.rootTraceContext;

  if (!hasSteerInput(request)) {
    return await this.rejectTurnSteer("empty_input", {
      inputPreview,
      inputSize,
      traceContext,
    });
  }

  if (inputSize > MAX_TURN_STEER_INPUT_BYTES) {
    return await this.rejectTurnSteer("input_too_large", {
      inputPreview,
      inputSize,
      traceContext,
    });
  }

  const targetTurnId =
    this.activeTurn?.turnId ??
    this.latestAssistantTurnId ??
    traceContext.turnId ??
    ("deferred" as TurnId);
  const queryId = request.queryId ?? (request.inputId as QueryId | undefined) ?? createQueryId();
  const commandKind = request.commandKind;
  const source: TurnSteerSource | undefined = request.source;
  const delivery = request.delivery ?? "queue";
  const automationId = request.automationId;
  const toolDisallowlist = request.toolDisallowlist;
  const pendingInputId =
    request.pendingInputId ??
    request.intent?.queueItemId ??
    this.createPendingInputId(targetTurnId);
  const projection = await this.rebuildProjection();
  const queueLength = projection.pendingSteerInputs.length + 1;
  const intent = request.intent
    ? {
        ...request.intent,
        admittedDelivery: delivery,
        queuePosition: queueLength - 1,
      }
    : undefined;
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      ...(request.inputId ? { inputId: request.inputId } : {}),
      queryId,
      pendingInputId,
      input: request.input,
      inputPreview,
      inputSize,
      ...(commandKind ? { commandKind } : {}),
      ...(source ? { source } : {}),
      ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
      delivery,
      ...(intent ? { intent } : {}),
      ...(automationId ? { automationId } : {}),
      ...(toolDisallowlist ? { toolDisallowlist } : {}),
      targetTurnId,
      queueLength,
    },
    {
      traceId: traceContext.traceId,
      turnId: targetTurnId,
    },
  );
  await this.appendEvent(event, traceContext);
  await acceptSubmissionModelSelection(
    this,
    intent,
    traceContext,
    request.modelSelectionScope
      ? {
          selectionScope: request.modelSelectionScope,
          highspeedFallbackSelection: request.highspeedFallbackSelection,
        }
      : undefined,
  );
  this.logger?.debug("Deferred input queued", {
    ...traceContextToLogContext(traceContext),
    delivery,
    event: "turn.deferred_input.queued",
    inputId: request.inputId,
    inputPreview,
    inputSize,
    module: "core.runtime",
    pendingInputId,
    queueLength,
    status: "waiting",
    targetTurnId,
  });

  return {
    kind: "queued",
    pendingInputId,
    queueLength,
    turnId: targetTurnId,
  };
}

export function beginActiveTurn(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
  steerable: boolean,
  options?: { inputId?: string },
): ActiveTurnSteeringState {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  const reservation = this.activeTurnStartReservation;
  if (reservation && reservation.turnId !== turnId) {
    throw createTurnInProgressError(kind, reservation.turnId, turnId);
  }

  const activeTurn: ActiveTurnSteeringState = {
    goalStateChangeReminderDeferralOpen: false,
    kind,
    pendingInputs: [],
    steerable,
    traceContext,
    turnId,
    ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
  };
  this.activeTurnStartReservation = undefined;
  this.activeTurn = activeTurn;
  return activeTurn;
}

export function reserveTurnStart(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
): void {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  if (this.activeTurnStartReservation) {
    throw createTurnInProgressError(kind, this.activeTurnStartReservation.turnId, turnId);
  }
  this.activeTurnStartReservation = {
    kind,
    traceContext,
    turnId,
  };
}

export function releaseTurnStart(this: AgentRuntimeInternal, turnId: TurnId): void {
  if (this.activeTurnStartReservation?.turnId === turnId) {
    this.activeTurnStartReservation = undefined;
  }
}

export function finishActiveTurn(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  if (activeTurn !== undefined && this.activeTurn === activeTurn) {
    this.activeTurn = undefined;
  }
}

export function createPendingInputId(this: AgentRuntimeInternal, turnId: TurnId): string {
  this.pendingInputSequence += 1;
  return `pending_${turnId}_${this.pendingInputSequence}`;
}

function createTurnInProgressError(
  kind: ActiveTurnKind,
  activeTurnId: TurnId,
  nextTurnId: TurnId,
): Error {
  return createCoreError(
    CoreErrorType.TurnInProgress,
    `Cannot start ${kind} turn while another turn is active`,
    {
      context: {
        activeTurnId,
        nextTurnId,
      },
      recoverable: true,
    },
  );
}

export async function rejectTurnSteer(
  this: AgentRuntimeInternal,
  reason: TurnSteerRejectReason,
  options: {
    activeTurn?: ActiveTurnSteeringState;
    expectedTurnId?: TurnId;
    inputPreview?: string;
    inputSize?: number;
    traceContext?: TraceContext;
  },
): Promise<TurnSteerResult> {
  const traceContext =
    options.activeTurn?.traceContext ?? options.traceContext ?? this.rootTraceContext;
  const event = createSessionEvent(
    SessionEventType.TurnSteerRejected,
    this.sessionId,
    {
      activeTurnId: options.activeTurn?.turnId,
      expectedTurnId: options.expectedTurnId,
      inputPreview: options.inputPreview,
      inputSize: options.inputSize,
      reason,
    },
    {
      traceId: traceContext.traceId,
      turnId: options.activeTurn?.turnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.logger?.debug("Turn steer rejected", {
    ...traceContextToLogContext(traceContext),
    activeQueueLength: options.activeTurn?.pendingInputs.length,
    activeTurnId: options.activeTurn?.turnId,
    activeTurnKind: options.activeTurn?.kind,
    activeTurnSteerable: options.activeTurn?.steerable,
    event: "turn.steer.rejected",
    expectedTurnId: options.expectedTurnId,
    inputPreview: options.inputPreview,
    inputSize: options.inputSize,
    module: "core.runtime",
    reason,
    status: "completed",
  });
  return {
    activeTurnId: options.activeTurn?.turnId,
    kind: "rejected",
    reason,
  };
}

export function hasPendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  return this.activeTurn === activeTurn && activeTurn.pendingInputs.length > 0;
}

function pendingInputDelivery(pendingInput: PendingTurnInput | undefined): "guide" | "queue" {
  const delivery = pendingInput?.delivery ?? pendingInput?.intent?.admittedDelivery;
  return delivery === "guide" ? "guide" : "queue";
}

function isInlineGuide(pendingInput: PendingTurnInput): boolean {
  return (
    pendingInput.commandKind !== "sendGoalCommand" &&
    pendingInput.commandKind !== "compact" &&
    pendingInputDelivery(pendingInput) === "guide"
  );
}

function firstInlineGuideIndex(activeTurn: ActiveTurnSteeringState): number {
  // pendingInputs holds both the future queue and current-turn guides. Checking only
  // the array head allowed an earlier ordinary message to permanently block a later explicit guide. Delivery is the consumption lane;
  // preserve admission FIFO only within the guide subsequence here, leaving ordinary queue items in place for outer promotion.
  return activeTurn.pendingInputs.findIndex(isInlineGuide);
}

function withQueryId(traceContext: TraceContext, queryId: QueryId | undefined): TraceContext {
  return queryId ? { ...traceContext, queryId } : traceContext;
}

export function hasInlineGuidePendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  const guideIndex = firstInlineGuideIndex(activeTurn);
  const pendingInput = guideIndex >= 0 ? activeTurn.pendingInputs[guideIndex] : undefined;
  return (
    this.activeTurn === activeTurn &&
    !this.permissionFullAccessPending &&
    !this.queueExternalDrainActive &&
    !this.pendingInputReservations.has(pendingInput?.id ?? "") &&
    pendingInput?.commandKind !== "sendGoalCommand" &&
    pendingInput?.commandKind !== "compact" &&
    pendingInputDelivery(pendingInput) === "guide"
  );
}

/**
 * When the current product turn is stopped/interrupted, or a FIFO barrier prevents safe inline delivery, move unconsumed
 * guides in place to the ordinary queue. Consumable text-only guides continue within the current active turn as usual.
 */
export async function fallbackPendingGuidesToQueue(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reasonCode: "guide.noToolBoundary" | "guide.turnInterrupted";
    traceContext: TraceContext;
  },
): Promise<number> {
  if (this.activeTurn !== options.activeTurn) return 0;
  let changed = 0;
  for (const pendingInput of options.activeTurn.pendingInputs) {
    if (pendingInputDelivery(pendingInput) !== "guide") continue;
    const intent = pendingInput.intent
      ? {
          ...pendingInput.intent,
          admittedDelivery: "queue" as const,
          fallbackReasonCode: options.reasonCode,
        }
      : undefined;
    const event = this.createEvent(
      SessionEventType.TurnSteerDeliveryChanged,
      {
        admittedDelivery: "queue",
        fallbackReasonCode: options.reasonCode,
        ...(intent ? { intent } : {}),
        pendingInputId: pendingInput.id,
        requestedDelivery: "guide",
        targetTurnId: options.activeTurn.turnId,
      },
      options.traceContext,
    );
    await this.appendEvent(event, options.traceContext);
    options.events?.push(event);
    pendingInput.delivery = "queue";
    if (intent) pendingInput.intent = intent;
    changed += 1;
    this.logger?.debug("Guide input fell back to ordinary queue", {
      ...traceContextToLogContext(options.traceContext),
      event: "turn.guide.fell_back",
      fallbackReasonCode: options.reasonCode,
      module: "core.runtime",
      pendingInputId: pendingInput.id,
      status: "completed",
      targetTurnId: options.activeTurn.turnId,
    });
  }
  return changed;
}

async function pendingInputTargetTurnId(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
): Promise<TurnId | undefined> {
  const active = runtime.activeTurn?.pendingInputs.find((item) => item.id === pendingInputId);
  if (active) return active.turnId;
  const projection = await runtime.rebuildProjection();
  return projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId)
    ?.targetTurnId;
}

async function appendPendingInputDispatch(
  runtime: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId?: string;
    state: "queued" | "reserved" | "promoting";
    targetTurnId: TurnId;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.TurnSteerDispatchChanged,
    runtime.sessionId,
    {
      pendingInputId: options.pendingInputId,
      ...(options.reservationId ? { reservationId: options.reservationId } : {}),
      state: options.state,
      targetTurnId: options.targetTurnId,
    },
    { traceId: options.traceContext.traceId, turnId: options.targetTurnId },
  );
  await runtime.appendEvent(event, options.traceContext);
}

async function settleRemovedSessionInput(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
  reason: "user_removed" | "promoted",
): Promise<void> {
  if (reason !== "user_removed") return;
  // Removing only the in-memory queue/event would leave an admitted durable session_input.
  // After LRU eviction, commands/query would become unknown and a CLI restart would misreport the user's deletion as
  // inputDiscardedOnRestart. Persist the cancelled terminal state first; if that fails, do not let the UI queue disappear.
  await runtime.sessionStore?.settleSessionInput?.({
    id: pendingInputId,
    sessionID: runtime.sessionId,
    status: "cancelled",
    reason: "user_removed",
  });
}

async function persistSessionInputUpdates(
  runtime: AgentRuntimeInternal,
  updates: Array<{ id: string; text?: string; queuePosition?: number }>,
): Promise<void> {
  await runtime.sessionStore?.updateSessionInputs?.({
    sessionID: runtime.sessionId,
    updates,
  });
}

export async function reservePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.permissionFullAccessPending || this.pendingInputReservations.has(options.pendingInputId))
    return false;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  // There is an await before rebuildProjection; recheck before acquiring the lock to avoid both callers seeing it as unoccupied.
  if (
    !targetTurnId ||
    this.permissionFullAccessPending ||
    this.pendingInputReservations.has(options.pendingInputId)
  )
    return false;
  this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
  try {
    await appendPendingInputDispatch(this, {
      ...options,
      state: "reserved",
      targetTurnId,
    });
    return true;
  } catch (error) {
    this.pendingInputReservations.delete(options.pendingInputId);
    throw error;
  }
}

export async function markPendingInputPromoting(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  if (!targetTurnId) return false;
  await appendPendingInputDispatch(this, {
    ...options,
    state: "promoting",
    targetTurnId,
  });
  return true;
}

export async function releasePendingInputReservation(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  this.pendingInputReservations.delete(options.pendingInputId);
  if (!targetTurnId) return true;
  try {
    await appendPendingInputDispatch(this, {
      pendingInputId: options.pendingInputId,
      state: "queued",
      targetTurnId,
      traceContext: options.traceContext,
    });
  } catch (error) {
    // Keep the reservation if event persistence fails; otherwise a second caller could execute it again.
    this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
    throw error;
  }
  return true;
}

/**
 * (v4 single-item queue management): remove one item by id from the current active turn's pendingInputs,
 * then emit TurnSteerDiscarded([id]). v4 ProductProjection consumes this event to remove the corresponding queue row.
 * The old renderer-local queue had no single-item operation; v4 needs this native operation now that the queue is projected by the CLI.
 * Returns whether an item was removed (false if the id was not found or there is no active turn).
 */
export async function removePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const reservationId = this.pendingInputReservations.get(options.pendingInputId);
  if (reservationId && reservationId !== options.reservationId) return false;
  const activeTurn = this.activeTurn;
  const index =
    activeTurn?.pendingInputs.findIndex(
      (pendingInput) => pendingInput.id === options.pendingInputId,
    ) ?? -1;
  if (!activeTurn || index < 0) {
    // Held fallback (the queue remains held after stop/completion): held items exist only in
    // the event log/projection because the active turn has ended. Locate the item in the projection, then emit TurnSteerDiscarded.
    return this.discardHeldPendingInputById(
      options.pendingInputId,
      options.traceContext,
      options.reservationId,
      options.reason,
    );
  }
  await settleRemovedSessionInput(this, options.pendingInputId, options.reason);
  activeTurn.pendingInputs.splice(index, 1);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [options.pendingInputId],
      reason: options.reason,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  this.pendingInputReservations.delete(options.pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(options.traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId: options.pendingInputId,
    status: "completed",
    targetTurnId: activeTurn.turnId,
  });
  return true;
}

/**
 * Discard a held item by id (the execution side of heldQueueDisposition=clearQueueAndSend):
 * after the active turn ends, the pendingInputs in-memory state is gone and the event log is authoritative for the held queue.
 * Look up the item in the projection and emit TurnSteerDiscarded(user_removed) if it has not been drained/discarded.
 */
export async function discardHeldPendingInputById(
  this: AgentRuntimeInternal,
  pendingInputId: string,
  traceContext: TraceContext,
  reservationId?: string,
  reason: "user_removed" | "promoted" = "user_removed",
): Promise<boolean> {
  const currentReservation = this.pendingInputReservations.get(pendingInputId);
  if (currentReservation && currentReservation !== reservationId) return false;
  const projection = await this.rebuildProjection();
  const held = projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId);
  if (!held) return false;
  await settleRemovedSessionInput(this, pendingInputId, reason);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [pendingInputId],
      reason,
      targetTurnId: held.targetTurnId,
    },
    {
      traceId: traceContext.traceId,
      turnId: held.targetTurnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.pendingInputReservations.delete(pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId,
    status: "completed",
    targetTurnId: held.targetTurnId,
  });
  return true;
}

/**
 * Clear all queued input (the execution side of heldQueueDisposition=clearQueueAndSend):
 * first remove active-turn in-memory items (to prevent a later roundtrip drain), then clear held leftovers using the projection.
 * Returns the number of discarded items.
 */
export async function clearAllPendingInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  let cleared = 0;
  const activeTurn = this.activeTurn;
  if (activeTurn && activeTurn.pendingInputs.length > 0) {
    for (const item of activeTurn.pendingInputs) {
      await settleRemovedSessionInput(this, item.id, "user_removed");
    }
    const removed = activeTurn.pendingInputs.splice(0);
    cleared += removed.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: removed.map((item) => item.id),
        reason: "user_removed",
        targetTurnId: activeTurn.turnId,
      },
      {
        traceId: activeTurn.traceContext.traceId,
        turnId: activeTurn.turnId,
      },
    );
    await this.appendEvent(event, traceContext);
  }
  const projection = await this.rebuildProjection();
  const heldByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const item of projection.pendingSteerInputs) {
    const group = heldByTurn.get(item.targetTurnId) ?? [];
    group.push(item);
    heldByTurn.set(item.targetTurnId, group);
  }
  for (const [targetTurnId, group] of heldByTurn) {
    for (const item of group) {
      await settleRemovedSessionInput(this, item.pendingInputId, "user_removed");
    }
    cleared += group.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: group.map((item) => item.pendingInputId),
        reason: "user_removed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
  }
  return cleared;
}

/**
 * (v4 single-item queue editing): replace the text of a queued input by id and re-emit TurnSteerQueued with the same id.
 * The v4 reducer's onTurnSteerQueued updates an existing id in place, preserving its position. Returns false if not found or no active turn.
 */
export async function editPendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    newText: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const activeTurn = this.activeTurn;
  const pendingInput = activeTurn?.pendingInputs.find((item) => item.id === options.pendingInputId);
  if (!activeTurn || !pendingInput) {
    // Held fallback: held items exist only in the event log/projection. Locate the item in the projection, then
    // re-emit TurnSteerQueued with the same id (the v4 reducer updates it in place and preserves its position).
    const projection = await this.rebuildProjection();
    const held = projection.pendingSteerInputs.find(
      (item) => item.pendingInputId === options.pendingInputId,
    );
    if (!held) return false;
    await persistSessionInputUpdates(this, [{ id: held.pendingInputId, text: options.newText }]);
    const event = createSessionEvent(
      SessionEventType.TurnSteerQueued,
      this.sessionId,
      {
        pendingInputId: held.pendingInputId,
        input: options.newText,
        inputPreview: previewInput(options.newText),
        inputSize: measureUtf8Bytes(options.newText),
        ...(held.commandKind ? { commandKind: held.commandKind } : {}),
        ...(held.intent ? { intent: { ...held.intent, text: options.newText } } : {}),
        ...(held.automationId ? { automationId: held.automationId } : {}),
        ...(held.toolDisallowlist ? { toolDisallowlist: held.toolDisallowlist } : {}),
        queueLength: projection.pendingSteerInputs.length,
        targetTurnId: held.targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: held.targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  await persistSessionInputUpdates(this, [{ id: pendingInput.id, text: options.newText }]);
  pendingInput.input = options.newText;
  // Keep canonical text in sync after editing the body, or structured-reference restoration will display stale text.
  if (pendingInput.intent) pendingInput.intent = { ...pendingInput.intent, text: options.newText };
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      pendingInputId: pendingInput.id,
      queryId: pendingInput.queryId,
      input: options.newText,
      inputPreview: previewInput(options.newText),
      inputSize: measureUtf8Bytes(options.newText),
      ...(pendingInput.commandKind ? { commandKind: pendingInput.commandKind } : {}),
      ...(pendingInput.delivery ? { delivery: pendingInput.delivery } : {}),
      ...(pendingInput.inputPresentation
        ? { inputPresentation: pendingInput.inputPresentation }
        : {}),
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.automationId ? { automationId: pendingInput.automationId } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
      queueLength: activeTurn.pendingInputs.length,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 * (v4 queue reordering): move pendingInputId before beforePendingInputId (null means move to the end),
 * then emit TurnSteerReordered with the new order. The v4 reducer reorders queue rows accordingly. Returns false if not found.
 */
export async function reorderPendingInput(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const activeTurn = this.activeTurn;
  const fromIndexActive =
    activeTurn?.pendingInputs.findIndex((item) => item.id === options.pendingInputId) ?? -1;
  if (!activeTurn || fromIndexActive < 0) {
    // Held fallback: reorder using the projection order, then emit TurnSteerReordered (the v4 reducer applies the new order).
    const projection = await this.rebuildProjection();
    const heldIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
    const fromIndex = heldIds.indexOf(options.pendingInputId);
    if (fromIndex < 0) return false;
    heldIds.splice(fromIndex, 1);
    if (options.beforePendingInputId === null) {
      heldIds.push(options.pendingInputId);
    } else {
      const beforeIndex = heldIds.indexOf(options.beforePendingInputId);
      if (beforeIndex < 0) {
        heldIds.push(options.pendingInputId);
      } else {
        heldIds.splice(beforeIndex, 0, options.pendingInputId);
      }
    }
    await persistSessionInputUpdates(
      this,
      heldIds.map((id, queuePosition) => ({ id, queuePosition })),
    );
    const targetTurnId =
      projection.pendingSteerInputs.find((item) => item.pendingInputId === options.pendingInputId)
        ?.targetTurnId ?? projection.pendingSteerInputs[0]!.targetTurnId;
    const event = createSessionEvent(
      SessionEventType.TurnSteerReordered,
      this.sessionId,
      {
        orderedPendingInputIds: heldIds,
        targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  const items = [...activeTurn.pendingInputs];
  const fromIndex = items.findIndex((item) => item.id === options.pendingInputId);
  if (fromIndex < 0) return false;
  const [moved] = items.splice(fromIndex, 1);
  if (!moved) return false;
  if (options.beforePendingInputId === null) {
    items.push(moved);
  } else {
    const beforeIndex = items.findIndex((item) => item.id === options.beforePendingInputId);
    if (beforeIndex < 0) {
      // The target anchor disappeared; move the item to the end instead of dropping it.
      items.push(moved);
    } else {
      items.splice(beforeIndex, 0, moved);
    }
  }
  // Reordering only the array without updating intent.queuePosition would make the live queue order correct,
  // but after drain the transcript would write the old admission position, splitting live and cold projection state.
  const reorderedItems = items.map((item, index) =>
    item.intent ? { ...item, intent: { ...item.intent, queuePosition: index } } : item,
  );
  await persistSessionInputUpdates(
    this,
    reorderedItems.map((item, queuePosition) => ({ id: item.id, queuePosition })),
  );
  activeTurn.pendingInputs.splice(0, activeTurn.pendingInputs.length, ...reorderedItems);
  const event = createSessionEvent(
    SessionEventType.TurnSteerReordered,
    this.sessionId,
    {
      orderedPendingInputIds: reorderedItems.map((item) => item.id),
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 * (v4 setAutoDrain): toggle the queue autoDrain authorization bit (session-level configuration, independent of the active turn).
 * Only append a QueueAutoDrainChanged event for the v4 projection; held-state derivation (completed+queue>0+autoDrain=false
 * → choice routing) and the later heldQueueDisposition command complete the send semantics.
 */
export async function setQueueAutoDrain(
  this: AgentRuntimeInternal,
  options: {
    autoDrain: boolean;
    traceContext: TraceContext;
  },
): Promise<void> {
  // false -> true means the user is resuming a paused queue. Old paused items exist only in the event projection, not in the new
  // activeTurn.pendingInputs; during resume, the CLI outer layer promotes them one by one in full projection FIFO order.
  if (options.autoDrain && !this.queueAutoDrain) {
    this.queueExternalDrainActive = true;
  } else if (!options.autoDrain) {
    this.queueExternalDrainActive = false;
  }
  // Store the authorization bit in both runtime (the drain gate) and event log (the source for deriving the paused queue projection).
  this.queueAutoDrain = options.autoDrain;
  const event = createSessionEvent(
    SessionEventType.QueueAutoDrainChanged,
    this.sessionId,
    { autoDrain: options.autoDrain },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/** Re-enable guide consumption at future tool-batch boundaries after the CLI projection confirms the resumed queue is empty. */
export function completeExternalQueueDrain(this: AgentRuntimeInternal): void {
  this.queueExternalDrainActive = false;
}

/**
 * (v4 setFollowupMode): toggle the followup routing mode (session-level configuration).
 * Only append a FollowupModeChanged event for the v4 projection; while running, computeInputRouting uses it to choose
 * between enqueue (queue) and guide.
 */
export async function setFollowupMode(
  this: AgentRuntimeInternal,
  options: {
    mode: "queue" | "guide";
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.FollowupModeChanged,
    this.sessionId,
    { mode: options.mode },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/**
 * (v4 switchModelConfig): append a ModelSelected event after model selection changes for the projection to consume.
 * The v4 reducer's onModelSelected uses it to update config.provider/model/thought and the actual context window,
 * and emits a modelChange marker for mid-turn switches. app.setModel performs the actual provider-client switch;
 * this event records the complete capability tuple after the switch.
 */
export async function emitModelSelected(
  this: AgentRuntimeInternal,
  options: {
    modelSelection: ModelSelection;
    model?: import("../deps.js").Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext: TraceContext;
  },
): Promise<void> {
  const model = options.model ?? createRuntimeModel(this, { selection: options.modelSelection });
  const event = createSessionEvent(
    SessionEventType.ModelSelected,
    this.sessionId,
    {
      // The model-switch event must read the window from the Active Model created for this switch, not copy Runtime Config.
      contextWindow: model.properties.contextWindow,
      modelSelection: cloneModelSelection(options.modelSelection),
      ...(options.effectiveReasoningLevel
        ? { effectiveReasoningLevel: options.effectiveReasoningLevel }
        : {}),
      // previousModelSelection=null is an explicit ∅→X model boundary and must not be lost through a truthiness check.
      ...(options.previousModelSelection !== undefined
        ? {
            previousModelSelection: options.previousModelSelection
              ? cloneModelSelection(options.previousModelSelection)
              : null,
          }
        : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.supportedThoughtLevels
        ? { supportedThoughtLevels: [...options.supportedThoughtLevels] }
        : {}),
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
  recordPublishedModelSelection(this, options.modelSelection);
}

/**
 * (v4 switchCollaborationMode): append a SessionModeChanged event after the command surface switches collaboration mode.
 * app.setMode updates runtime config and persisted preferences without emitting an event (session-mode-port's
 * enterPlanMode/exitPlanMode only covers the plan-tool path), so this event updates config.mode in the v4 projection.
 */
export async function emitModeChanged(
  this: AgentRuntimeInternal,
  options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.SessionModeChanged,
    this.sessionId,
    {
      mode: this.getMode(),
      planEnabled: this.getPlanEnabled(),
      previousMode: options.previousMode,
      source: "command",
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

export async function drainPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events: SessionEvent[];
    traceContext: TraceContext;
  },
): Promise<DrainedPendingInputDiagnostics | undefined> {
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  // Guide dequeue removes the in-memory item before persisting the event; do not capture authorization targets from the stale projection during consumption.
  this.pendingInputDrains = (this.pendingInputDrains ?? 0) + 1;
  try {
    return await drainPendingInputUnlocked.call(this, options);
  } finally {
    this.pendingInputDrains -= 1;
  }
}

async function drainPendingInputUnlocked(
  this: AgentRuntimeInternal,
  options: Parameters<typeof drainPendingInput>[0],
): Promise<DrainedPendingInputDiagnostics | undefined> {
  // Take all waiting guides at this boundary in admission FIFO order. The ordinary queue can
  // only be promoted by bootstrap after session-ready + goal gate; it stays in place — no
  // jumping ahead and no blocking this turn's guides. A guide already reserved by
  // sendQueuedNow can only be promoted by its reservation owner; stop at it so the same input
  // is not consumed a second time by the current turn during the stop barrier, and later
  // guides do not pass it.
  const pendingInputs: PendingTurnInput[] = [];
  for (const pendingInput of options.activeTurn.pendingInputs) {
    if (!isInlineGuide(pendingInput)) continue;
    if (this.pendingInputReservations.has(pendingInput.id)) break;
    pendingInputs.push(pendingInput);
  }
  if (pendingInputs.length === 0) return undefined;
  for (const pendingInput of pendingInputs) {
    options.activeTurn.pendingInputs.splice(
      options.activeTurn.pendingInputs.indexOf(pendingInput),
      1,
    );
  }
  const drainedQueryIds = pendingInputs.flatMap((pendingInput) =>
    pendingInput.queryId ? [pendingInput.queryId] : [],
  );
  const queryIds = drainedQueryIds.length > 0 ? drainedQueryIds : undefined;

  const drainedAt = Date.now();
  const messageIds: MessageId[] = [];
  const runtimeEntries: RuntimeMessageEntry[] = [];
  // Recording, queue removal (promote), and display (drained event) happen per guide; merging
  // happens only when the request is assembled.
  // Fix rationale: when drained events fired only after the whole batch committed, a later
  // write failure left earlier guides saved and dequeued without a formal user row, invisible
  // in the live UI.
  for (const pendingInput of pendingInputs) {
    const messageId = createMessageId();
    // Delivery defaults to queue (queued consumption starts a separate turn); the v4 command surface
    // explicitly marks guides through inputRouting. Persist this in metadata so cold recovery restores the same distinction.
    const delivery = pendingInput.delivery ?? "queue";
    // Each input records its own query; when drained together they must not all be attributed
    // to the last one.
    const inputTraceContext = withQueryId(options.traceContext, pendingInput.queryId);
    const resolvedAttachments = await resolveTurnAttachments(pendingInput.attachments, {
      artifactStore: this.artifactStore,
      fileSystemPort: this.fileSystemPort,
      imageProcessorPort: this.imageProcessorPort,
      sessionId: this.sessionId,
      traceContext: inputTraceContext,
      turnId: options.activeTurn.turnId,
      workingDirectory: this.workingDirectory,
    });
    // Persist the new marker only when an actual guide is consumed without attachments; approval feedback keeps its existing contract.
    const inputPresentation =
      delivery === "guide" && !pendingInput.source && !pendingInput.attachments?.length
        ? parseRuntimeInputPresentation(pendingInput.inputPresentation)
        : undefined;
    const runtimeEntry = createRuntimeUserEntry(
      buildUserContentFromTurn(
        withConversationQuotes(
          pendingInput.input,
          pendingInput.intent?.conversationQuotes,
          pendingInput.intent?.botGroupSource,
        ),
        resolvedAttachments,
      ),
      runtimeInputMetadata(inputPresentation) ?? realUserRuntimeMetadata(),
    );
    await this.persistUserPrompt(
      messageId,
      pendingInput.input,
      resolvedAttachments,
      inputTraceContext,
      {
        steerDelivery: delivery,
        inputPresentation,
        sessionInputId: pendingInput.id,
        sourceCommandId:
          pendingInput.intent?.sourceCommandId ?? String(pendingInput.queryId ?? pendingInput.id),
        clientId: pendingInput.intent?.clientId,
        intent: pendingInput.intent,
      },
    );
    // Enter in-memory history only after the database write succeeds.
    // Fix rationale: when the in-memory history came first, a guide whose write failed stayed
    // in the queue while the next request already carried it; after the user resumed the queue,
    // the model saw it twice, and after cold recovery only once.
    const entry = attachGenUiContext(runtimeEntry, pendingInput.intent?.genUiContext);
    this.messageHistory.addEntries([entry]);
    runtimeEntries.push(entry);
    // Judge by the original source; attachments omit the presentation marker, so a synthetic
    // message must not be mistaken for user input.
    if (
      this.mcpToolsRegistered &&
      runtimeInputMetadata(pendingInput.inputPresentation)?.source !== "legacy_synthetic"
    ) {
      await refreshWorkspaceTrustAdmission(this, inputTraceContext);
    }
    messageIds.push(messageId);
    const event = this.createEvent(
      SessionEventType.TurnSteerDrained,
      {
        injectedMessageIds: [messageId],
        pendingInputIds: [pendingInput.id],
        drainedInputs: [
          {
            pendingInputId: pendingInput.id,
            messageId,
            text: pendingInput.input,
            delivery,
            ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
            ...(pendingInput.toolDisallowlist
              ? { toolDisallowlist: pendingInput.toolDisallowlist }
              : {}),
          },
        ],
        ...(pendingInput.queryId ? { queryIds: [pendingInput.queryId] } : {}),
        targetTurnId: options.activeTurn.turnId,
      },
      inputTraceContext,
    );
    await this.appendEvent(event, inputTraceContext);
    options.events.push(event);
    this.logger?.debug("Turn steer drained", {
      ...traceContextToLogContext(inputTraceContext),
      drainedCount: 1,
      event: "turn.steer.drained",
      injectedMessageIds: [messageId],
      inputPreviews: [previewInput(pendingInput.input)],
      inputSizes: [measureUtf8Bytes(pendingInput.input)],
      module: "core.runtime",
      pendingInputIds: [pendingInput.id],
      queryIds: pendingInput.queryId ? [pendingInput.queryId] : undefined,
      queuedDurationsMs: [drainedAt - pendingInput.queuedAt.getTime()],
      status: "completed",
      targetTurnId: options.activeTurn.turnId,
    });
  }

  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);
  const toolDisallowlist = [
    ...new Set(pendingInputs.flatMap((pendingInput) => pendingInput.toolDisallowlist ?? [])),
  ];
  // When several are taken at the same boundary, the last input carrying an intent decides the
  // next step's model, permissions, and Plan.
  const intent = pendingInputs.findLast((pendingInput) => pendingInput.intent)?.intent;
  return {
    injectedMessageIds: messageIds,
    ...(intent ? { intent } : {}),
    latestMessageId: messageIds.at(-1),
    pendingInputIds,
    queryIds,
    runtimeEntries,
    ...(toolDisallowlist.length > 0 ? { toolDisallowlist } : {}),
  };
}

export async function discardPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reason: "turn_cancelled" | "turn_failed" | "session_resumed";
    traceContext: TraceContext;
  },
): Promise<void> {
  if (this.activeTurn !== options.activeTurn) return;
  const pendingInputs = options.activeTurn.pendingInputs.splice(0);
  if (pendingInputs.length === 0) return;
  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);

  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds,
      reason: options.reason,
      targetTurnId: options.activeTurn.turnId,
    },
    {
      traceId: options.activeTurn.traceContext.traceId,
      turnId: options.activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  options.events?.push(event);
  this.logger?.debug("Turn steer discarded", {
    ...traceContextToLogContext(options.traceContext),
    discardedCount: pendingInputs.length,
    event: "turn.steer.discarded",
    module: "core.runtime",
    pendingInputIds,
    reason: options.reason,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
}

export async function discardPersistedPendingSteerInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  // Queues do not survive restart: first clear any remaining admitted ledger entries. The event log is
  // in memory, so after a crash the projection is empty and the ledger is the only trace. This includes background wake:
  // its subprocess dies when the CLI restarts, and unconsumed notifications cannot be recovered. Record
  // discarded/session_resumed explicitly so users and diagnostics can determine what happened to the input.
  try {
    const admitted =
      (await this.sessionStore?.listSessionInputs?.({
        sessionID: this.sessionId,
        status: "admitted",
      })) ?? [];
    for (const record of admitted) {
      await this.sessionStore?.settleSessionInput?.({
        id: record.id,
        sessionID: this.sessionId,
        status: "discarded",
        reason: "session_resumed",
      });
    }
  } catch (error) {
    this.logger?.warn("Failed to sweep admitted session inputs on resume", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_input.resume_sweep_failed",
      module: "core.runtime",
      status: "failed",
    });
  }

  const projection = await this.rebuildProjection();
  const pendingInputs = projection.pendingSteerInputs;
  if (pendingInputs.length === 0) return 0;

  const pendingByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const pendingInput of pendingInputs) {
    const group = pendingByTurn.get(pendingInput.targetTurnId) ?? [];
    group.push(pendingInput);
    pendingByTurn.set(pendingInput.targetTurnId, group);
  }

  for (const [targetTurnId, group] of pendingByTurn) {
    const pendingInputIds = group.map((item) => item.pendingInputId);
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds,
        reason: "session_resumed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
    this.logger?.debug("Turn steer discarded", {
      ...traceContextToLogContext(traceContext),
      discardedCount: group.length,
      event: "turn.steer.discarded",
      module: "core.runtime",
      pendingInputIds,
      reason: "session_resumed",
      status: "completed",
      targetTurnId,
    });
  }

  return pendingInputs.length;
}
