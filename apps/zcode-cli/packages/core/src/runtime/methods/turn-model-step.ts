import { getTurnTools } from "./turn-tool-visibility.js";

import { beginLocalTurnPreparation } from "@zcode/contracts";
import {
  CompactTrigger,
  CoreErrorType,
  SessionEventType,
  createChildTraceContext,
  createCoreError,
  createMessageId,
  createPartId,
  getModelUsageTotalTokens,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import type { MessageId, ModelNetworkStatusEvent, ModelToolContract } from "../deps.js";
import {
  createRuntimeAssistantEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import {
  createModelContextExceededFinishError,
  createCompactRapidRefillError,
  objectKeys,
  projectExecutionErrorPayload,
  finalizeSuspiciousEmptyModelResult,
  isContextExceededFinishReason,
  isSuspiciousEmptyModelResult,
  readRawFinishReason,
  throwIfTurnAborted,
  isModelContextExceededError,
  isTurnCancellationError,
  buildTurnFileChangeSummary,
} from "../helpers/index.js";
import type {
  DrainedPendingInputDiagnostics,
  RunModelTextRequestOptions,
  RuntimeModelStreamSnapshot,
  RuntimeModelTextResult,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { executeToolCallsForModelStep } from "./turn-tools.js";
import {
  captureAssistantPersistenceAnchor,
  finishModelStepWithoutToolCalls,
  persistCompletedAssistantStep,
  persistOutputTokenLimitErrorCarrier,
} from "./turn-stop.js";
import { createStreamingToolCoordinator } from "./streaming-tool-coordinator.js";
import { persistCancelledStreamSnapshot } from "./cancelled-stream-persistence.js";
import {
  beginStartPlanBusyAdmissionRetryAttempt,
  createStartPlanBusyAutoRetryExhaustedError,
  emitStreamRecoveryRetryEvents,
  emitStreamRecoveryStarted,
  getStartPlanBusyAdmissionRetryDelayMs,
  isStartPlanBusyStreamRecoveryFailure,
} from "./streaming-recovery.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  evaluateRapidRefill,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
  recordModelHistoryRound,
} from "./turn-loop-state.js";
import {
  querySourceForTask,
  recordMainTurnCacheHitUsage,
  recordMainTurnModelUsage,
} from "./turn-model-step-usage.js";
import {
  estimateCurrentModelInputTokens,
  resolveExecutionContextBudgetThresholds,
} from "./compact.js";
import {
  resolveModelStepMaxOutputTokens,
  resolveNormalRequestMaxOutputTokens,
} from "./model-token-limits.js";
import {
  applyExecutionSelectionFallback,
  matchExecutionSelectionFallback,
} from "./turn-execution-fallback.js";
import {
  appendOutputTokenContinuation,
  classifyOutputTokenContinuation,
  commitAssistantToTurnRequest,
  commitTurnRequestEntries,
  completeOutputTokenRecovery,
  hasAssistantReasoningContent,
  OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
} from "./turn-output-token-continuation.js";

type ModelStepResult = "continue" | "output_continuation" | "break";

export async function runModelBackedTurnStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
  },
): Promise<ModelStepResult> {
  const assistantMessageId = createMessageId();
  const stepTelemetry = this.agentTelemetry.step({
    stepId: assistantMessageId,
    stepIndex: state.modelStepCount,
  });
  return stepTelemetry.run(async () => {
    try {
      const result = await runModelBackedTurnStepImpl.call(
        this,
        state,
        options,
        assistantMessageId,
      );
      stepTelemetry.finishCompleted(
        result === "output_continuation"
          ? "model_completed"
          : result === "continue"
            ? "tool_requested"
            : "turn_completed",
      );
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, state.turnAbortSignal)) {
        stepTelemetry.finishCancelled("abort_signal");
      } else {
        stepTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

async function runModelBackedTurnStepImpl(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    drainedSteerForNextRequest?: DrainedPendingInputDiagnostics;
    latestRealUserMessageIndex?: number;
    messages: RunModelTextRequestOptions["messages"];
    sourceEntries: readonly (RuntimeMessageEntry | undefined)[];
    recordedMessages: RunModelTextRequestOptions["messages"];
    requestEntries: readonly RuntimeMessageEntry[];
    tools: ModelToolContract[];
  },
  assistantMessageId: MessageId,
): Promise<ModelStepResult> {
  const model = state.model;
  const modelStepIndex = state.modelStepCount;
  const modelStartedAt = Date.now();
  const assistantCreatedAt = modelStartedAt;
  const assistantPersistenceAnchor = captureAssistantPersistenceAnchor(this);
  const querySource = querySourceForTask(this.config.taskType);
  const executionModelSelection = { providerId: model.providerId, modelId: model.modelId };
  // The Agent execution chain explicitly determines the request budget. Ordinary Turns use the full limit declared by the model;
  // ModelFactory no longer disguises this request parameter as persistent ModelSelection/Active Model state.
  const executionMaxOutputTokens = model.optionSpecs.maxOutputTokens.max;
  const executionContextWindow = model.properties.contextWindow;
  const modelTraceContext = createChildTraceContext(state.turnTraceContext, {
    attributes: {
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
      querySource,
    },
  });

  this.logModelRequestSteeringContext({
    activeTurn: state.activeTurn,
    drained: options.drainedSteerForNextRequest,
    messages: options.messages,
    modelStepCount: state.modelStepCount,
    traceContext: modelTraceContext,
  });
  const finishPersistence = beginLocalTurnPreparation(modelTraceContext, "persistence");
  await this.persistAssistantMessage(
    assistantMessageId,
    state.currentUserMessageId,
    assistantCreatedAt,
    undefined,
    modelTraceContext,
    model,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: assistantMessageId,
      type: "step-start",
    },
    modelTraceContext,
  );

  const modelRequestEvent = this.createEvent(
    SessionEventType.ModelRequest,
    {
      // The automatic-continuation hint belongs only to this request and should not be written to the persistent ModelRequest trace.
      messages: options.recordedMessages,
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      querySource,
      toolCount: options.tools.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    },
    modelTraceContext,
  );
  await this.appendEvent(modelRequestEvent, modelTraceContext);
  state.events.push(modelRequestEvent);
  finishPersistence();
  const streamingToolCoordinator = createStreamingToolCoordinator(this, state, {
    assistantMessageId,
    model,
    traceContext: modelTraceContext,
  });
  const networkEventStartIndex = state.events.length;
  let latestStreamSnapshot: RuntimeModelStreamSnapshot = { reasoning: [], text: "" };
  const streamRecoveryRequest = state.pendingStreamRecoveryRequest;
  state.pendingStreamRecoveryRequest = undefined;
  let latestModelRequestId: string | undefined;
  let latestFailedModelRequestId: string | undefined;
  const recordModelNetworkStatus = (event: ModelNetworkStatusEvent): void => {
    if (event.type === "model_request_started") {
      latestModelRequestId = event.requestId;
      return;
    }
    if (event.type === "model_stream_stalled" || event.type === "model_request_failed") {
      latestFailedModelRequestId = event.requestId;
    }
  };

  let result: RuntimeModelTextResult;
  try {
    const baselineMaxOutputTokens = resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: executionMaxOutputTokens,
    });
    result = await this.runModelTextRequest({
      abortSignal: state.turnAbortSignal,
      assistantMessageId,
      events: state.events,
      maxOutputTokens: resolveModelStepMaxOutputTokens({
        baselineMaxOutputTokens,
        contextWindow: executionContextWindow,
        estimatedCurrentUsage: estimateCurrentModelInputTokens(
          options.messages,
          options.sourceEntries,
        ),
        modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      }),
      latestRealUserMessageIndex: options.latestRealUserMessageIndex,
      messages: options.messages,
      sourceEntries: options.sourceEntries,
      model,
      onStreamSnapshot: (snapshot) => {
        latestStreamSnapshot = snapshot;
      },
      onModelNetworkStatus: recordModelNetworkStatus,
      onStreamReasoningDelta: (text) => streamingToolCoordinator.recordReasoningDelta(text),
      onStreamTextDelta: (text) => streamingToolCoordinator.recordTextDelta(text),
      onStreamToolCall: (toolCall) => streamingToolCoordinator.accept(toolCall),
      streamRecovery: streamRecoveryRequest,
      tools: options.tools,
      traceContext: modelTraceContext,
    });
    throwIfTurnAborted(state.turnAbortSignal);
  } catch (error) {
    let finalError = error;
    await recordMainTurnModelUsage(this, state, {
      assistantMessageId,
      error: finalError,
      model,
      modelTraceContext,
      networkEventStartIndex,
      startedAt: modelStartedAt,
      status: state.turnAbortSignal.aborted ? "cancelled" : "error",
    });
    const failedRequestId = latestFailedModelRequestId ?? latestModelRequestId;
    // Declarative fallback for an execution Selection must run before same-model stream recovery: any request failure attributed to the accelerated provider/network
    // boundary must fall back to the session model (spec §2.2). If recovery runs first, it retries the accelerated model after a stream interruption until the budget is exhausted,
    // making fallback ineffective.
    const selectionFallbackMatch = matchExecutionSelectionFallback({
      error: finalError,
      executionProviderId: String(executionModelSelection.providerId),
      selectionFallback: state.selectionFallback,
      turnAborted: state.turnAbortSignal.aborted,
    });
    const toolCallCountBeforeSelectionFallback = state.toolCallCount;
    const selectionFallbackResult = selectionFallbackMatch
      ? await applyExecutionSelectionFallback(this, state, {
          assistantCreatedAt,
          assistantMessageId,
          error: finalError,
          executionModel: model,
          match: selectionFallbackMatch,
          modelTraceContext,
          streamingToolCoordinator,
        })
      : undefined;
    if (selectionFallbackResult?.applied) {
      // Root cause: fallback settlement had already committed tool results and created a new anchor, but inherited the count from the previous length chain,
      // so the fallback model could exhaust its budget on its first truncation. Reset only for tool-count increments; pure text tail discard still respects the limit.
      if (state.toolCallCount > toolCallCountBeforeSelectionFallback) {
        completeOutputTokenRecovery(state.turnRequestState);
      }
      return "continue";
    }
    const toolCallCountBeforeStreamRecovery = state.toolCallCount;
    // Root cause: if fallback-target resolution fails and execution continues into generic recovery, it requests the same failed execution provider again.
    // Once the declaration matched, this turn's recovery decision is consumed; if no fallback target resolves, preserve the original error and fail immediately.
    if (
      !selectionFallbackMatch &&
      (await streamingToolCoordinator.recoverFromModelFailure(
        error,
        assistantCreatedAt,
        failedRequestId ? { failedRequestId } : undefined,
      ))
    ) {
      if (state.toolCallCount > toolCallCountBeforeStreamRecovery) {
        completeOutputTokenRecovery(state.turnRequestState);
      }
      return "continue";
    }
    const admissionRetryDelayMs = getStartPlanBusyAdmissionRetryDelayMs({
      error: finalError,
      providerId: executionModelSelection.providerId,
      state,
      turnNumber: this.turnNumber,
    });
    if (
      !selectionFallbackMatch &&
      !state.turnAbortSignal.aborted &&
      admissionRetryDelayMs !== undefined
    ) {
      // On the second and later rounds, Start Plan may be rejected by the admission concurrency limit before the first token.
      // There is then no text or tool anchor, so the old stream recovery will not start; close the empty assistant and retry briefly.
      const recoveryAttempt = beginStartPlanBusyAdmissionRetryAttempt(state);
      this.logger?.warn("Main turn retrying after Start Plan admission busy", {
        ...traceContextToLogContext(modelTraceContext),
        event: "model.main_turn.retry_start_plan_admission_busy",
        module: "core.runtime",
        retryDelayMs: admissionRetryDelayMs,
        retryNumber: recoveryAttempt.retryNumber,
        maxRetries: recoveryAttempt.maxRetries,
        status: "waiting",
      });
      await emitStreamRecoveryStarted(
        this,
        state,
        {
          assistantMessageId,
          ...(failedRequestId ? { failedRequestId } : {}),
          traceContext: modelTraceContext,
        },
        finalError,
        recoveryAttempt,
      );
      await this.persistAssistantMessage(
        assistantMessageId,
        state.userMessageId,
        assistantCreatedAt,
        {
          completed: Date.now(),
          finish: "start_plan_admission_retry_discarded",
        },
        modelTraceContext,
        model,
      );
      state.modelResponse = "";
      state.modelStepCount += 1;
      recordModelHistoryRound(state);
      state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      await emitStreamRecoveryRetryEvents(
        this,
        state,
        {
          assistantMessageId,
          ...(failedRequestId ? { failedRequestId } : {}),
          traceContext: modelTraceContext,
        },
        {
          ...recoveryAttempt,
          discardedReasoningBytes: 0,
          discardedTextBytes: 0,
          reason: "no_tool_committed",
          toolCallIds: [],
        },
      );
      await streamingToolCoordinator.abandon("model_failed");
      await new Promise((resolve) => setTimeout(resolve, admissionRetryDelayMs));
      throwIfTurnAborted(state.turnAbortSignal);
      return "continue";
    }
    if (
      !selectionFallbackMatch &&
      state.streamRecoveryRetryCount > 0 &&
      !state.turnAbortSignal.aborted &&
      isStartPlanBusyStreamRecoveryFailure(finalError)
    ) {
      // A stream interrupted while Start Plan is running first goes through core stream recovery. Once recovery attempts are exhausted,
      // rethrowing the original provider message is indistinguishable from an initial busy failure, so the UI cannot show "automatic retries exhausted."
      finalError = createStartPlanBusyAutoRetryExhaustedError(finalError);
    }
    // Without a fallback target, the tool was already settled above; abandoning again would publish a ledger event that contradicts its terminal state.
    if (!selectionFallbackResult?.settledAcceptedTools) {
      await streamingToolCoordinator.abandon(
        state.turnAbortSignal.aborted ? "cancelled" : "model_failed",
      );
    }
    if (
      state.turnAbortSignal.aborted &&
      isTurnCancellationError(finalError, state.turnAbortSignal)
    ) {
      await persistCancelledStreamSnapshot(this, {
        assistantCreatedAt,
        assistantMessageId,
        snapshot: latestStreamSnapshot,
        traceContext: modelTraceContext,
      });
      const reasoning = latestStreamSnapshot.reasoning.filter(hasAssistantReasoningContent);
      if (latestStreamSnapshot.text.length > 0 || reasoning.length > 0) {
        // On cancellation, the durable snapshot has already been persisted, but the success path's live history commit
        // and historyRoundCount do not run, leaving provider history inconsistent between the current process and cold resume.
        commitTurnRequestEntries(this, state.turnRequestState, [
          createRuntimeAssistantEntry(
            latestStreamSnapshot.text,
            undefined,
            reasoning,
            state.model
              ? { providerId: state.model.providerId, modelId: state.model.modelId }
              : undefined,
          ),
        ]);
        recordModelHistoryRound(state);
      }
    }
    const finalErrorRecord =
      finalError && typeof finalError === "object"
        ? (finalError as Record<string, unknown>)
        : undefined;
    const persistedErrorCode =
      typeof finalErrorRecord?.code === "string" ? finalErrorRecord.code : undefined;
    const persistedErrorProjection = projectExecutionErrorPayload(finalError);
    const persistedTurnResult = isTurnCancellationError(finalError, state.turnAbortSignal)
      ? "cancelled"
      : undefined;
    await this.persistAssistantMessage(
      assistantMessageId,
      state.userMessageId,
      assistantCreatedAt,
      {
        completed: Date.now(),
        error: {
          name: finalError instanceof Error ? finalError.name : "UnknownError",
          data: {
            message: finalError instanceof Error ? finalError.message : String(finalError),
            ...(persistedErrorCode ? { code: persistedErrorCode } : {}),
            // Live TurnError has structured attribution, but it was not persisted in the transcript, so cold recovery reduced it to runtime.
            ...(persistedErrorProjection.attribution
              ? { attribution: persistedErrorProjection.attribution }
              : {}),
            // A model abort caused by user Stop previously persisted only a generic error name/message.
            // Cold hydration could not distinguish normal cancellation from a real provider failure and incorrectly generated TurnError.
            ...(persistedTurnResult ? { turnResult: persistedTurnResult } : {}),
          },
        },
      },
      modelTraceContext,
      model,
    );
    if (
      isModelContextExceededError(finalError) &&
      (await recoverModelStepAfterContextExceeded.call(
        this,
        state,
        finalError,
        modelStepIndex,
        options.requestEntries,
      ))
    ) {
      return "continue";
    }
    throw finalError;
  }

  state.modelResponse = result.text;
  state.modelStepCount += 1;
  state.tokenCount += getModelUsageTotalTokens(result.usage);

  if (result.usage.cacheReadTokens && result.usage.cacheReadTokens > 0) {
    this.messageHistory.setCacheHit(result.usage.cacheReadTokens);
  }

  let toolCalls = this.extractToolCallsFromResult(result);
  const providerToolCallCount = toolCalls.length;
  const localTerminalResponse = state.automationCreateLimitReached === true;
  if (state.automationCreateLimitReached && toolCalls.length > 0) {
    // Even if the provider hallucinates a tool call after tools=[], do not re-enter the executor;
    // after the limit is reached, this user turn has a terminal text-only boundary.
    this.logger?.warn("Ignored tool calls after automation create limit was reached", {
      event: "automation.create_limit.tool_calls_ignored",
      module: "core.runtime",
      status: "completed",
      toolCallCount: toolCalls.length,
    });
    toolCalls = [];
    state.modelResponse = buildAutomationCreateLimitFallback(state.input);
  } else if (state.automationCreateLimitReached && state.modelResponse.trim().length === 0) {
    state.modelResponse = buildAutomationCreateLimitFallback(state.input);
  }
  const usage = result.usage ?? {};
  const responseLength = state.modelResponse.length;
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  // Automation create-limit already controls how the current response terminates. If length/context reason is reinterpreted
  // after clearing provider tool calls, the text-only terminal response will continue for three more attempts.
  const outputTokenContinuation = localTerminalResponse
    ? "none"
    : classifyOutputTokenContinuation({
        continuationCount: state.turnRequestState.outputTokenContinuationCount,
        finishReason: result.finishReason,
        rawFinishReason,
        toolCallCount: providerToolCallCount,
      });
  this.logger?.info("Model response diagnostics", {
    ...traceContextToLogContext(modelTraceContext),
    event: "model.response.diagnostics",
    finishReason: result.finishReason,
    module: "core.runtime",
    providerMetadataKeys: objectKeys(result.providerMetadata),
    rawFinishReason,
    responseEmpty: responseLength === 0,
    responseLength,
    status: "completed",
    toolCallCount: toolCalls.length,
    usageCacheReadTokens: usage.cacheReadTokens,
    usageCacheWriteTokens: usage.cacheWriteTokens,
    usageInputTokens: usage.inputTokens,
    usageOutputTokens: usage.outputTokens,
    usageReasoningTokens: usage.reasoningTokens,
    usageTotalTokens: usage.totalTokens,
  });
  if (
    !localTerminalResponse &&
    outputTokenContinuation === "none" &&
    toolCalls.length === 0 &&
    isContextExceededFinishReason(result.finishReason, rawFinishReason)
  ) {
    // An over-window provider may return empty content and zero usage. Detect overflow first;
    // otherwise suspicious-empty handling wraps it as a normal ModelError and reactive compaction cannot trigger.
    const contextError = createModelContextExceededFinishError({
      finishReason: result.finishReason,
      rawFinishReason,
    });
    if (
      await recoverModelStepAfterContextExceeded.call(
        this,
        state,
        contextError,
        modelStepIndex,
        options.requestEntries,
      )
    ) {
      return "continue";
    }
    throw contextError;
  }
  if (
    !localTerminalResponse &&
    outputTokenContinuation === "none" &&
    isSuspiciousEmptyModelResult(result.finishReason, responseLength, toolCalls.length, usage)
  ) {
    this.logger?.warn("Model returned an empty non-stop result", {
      ...traceContextToLogContext(modelTraceContext),
      event: "model.response.suspicious_empty",
      finishReason: result.finishReason,
      module: "core.runtime",
      rawFinishReason,
      responseLength,
      status: "completed",
      toolCallCount: toolCalls.length,
      usageTotalTokens: usage.totalTokens,
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason: result.finishReason,
      model: executionModelSelection,
      providerMetadata: result.providerMetadata,
      rawFinishReason,
    });
  }
  // The AI SDK may normalize nonstandard output-limit values to other. Once Runtime confirms the recovery semantics,
  // live events and persistence must consistently use length, while the diagnostics above retain the provider's original value.
  if (outputTokenContinuation !== "none") result.finishReason = "length";
  for (const reasoning of result.reasoning ?? []) {
    if (!hasAssistantReasoningContent(reasoning)) continue;
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID: assistantMessageId,
        type: "reasoning",
        text: reasoning.text,
        metadata: reasoning.providerOptions,
        time: {
          start: modelStartedAt,
          end: Date.now(),
        },
      },
      modelTraceContext,
    );
  }
  if (state.modelResponse.length > 0) {
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID: assistantMessageId,
        type: "text",
        text: state.modelResponse,
        time: {
          start: modelStartedAt,
          end: Date.now(),
        },
      },
      modelTraceContext,
    );
  }

  const cacheHit =
    querySource === "main_turn" ? recordMainTurnCacheHitUsage(this, result.usage) : undefined;
  // The subagent's file checkpoint has already been persisted, but the old gate allowed only main_turn to write
  // the summary into ModelComplete, preventing child details from restoring the summary and undo entry from the authoritative event.
  const supportsTurnFileChanges = querySource === "main_turn" || querySource === "subagent";
  const fileChanges =
    supportsTurnFileChanges && toolCalls.length === 0
      ? buildTurnFileChangeSummary(this.currentTurnFileChanges)
      : undefined;
  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: state.modelResponse,
      // Desktop continuous live events carry only the current model_complete payload.
      // If the main turn sends usage without contextWindow, the old task stream cannot create usage_update,
      // so long-running tasks lose the context meter size and hide it from the input bar.
      ...(querySource === "main_turn" && executionContextWindow !== undefined
        ? { contextWindow: executionContextWindow }
        : {}),
      ...(querySource === "main_turn"
        ? resolveExecutionContextBudgetThresholds({
            compactConfig: this.config.compact,
            modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
            modelContextWindow: executionContextWindow,
            modelMaxOutputTokens: executionMaxOutputTokens,
          })
        : {}),
      querySource,
      stopReason: result.finishReason,
      usage: result.usage,
      ...(cacheHit ? { cacheHit } : {}),
      ...(fileChanges ? { fileChanges } : {}),
      ...(querySource === "main_turn" && result.contextUsageBreakdown
        ? { contextUsageBreakdown: result.contextUsageBreakdown }
        : {}),
      toolCallCount: toolCalls.length,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  state.events.push(modelCompleteEvent);
  this.lastAssistantCompletedAtMs = Date.now();
  await recordMainTurnModelUsage(this, state, {
    assistantMessageId,
    model,
    modelTraceContext,
    networkEventStartIndex,
    result,
    startedAt: modelStartedAt,
    status: "completed",
    toolCallCount: toolCalls.length,
  });
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.receiveModelResponse(state.modelResponse),
  );
  throwIfTurnAborted(state.turnAbortSignal);

  this.logger?.info("Model request completed", {
    ...traceContextToLogContext(modelTraceContext),
    durationMs: Date.now() - modelStartedAt,
    event: "model.request.completed",
    module: "core.runtime",
    status: "completed",
    totalTokens: state.tokenCount,
    toolCallCount: toolCalls.length,
  });

  const executableToolCalls = toolCalls.filter((toolCall) => !toolCall.providerExecuted);
  const streamedToolResults = await streamingToolCoordinator.drain(executableToolCalls);
  if (outputTokenContinuation !== "none") {
    // On the first output-limit hit, the current request may contain a one-time project-memory attachment;
    // advance query-local state from the actual request array rather than reverting to the pre-request array.
    state.turnRequestState.entries = options.requestEntries;
    const assistantCommitted = await persistCompletedAssistantStep(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      includeEmptyAssistant: false,
      modelTraceContext,
      result,
    });
    if (assistantCommitted) recordModelHistoryRound(state);
    if (outputTokenContinuation === "continue") {
      appendOutputTokenContinuation(state.turnRequestState);
      state.reactiveCompactAttemptedInCurrentModelStep = false;
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      return "output_continuation";
    }

    const exhaustedError = createCoreError(
      CoreErrorType.ModelError,
      OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
      {
        context: {
          providerCode: "model_output_limit_exceeded",
          reason: "model_output_limit_exceeded",
          source: "provider",
        },
        recoverable: true,
      },
    );
    const exhaustedErrorProjection = projectExecutionErrorPayload(
      exhaustedError,
      OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
    );
    completeOutputTokenRecovery(state.turnRequestState);
    await persistOutputTokenLimitErrorCarrier(this, state, {
      error: {
        name: exhaustedErrorProjection.code ?? exhaustedError.type,
        data: {
          ...(exhaustedErrorProjection.code ? { code: exhaustedErrorProjection.code } : {}),
          message: exhaustedErrorProjection.message,
          // Existing cold hydration uses retryable to restore UI recoverability. Reuse that field here
          // rather than extending the transcript/hydration schema for a single error.
          retryable: exhaustedError.recoverable,
          ...(exhaustedErrorProjection.attribution
            ? { attribution: exhaustedErrorProjection.attribution }
            : {}),
        },
      },
      finishReason: result.finishReason,
      model,
      modelTraceContext,
    });
    if (state.activeTurn) state.activeTurn.steerable = false;
    // The upstream query loop passes the max_output_tokens API-error assistant to the outer layer. Reuse
    // the existing ModelError -> TurnError terminal path to represent the same live error while ending only the current Turn command.
    throw exhaustedError;
  }
  completeOutputTokenRecovery(state.turnRequestState);
  if (executableToolCalls.length === 0) {
    return await finishModelStepWithoutToolCalls.call(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      modelTraceContext,
      result,
    });
  }

  state.toolCallCount += executableToolCalls.length;
  // Combined fix: a tool-calling assistant must enter both canonical history and this turn's request history.
  // Writing only canonical history would leave the following tool result without its corresponding assistant tool-call.
  if (commitAssistantToTurnRequest(this, state, result, executableToolCalls)) {
    recordModelHistoryRound(state);
  }
  const toolStepResult = await executeToolCallsForModelStep.call(this, state, {
    assistantCreatedAt,
    assistantMessageId,
    modelTraceContext,
    result,
    toolCalls: executableToolCalls,
    streamedToolResults,
  });
  return toolStepResult;
}

