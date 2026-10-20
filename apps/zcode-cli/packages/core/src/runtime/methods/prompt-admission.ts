import { createChildTraceContext, createQueryId, createTurnId } from "../deps.js";
import type { QueryId, TurnInputIntentMetadata } from "../deps.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { acceptSubmissionModelSelection, captureHighspeedFallbackSelection } from "./turn-model.js";
import type {
  ActiveTurnStartReservation,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  TurnResult,
} from "../types.js";

/**
 * Each AgentRuntime admits its own prompt: check the busy boundary, create a reservation,
 * and enqueue the command in that runtime's FIFO. Bootstrap must not split these steps; an async gap before the reservation is created
 * could allow the same session to start a second turn.
 */
export async function admitPrompt(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: Parameters<AgentRuntimeInternal["executeTurn"]>[1],
  options?: PromptAdmissionOptions,
): Promise<PromptAdmissionReceipt> {
  if (options?.requireQueue === true) {
    // Root cause: the temporary Highspeed provider can be installed only at the promotion boundary of an independent turn. If queueing is based only on
    // Bootstrap's busy snapshot, the state may become idle during a cross-layer await and the prompt can start with the ordinary model by mistake.
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options.commandKind,
      delivery: "queue",
      input,
      inputId: options.inputId,
      intent: admissionIntent(options.intent, "queue"),
      modelSelectionScope: options.modelExecution?.selectionScope,
      highspeedFallbackSelection: options.modelExecution?.selectionFallback?.target,
      queryId: options.queryId,
      toolDisallowlist: options.toolDisallowlist,
      traceContext: options.traceContext,
    });
  }
  const promotionLeaseOnly =
    options?.requireIdle === true &&
    this.foregroundPromotionLease !== undefined &&
    this.activeForegroundExecution === undefined &&
    this.runtimeCommandDrainActive === false &&
    this.runtimeCommandQueue.hasPending() === false &&
    this.activeTurn === undefined &&
    this.activeTurnStartReservation === undefined;
  const busy = this.hasActiveOrQueuedTurnWork() && !promotionLeaseOnly;
  if (busy) {
    if (options?.requireIdle === true || options?.modelExecution !== undefined) {
      return {
        activeTurnId: this.activeTurn?.turnId,
        kind: "rejected",
        reason: this.activeTurn ? "turn_not_steerable" : "no_active_turn",
      };
    }

    const activeTurn = this.activeTurn;
    const canSteer =
      attachments === undefined &&
      activeTurn?.steerable === true &&
      (options?.queueDelivery === "guide" ||
        options?.delivery === "auto" ||
        options?.delivery === "steer_active_turn") &&
      options?.queueDelivery !== "queue";
    if (canSteer) {
      const delivery = options?.queueDelivery === "guide" ? "guide" : undefined;
      return await this.steerTurn({
        commandKind: options?.commandKind,
        delivery,
        expectedTurnId: options?.expectedTurnId,
        input,
        inputPresentation:
          options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
        inputId: options?.inputId,
        intent: admissionIntent(options?.intent, delivery ?? "queue"),
        queryId: options?.queryId,
        toolDisallowlist: options?.toolDisallowlist,
        traceContext: options?.traceContext,
      });
    }

    const delivery =
      options?.queueDelivery === "guide" && attachments === undefined ? "guide" : "queue";
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options?.commandKind,
      delivery,
      input,
      inputPresentation:
        options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
      inputId: options?.inputId,
      intent: admissionIntent(options?.intent, delivery),
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext,
    });
  }

  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const turnId = createTurnId();
  const turnTraceContext = createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
    queryId,
    sessionId: this.sessionId,
    turnId,
    attributes: { turnNumber: this.turnNumber },
  });
  const reservation: ActiveTurnStartReservation = {
    kind: "regular",
    traceContext: turnTraceContext,
    turnId,
  };
  this.reserveTurnStart(turnId, turnTraceContext, "regular");
  let selectionAccepted = Promise.resolve();

  if (options?.modelExecution) {
    options = {
      ...options,
      modelExecution: captureHighspeedFallbackSelection(this, options.modelExecution),
    };
  }
  const executeOptions = options as ExecuteTurnOptions | undefined;
  const completion = enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    onCommandCancelled: () => this.releaseTurnStart(turnId),
    onCommandAccepted: () => {
      selectionAccepted = acceptSubmissionModelSelection(
        this,
        options?.intent,
        turnTraceContext,
        options?.modelExecution,
      );
    },
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options: {
        ...executeOptions,
        queryId,
        traceContext: options?.traceContext ?? this.rootTraceContext,
      },
      priority: "next",
      reject,
      resolve,
      startReservation: reservation,
      traceContext: turnTraceContext,
    }),
  });
  // Admission is complete; execution failures are handled by existing turn events/callers, without creating an unhandled rejection.
  void completion.catch(() => undefined);
  await selectionAccepted;
  return { completion, kind: "started", turnId };
}

function admissionIntent(
  intent: TurnInputIntentMetadata | undefined,
  admittedDelivery: "guide" | "queue",
): TurnInputIntentMetadata | undefined {
  return intent ? { ...intent, admittedDelivery } : undefined;
}
