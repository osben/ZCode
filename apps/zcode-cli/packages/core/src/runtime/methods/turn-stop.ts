import { HookEventName, TurnMachineImpl, createMessageId, createPartId } from "../deps.js";
import type { MessageId, Model, TraceContext } from "../deps.js";
import { emptyTokenUsageInfo, toTokenUsageInfo } from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { drainInlineGuideForNextRequest } from "./turn-guide-drain.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";
import {
  appendTurnRequestEntries,
  commitAssistantToTurnRequest,
  commitTurnRequestEntries,
} from "./turn-output-token-continuation.js";
import { createRuntimeAssistantEntry } from "../../agent/message-history.js";

interface AssistantPersistenceAnchor {
  latestAssistantMessageId: AgentRuntimeInternal["latestAssistantMessageId"];
  latestAssistantTurnId: AgentRuntimeInternal["latestAssistantTurnId"];
  latestConversationMessageId: AgentRuntimeInternal["latestConversationMessageId"];
}

export function captureAssistantPersistenceAnchor(
  runtime: AgentRuntimeInternal,
): AssistantPersistenceAnchor {
  return {
    latestAssistantMessageId: runtime.latestAssistantMessageId,
    latestAssistantTurnId: runtime.latestAssistantTurnId,
    latestConversationMessageId: runtime.latestConversationMessageId,
  };
}

export async function persistCompletedAssistantStep(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    includeEmptyAssistant: boolean;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<boolean> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed assistant persistence requires the loop Model");
  }
  let committed = commitAssistantToTurnRequest(runtime, state, options.result, undefined);
  if (!committed && options.includeEmptyAssistant) {
    commitTurnRequestEntries(runtime, state.turnRequestState, [
      createRuntimeAssistantEntry(
        "",
        undefined,
        undefined,
        model,
        toTokenUsageInfo(options.result.usage),
      ),
    ]);
    committed = true;
  }
  if (!committed) {
    if (runtime.sessionStore) {
      await runtime.sessionStore.removeMessage({
        sessionID: runtime.sessionId,
        messageID: options.assistantMessageId,
      });
    }
    if (runtime.latestConversationMessageId === options.assistantMessageId) {
      runtime.latestConversationMessageId =
        options.assistantPersistenceAnchor.latestConversationMessageId;
    }
    if (runtime.latestAssistantMessageId === options.assistantMessageId) {
      runtime.latestAssistantMessageId =
        options.assistantPersistenceAnchor.latestAssistantMessageId;
      runtime.latestAssistantTurnId = options.assistantPersistenceAnchor.latestAssistantTurnId;
    }
    return false;
  }
  const persistedTokens = toTokenUsageInfo(options.result.usage);
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "step-finish",
      reason: options.result.finishReason,
      cost: 0,
      tokens: persistedTokens,
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    options.assistantMessageId,
    state.currentUserMessageId,
    options.assistantCreatedAt,
    {
      completed: Date.now(),
      finish: options.result.finishReason,
      tokens: persistedTokens,
    },
    options.modelTraceContext,
    model,
  );
  return committed;
}

export async function persistOutputTokenLimitErrorCarrier(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    error: { data: Record<string, unknown>; name: string };
    finishReason: string;
    model: Model;
    modelTraceContext: TraceContext;
  },
): Promise<void> {
  const messageId = createMessageId();
  const createdAt = Date.now();
  const tokens = emptyTokenUsageInfo();

  // When partial and terminal error share a durable assistant message, Compact cannot replay
  // the provider partial while excluding the transcript-only error. Store them as separate messages and reuse the existing filtering boundary.
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    undefined,
    options.modelTraceContext,
    options.model,
  );
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: messageId,
      type: "step-finish",
      reason: options.finishReason,
      cost: 0,
      tokens,
    },
    options.modelTraceContext,
  );
  await runtime.persistAssistantMessage(
    messageId,
    state.currentUserMessageId,
    createdAt,
    {
      completed: Date.now(),
      error: options.error,
      finish: options.finishReason,
      tokens,
    },
    options.modelTraceContext,
    options.model,
  );
}

export async function finishModelStepWithoutToolCalls(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantPersistenceAnchor: AssistantPersistenceAnchor;
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
  },
): Promise<"continue" | "break"> {
  if (!state.model) {
    throw new Error("Model-backed turn stop requires the loop Model");
  }
  const assistantCommitted = await persistCompletedAssistantStep(this, state, {
    ...options,
    includeEmptyAssistant: true,
  });
  if (assistantCommitted) recordModelHistoryRound(state);
  if (state.automationCreateLimitReached) {
      // After the limit is reached, allow only a text explanation for this turn. Skip guides and Stop hooks to avoid
      // triggering another model request and extending a turn with closed tools into a new recovery loop.
    if (state.activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events: state.events,
        reasonCode: "guide.noToolBoundary",
        traceContext: state.turnTraceContext,
      });
      state.activeTurn.steerable = false;
    }
    state.stableProductStartMessageId = state.currentUserMessageId;
    state.stableBoundaryAssistantMessageId = options.assistantMessageId;
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.complete(state.modelResponse, "success"),
    );
    return "break";
  }
  if (await drainInlineGuideForNextRequest(this, state)) {
      // Normal text-only is a continuation boundary: the assistant is persisted and the guide enters history as a user role.
      // Continue with the next provider request in the same active turn; do not move it to the future queue.
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  const stopHookResult = await this.runStopHooks(
    state.modelResponse,
    state.toolCallCount,
    state.turnTraceContext,
    state.turnAbortSignal,
    state.stopHookContinuationCount > 0,
  );
  if (this.shouldContinueAfterStopHooks(stopHookResult, state.stopHookContinuationCount)) {
    state.stopHookContinuationCount += 1;
    const hookEntry = this.injectHookAdditionalContextIntoMessageHistory(
      HookEventName.Stop,
      stopHookResult.additionalContexts,
    );
    appendTurnRequestEntries(state.turnRequestState, hookEntry ? [hookEntry] : []);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
    return "continue";
  }
  if (state.activeTurn) {
      // If a FIFO barrier/reservation prevents safe inline delivery this turn, retain the existing authoritative-queue fallback.
      // Consumable text-only guides already drained above as user-role continuations.
    await this.fallbackPendingGuidesToQueue({
      activeTurn: state.activeTurn,
      events: state.events,
      reasonCode: "guide.noToolBoundary",
      traceContext: state.turnTraceContext,
    });
  }
  if (state.activeTurn) state.activeTurn.steerable = false;
  // assistant completed closes only the model step; a Stop hook may continue the same product turn.
  // Only the final break passes it to turn.ts to persist the final boundary after goal accounting.
  state.stableProductStartMessageId = state.currentUserMessageId;
  state.stableBoundaryAssistantMessageId = options.assistantMessageId;
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.complete(state.modelResponse, "success"),
  );
  return "break";
}