function buildAutomationCreateLimitFallback(input: string): string {
  if (/\p{Script=Han}/u.test(input)) {
    return "定时任务已达到 20 个上限，本次未创建。请前往“自动化”手动删除一个已有任务后重试。";
  }
  return "The limit of 20 scheduled tasks has been reached, so no task was created. Manually delete an existing task on the Automations page, then try again.";
}

async function recoverModelStepAfterContextExceeded(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  contextError: unknown,
  modelStepIndex: number,
  activeEntries: readonly RuntimeMessageEntry[],
): Promise<boolean> {
  if (state.reactiveCompactAttemptedInCurrentModelStep) {
    return false;
  }

  const rapidRefill = evaluateRapidRefill(state.compactTracking);
  if (rapidRefill.shouldBlock) {
    this.logger?.warn("Reactive compact rapid-refill breaker tripped", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "compact.rapid_refill_breaker",
      consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
      modelStepIndex,
      module: "core.runtime",
      status: "failed",
      toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      trigger: CompactTrigger.Reactive,
    });
    throw createCompactRapidRefillError({
      consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
      maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
      toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
      toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
    });
  }

  state.reactiveCompactAttemptedInCurrentModelStep = true;
  const compactOutcome = await this.reactiveCompactAfterContextExceeded(
    contextError,
    state.turnTraceContext,
    state.events,
    state.turnAbortSignal,
    {
      activeEntries,
      modelStepIndex,
      agentListingTools: getTurnTools(this, state),
      rapidRefillCount: rapidRefill.consecutiveRapidRefills,
      model: state.model,
      turnRequestState: state.turnRequestState,
    },
  );
  if (compactOutcome !== "compacted") {
    return false;
  }

  recordCompactSuccess(state, rapidRefill);
  recordCompactHistoryRound(state);
  state.turnMachine = new TurnMachineImpl(
    TurnMachineImpl.create(
      this.sessionId,
      this.turnNumber,
      state.input,
      state.traceId,
      state.turnId,
    ).start(),
  );
  return true;
}
