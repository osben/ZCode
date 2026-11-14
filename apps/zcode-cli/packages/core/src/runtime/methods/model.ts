import { assertNotExternalAgentModel } from "@zcode/contracts";
import { beginLocalTurnPreparation } from "@zcode/contracts";
import { runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import type {
  ModelReasoningContentBlock,
  ModelTextContentBlock,
  ModelToolCall,
  ModelUsage,
  ToolCallId,
} from "../deps.js";
import {
  buildSuspiciousEmptyDiagnostics,
  createContentFilteredModelResultError,
  finalizeSuspiciousEmptyModelResult,
  isContentFilteredEmptyModelResult,
  isContextExceededFinishReason,
  isSuspiciousEmptyModelResult,
  logModelRequestMediaSummary,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  normalizeStreamError,
  normalizeModelToolCallsForRuntime,
  projectMessagesWithMediaAttachmentPaths,
  projectMessagesForInputFormat,
  projectMessagesForMediaBudget,
  readRawFinishReason,
} from "../helpers/index.js";
import type { RunModelTextRequestOptions, RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { modelRequestTokenLimitLogContext } from "./model-token-limits.js";
import { createModelStreamingEventQueue } from "./model-streaming-event-queue.js";
import {
  createTextBlock,
  getOrCreateReasoningBlock,
  getOrCreateTextBlock,
} from "./reasoning-stream.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { isOutputTokenLimitFinishReason } from "./turn-output-token-continuation.js";
import {
  recordRequestContextComposition,
  recordRequestContextCompositionUsage,
} from "../context-composition/state.js";
import {
  finishProviderToolCard,
  persistProviderToolRoundContent,
  providerToolOutputText,
  settleUnfinishedProviderToolCards,
  startProviderToolCard,
  type ProviderToolRound,
} from "../provider-tool-rounds/contract.js";

const TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS = 4096;

function hasToolInputLineBreak(value: string): boolean {
  return (
    value.includes("\n") || value.includes("\r") || value.includes("\\n") || value.includes("\\r")
  );
}

export async function runModelTextRequest(
  this: AgentRuntimeInternal,
  options: RunModelTextRequestOptions,
): Promise<RuntimeModelTextResult> {
  const finishAssembly = beginLocalTurnPreparation(options.traceContext, "request_assembly");
  const model = options.model;
  const executionModelSelection = {
    providerId: model.providerId,
    modelId: model.modelId,
  };
  // An off-peak turn overrides only the parent runtime's default model; a foreground child creating a new
  // request still reads session configuration, splitting provider options/capability from the model used for this turn.
  // When a turn snapshot exists, use it as a whole rather than falling back to user-model fields with `??`.
  const mediaPathMessages = await projectMessagesWithMediaAttachmentPaths(
    options.messages,
    this.artifactStore,
  );
  const capabilityProjection = projectMessagesForInputFormat(
    mediaPathMessages,
    model.properties.inputFormat,
  );
  logMediaCapabilityProjection(this.logger, options.traceContext, capabilityProjection, {
    event: "model.request.media_capability_projection",
    message: "Model request media capability projection",
    model: `${model.providerId}/${model.modelId}`,
  });
  const mediaProjection = projectMessagesForMediaBudget(capabilityProjection.messages, {
    latestRealUserMessageIndex: options.latestRealUserMessageIndex,
  });
  logMediaBudgetProjection(this.logger, options.traceContext, mediaProjection, {
    event: "model.request.media_projection",
    message: "Model request media budget projection",
  });
  const projectedOptions =
    mediaProjection.messages === options.messages
      ? options
      : { ...options, messages: mediaProjection.messages };
  logModelRequestMediaSummary(this.logger, projectedOptions.traceContext, {
    incomingMessages: options.messages,
    mediaProjection,
    providerMessages: projectedOptions.messages,
  });
  // 正常请求传递模型级 effective 预算，Compact 传递 min(effective, 20K) 的 summary
  // 任务预算；adapter 只做 provider 兼容映射，不再施加独立 global cap。
  using statusSink = this.createModelStatusSink(
    projectedOptions.traceContext,
    projectedOptions.events,
    {
      ...(projectedOptions.onModelNetworkStatus
        ? { onStatus: projectedOptions.onModelNetworkStatus }
        : {}),
      ...(projectedOptions.streamRecovery
        ? { streamRecovery: projectedOptions.streamRecovery }
        : {}),
    },
  );
  const modelInvocationContext = {
    metadata: traceContextToLogContext(projectedOptions.traceContext),
    // Session type, retry budget, and admission port are bound to the handle by createRuntimeModel;
    // turn steps and model calls inside tools use the same source.
    modelCall: {
      // Ordinary Agent Steps previously relied on Adapter inferring operation/actor from metadata.querySource.
      // If the metadata was renamed or missing, they were incorrectly recorded as tool_internal_model_call.
      // Runtime already has the original execution semantics, so declare them at the request boundary; keep the old mapping only as a compatibility fallback.
      actorKind: this.agentTelemetry.actorKind,
      operation: "agent_step" as const,
      operationId: projectedOptions.traceContext.spanId,
      ...(projectedOptions.streamRecovery
        ? {
            callCause: "recovery" as const,
            attributes: {
              streamRecoveryNumber: projectedOptions.streamRecovery.retryNumber,
            },
          }
        : {}),
    },
    statusSink,
    traceContext: projectedOptions.traceContext,
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
      abortSignal: projectedOptions.abortSignal,
      model,
      traceContext: projectedOptions.traceContext,
    }),
    // Core recovery resends a new request after SSE output has begun; to the adapter, each looks like attempt=1.
    // Pass through the recovery count so the idle timeout increases from the initial request window each time.
    streamIdleTimeoutRetryNumber: projectedOptions.streamRecovery?.retryNumber,
    streamRecovery: projectedOptions.streamRecovery,
  };
  const modelRequest = {
    messages: projectedOptions.messages,
    tools: projectedOptions.tools,
    toolSearchEnabled: projectedOptions.toolSearchEnabled,
    abortSignal: projectedOptions.abortSignal,
    ...(projectedOptions.maxOutputTokens !== undefined
      ? { options: { maxOutputTokens: projectedOptions.maxOutputTokens } }
      : {}),
  };

  this.logger?.debug(
    "Model request token limits",
    modelRequestTokenLimitLogContext({
      contextWindow: model.properties.contextWindow,
      maxOutputTokens: projectedOptions.maxOutputTokens,
      modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
      traceContext: projectedOptions.traceContext,
    }),
  );
  const contextUsageSnapshot = this.buildContextUsageSnapshot(projectedOptions);
  const contextUsageBreakdown = this.buildContextUsageBreakdownFromSnapshot(contextUsageSnapshot);
  this.logContextUsageSnapshot(projectedOptions, contextUsageSnapshot);
  // context 组成的「请求」相位与圆环来自同一次分解（spec §3.4）。
  recordRequestContextComposition(this, {
    model,
    breakdown: contextUsageSnapshot.composition,
  });

  if (!this.shouldStreamModelText()) {
    const result = await runWithModelInvocationContext(modelInvocationContext, () =>
      assertNotExternalAgentModel(model, "model text request").generateText(modelRequest),
    );
    const normalizedToolCalls = normalizeModelToolCallsForRuntime(result.toolCalls, {
      logger: this.logger,
      model: executionModelSelection,
      source: "generateText",
      traceContext: projectedOptions.traceContext,
    });
    recordRequestContextCompositionUsage(this, contextUsageSnapshot.composition, result.usage);
    return {
      ...result,
      ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
      toolCalls: normalizedToolCalls,
    };
  }

  // blockIndex 是一次响应里所有块（reasoning、text、tool）共用的到达序号，服务端工具分轮时不重置。
  // 不用 provider 事件里的 id：tool_use 事件的 id 是调用 id，不是块位置。
  let nextBlockIndex = 0;
  const allocateBlockIndex = () => nextBlockIndex++;
  const lastAllocatedBlockIndex = () => (nextBlockIndex > 0 ? nextBlockIndex - 1 : undefined);
  const toolBlockIndexById = new Map<string, number>();
  // text/reasoning 只属于当前轮；每遇到服务端内置工具就收进 providerToolRounds 并重新开始。
  let text = "";
  let textBlocks: ModelTextContentBlock[] = [];
  const textById = new Map<string, ModelTextContentBlock>();
  // 本次响应里已有文字块时，新块才可能被 live 界面接到上一行；只有这时才补发 text_start。
  let hasTextBlockInResponse = false;
  let finishReason = "unknown";
  let usage: ModelUsage = {};
  let providerMetadata: Record<string, unknown> | undefined;
  let signedReasoningReset = false;
  let reasoning: ModelReasoningContentBlock[] = [];
  const reasoningById = new Map<string, ModelReasoningContentBlock>();
  const toolCalls: ModelToolCall[] = [];
  const toolCallIds = new Set<string>();
  const toolInputDeltaBuffers = new Map<ToolCallId, string>();
  const providerToolRounds: ProviderToolRound[] = [];
  const providerToolStartedAt = new Map<string, number>();
  let roundStartedAt = Date.now();
  const providerToolCardContext = {
    assistantMessageId: options.assistantMessageId,
    events: options.events,
    traceContext: options.traceContext,
  };
  const publishStreamSnapshot = () =>
    options.onStreamSnapshot?.({
      reasoning,
      text,
      textBlocks,
      ...(providerToolRounds.length > 0 ? { providerToolRounds } : {}),
    });
  const streamingEventQueue = createModelStreamingEventQueue({
    events: options.events,
    runtime: this,
    traceContext: options.traceContext,
  });
  const enqueueStreamingEvent = async (
    payload: Parameters<typeof streamingEventQueue.enqueue>[0],
  ) => {
    streamingEventQueue.enqueue(payload);
    await streamingEventQueue.maybeApplyBackpressure();
  };
  const enqueueStreamingEventAndDrain = async (
    payload: Parameters<typeof streamingEventQueue.enqueue>[0],
  ) => {
    streamingEventQueue.enqueue(payload);
    await streamingEventQueue.drain();
  };
  const flushToolInputDelta = async (toolCallId: ToolCallId) => {
    const delta = toolInputDeltaBuffers.get(toolCallId);
    if (!delta) {
      return;
    }
    toolInputDeltaBuffers.delete(toolCallId);
    this.logger?.debug("Model streaming tool input delta flushed", {
      ...traceContextToLogContext(options.traceContext),
      deltaLength: delta.length,
      event: "model.streaming.tool_input_delta.flush",
      module: "core.runtime",
      toolCallId,
    });
    await enqueueStreamingEvent({
      assistantMessageId: options.assistantMessageId,
      delta,
      done: false,
      kind: "tool_input_delta",
      toolCallId,
    });
  };
  const flushAllToolInputDeltas = async () => {
    for (const toolCallId of Array.from(toolInputDeltaBuffers.keys())) {
      await flushToolInputDelta(toolCallId);
    }
  };
  const appendToolInputDelta = async (toolCallId: ToolCallId, delta: string) => {
    if (!delta) {
      return;
    }
    const next = `${toolInputDeltaBuffers.get(toolCallId) ?? ""}${delta}`;
    toolInputDeltaBuffers.set(toolCallId, next);
    if (
      hasToolInputLineBreak(next) ||
      next.length >= TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS
    ) {
      // Write/Edit line-count UX depends on content newlines reaching the UI quickly.
      // Flush on literal or JSON-escaped newlines while retaining a long-single-line fallback,
      // so arguments without newlines are not buffered until tool_input_end.
      await flushToolInputDelta(toolCallId);
    }
  };

  const modelStream = runWithModelInvocationContext(modelInvocationContext, () =>
    assertNotExternalAgentModel(model, "model text request").streamText(modelRequest),
  );
  finishAssembly();
  try {
    for await (const event of modelStream) {
      switch (event.type) {
        case "start": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "start",
          });
          break;
        }

        case "text_start": {
          createTextBlock({ id: event.id, textBlocks, textById, allocateBlockIndex });
          hasTextBlockInResponse = true;
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "text_start",
          });
          break;
        }

        case "text_delta": {
          const { block, created } = getOrCreateTextBlock({
            id: event.id,
            textBlocks,
            textById,
            allocateBlockIndex,
            lastAllocatedBlockIndex,
          });
          block.text += event.text;
          if (created && hasTextBlockInResponse) {
            // 这个块没有 text_start（例如工具之后复用了旧 id），上一段文字的行可能还开着。
            // 补发一次，live 才会和冷恢复一样每个文字块一行。
            await enqueueStreamingEvent({
              assistantMessageId: options.assistantMessageId,
              delta: "",
              done: false,
              kind: "text_start",
            });
          }
          hasTextBlockInResponse = true;
          text += event.text;
          options.onStreamTextDelta?.(event.text);
          publishStreamSnapshot();
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: event.text,
            done: false,
            kind: "text_delta",
          });
          break;
        }

        case "text_end": {
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "text_end",
          });
          break;
        }

        case "reasoning_start": {
          const block = getOrCreateReasoningBlock({
            id: event.id,
            providerMetadata: event.providerMetadata,
            reasoning,
            reasoningById,
            allocateBlockIndex,
          });
          if (event.providerMetadata) {
            block.providerOptions = event.providerMetadata;
          }
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "reasoning_start",
          });
          break;
        }

        case "reasoning_delta": {
          const block = getOrCreateReasoningBlock({
            id: event.id,
            providerMetadata: event.providerMetadata,
            reasoning,
            reasoningById,
            allocateBlockIndex,
          });
          block.text += event.text;
          options.onStreamReasoningDelta?.(event.text);
          if (event.providerMetadata) block.providerOptions = event.providerMetadata;
          publishStreamSnapshot();
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: event.text,
            done: false,
            kind: "reasoning_delta",
          });
          break;
        }

        case "reasoning_end": {
          const block = reasoningById.get(event.id);
          if (block && event.providerMetadata) {
            block.providerOptions = event.providerMetadata;
          }
          reasoningById.delete(event.id);
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "reasoning_end",
          });
          break;
        }

        // The raw argument stream keeps its wrapper structure; the target identity comes from
        // the common admission and reaches the display projection via tool events. Do not infer
        // the execution target from argument deltas, nor adjust model-stream or tool scheduling
        // timing for display identity.
        case "tool_input_start": {
          const toolCallId = event.id as ToolCallId;
          toolInputDeltaBuffers.delete(toolCallId);
          if (!toolBlockIndexById.has(event.id)) {
            toolBlockIndexById.set(event.id, allocateBlockIndex());
          }
          this.logger?.debug("Model streaming tool input started", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_input_start",
            module: "core.runtime",
            providerExecuted: event.providerExecuted,
            toolCallId,
            toolName: event.toolName,
          });
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "tool_input_start",
            providerExecuted: event.providerExecuted,
            toolCallId,
            toolName: event.toolName,
          });
          break;
        }

        case "tool_input_delta": {
          await appendToolInputDelta(event.id as ToolCallId, event.delta);
          break;
        }

        case "tool_input_end": {
          await flushToolInputDelta(event.id as ToolCallId);
          this.logger?.debug("Model streaming tool input ended", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_input_end",
            module: "core.runtime",
            toolCallId: event.id,
          });
          await enqueueStreamingEvent({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            kind: "tool_input_end",
            toolCallId: event.id as ToolCallId,
          });
          break;
        }

        case "tool_call": {
          const [toolCall] =
            normalizeModelToolCallsForRuntime([event.toolCall], {
              logger: this.logger,
              model: executionModelSelection,
              source: "streamText",
              traceContext: options.traceContext,
            }) ?? [];
          if (!toolCall) {
            break;
          }
          await flushToolInputDelta(toolCall.id as ToolCallId);
          if (toolCallIds.has(toolCall.id)) {
              // Defensive handling: protocol compatibility or custom adapter paths may deliver the final tool_call with the same id more than once;
              // runtime deduplicates by id to avoid executing it twice in one response.
            break;
          }
          toolCallIds.add(toolCall.id);
          // 没有 tool_input_start 的调用（例如 mcp_tool_use）在这里分配。
          // 必须早于 push、onStreamToolCall 和分轮：它们都会把这个对象继续往下传。
          toolCall.blockIndex = toolBlockIndexById.get(toolCall.id) ?? allocateBlockIndex();
          toolCalls.push(toolCall);
          this.logger?.debug("Model streaming tool call completed", {
            ...traceContextToLogContext(options.traceContext),
            event: "model.streaming.tool_call",
            inputKeys:
              typeof toolCall.input === "object" &&
              toolCall.input !== null &&
              !Array.isArray(toolCall.input)
                ? Object.keys(toolCall.input as Record<string, unknown>)
                : [],
            module: "core.runtime",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          });
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: false,
            input: toolCall.input,
            kind: "tool_call",
            toolCallId: toolCall.id as ToolCallId,
            toolName: toolCall.name,
          });
          options.onStreamToolCall?.(toolCall);
          if (toolCall.providerExecuted) {
            // Server already executed: close the current round, persist in stream order; the card
            // first shows as running and the result event completes it. messageId is the message
            // this round's parts persist into, and the compact grouping key (same as the cold
            // restore's message.info.id).
            const round: ProviderToolRound = {
              messageId: options.assistantMessageId,
              reasoning,
              text,
              textBlocks,
              toolCall,
            };
            providerToolRounds.push(round);
            await persistProviderToolRoundContent(
              this,
              providerToolCardContext,
              round,
              roundStartedAt,
            );
            text = "";
            textBlocks = [];
            textById.clear();
            reasoning = [];
            reasoningById.clear();
            roundStartedAt = Date.now();
            providerToolStartedAt.set(toolCall.id, roundStartedAt);
            await startProviderToolCard(this, providerToolCardContext, toolCall, roundStartedAt);
            publishStreamSnapshot();
          }
          break;
        }

        case "provider_tool_result": {
          const round = providerToolRounds.find(
            (candidate) => candidate.toolCall.id === event.toolCallId && !candidate.result,
          );
          if (!round) break;
          const result = { output: providerToolOutputText(event.output), isError: event.isError };
          round.result = result;
          await streamingEventQueue.drain();
          await finishProviderToolCard(
            this,
            providerToolCardContext,
            { ...round, result },
            providerToolStartedAt.get(round.toolCall.id) ?? roundStartedAt,
          );
          publishStreamSnapshot();
          break;
        }

        case "finish": {
          finishReason = event.finishReason;
          usage = event.usage;
          providerMetadata = event.providerMetadata;
          signedReasoningReset = event.signedReasoningReset === true;
          await flushAllToolInputDeltas();
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: true,
            kind: "finish",
          });
          break;
        }

        case "error": {
          await flushAllToolInputDeltas();
          await enqueueStreamingEventAndDrain({
            assistantMessageId: options.assistantMessageId,
            delta: "",
            done: true,
            kind: "error",
          });
          // The AI SDK's error chunk is often a plain ProviderBusinessError object (such as 3007).
          // JSON.stringify alone would lose providerCode, leaving the UI with only a generic stream-failure message.
          throw normalizeStreamError(event.error);
        }
      }
    }
  } catch (error) {
    await streamingEventQueue.drain();
    // When failure or cancellation lands between the server-side call and its result, the card still needs a terminal state; a settle failure must not mask the original error.
    await settleUnfinishedProviderToolCards(
      this,
      providerToolCardContext,
      providerToolRounds,
      providerToolStartedAt,
    ).then(
      (settled) => settled && publishStreamSnapshot(),
      (settleError) =>
        this.logger?.warn("Failed to settle provider tool cards after stream failure", {
          ...traceContextToLogContext(options.traceContext),
          event: "model.runtime.stream.provider_tool_settle_failed",
          module: "core.runtime",
          error: settleError instanceof Error ? settleError.message : String(settleError),
        }),
    );
    throw error;
  }
  await streamingEventQueue.drain();
  if (
    await settleUnfinishedProviderToolCards(
      this,
      providerToolCardContext,
      providerToolRounds,
      providerToolStartedAt,
    )
  ) {
    publishStreamSnapshot();
  }

  const rawFinishReason = readRawFinishReason(providerMetadata);
  const outputTokenLimit = isOutputTokenLimitFinishReason(finishReason, rawFinishReason);
  // Same accounting as the turn layer: server-side built-in tools already split into earlier rounds do not count as this step's calls; over-window still goes to Reactive Compact.
  const contextExceeded =
    toolCalls.every((toolCall) =>
      providerToolRounds.some((round) => round.toolCall.id === toolCall.id),
    ) &&
    !outputTokenLimit &&
    isContextExceededFinishReason(finishReason, rawFinishReason);
  if (contextExceeded) {
    // If HTTP 200 + finish metadata is thrown here as a stream error, generic stream recovery will handle it first,
    // bypassing Reactive Compact in the turn layer. Preserve the raw result so the turn layer handles overflow consistently.
    this.logger?.warn("Model stream ended with provider context overflow", {
      ...traceContextToLogContext(options.traceContext),
      event: "model.runtime.stream.context_exceeded",
      finishReason,
      module: "core.runtime",
      modelProviderId: executionModelSelection.providerId,
      modelId: executionModelSelection.modelId,
      rawFinishReason,
      textLength: text.length,
      toolCallCount: toolCalls.length,
    });
  }

  if (
    isContentFilteredEmptyModelResult(finishReason, rawFinishReason, text.length, toolCalls.length)
  ) {
    this.logger?.warn("Model stream was blocked by provider content filter", {
      ...traceContextToLogContext(options.traceContext),
      event: "model.runtime.stream.content_filtered",
      finishReason,
      module: "core.runtime",
      modelProviderId: executionModelSelection.providerId,
      modelId: executionModelSelection.modelId,
      rawFinishReason,
    });
    throw createContentFilteredModelResultError({
      finishReason,
      model: executionModelSelection,
      rawFinishReason,
    });
  }

  // If a stream ends with finishReason=unknown after emitting only start/prelude, turn-model-step records it as suspicious empty.
  // Scan providerMetadata/empty completion once more here before returning the result.
  if (
    !contextExceeded &&
    !outputTokenLimit &&
    isSuspiciousEmptyModelResult(finishReason, text.length, toolCalls.length, usage)
  ) {
    // zcode-plan often returns an empty HTTP 200 SSE; log a finish/providerMetadata summary before throwing so diagnostics are not limited to a generic UI message.
    this.logger?.warn("Model stream ended with suspicious empty completion", {
      ...traceContextToLogContext(options.traceContext),
      event: "model.runtime.stream.suspicious_empty",
      module: "core.runtime",
      modelProviderId: executionModelSelection.providerId,
      modelId: executionModelSelection.modelId,
      textLength: text.length,
      toolCallCount: toolCalls.length,
      ...buildSuspiciousEmptyDiagnostics({
        finishReason,
        providerMetadata,
        rawFinishReason,
      }),
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason,
      model: executionModelSelection,
      providerMetadata,
      rawFinishReason,
    });
  }

  recordRequestContextCompositionUsage(this, contextUsageSnapshot.composition, usage);
  return {
    ...(contextUsageBreakdown.length > 0 ? { contextUsageBreakdown } : {}),
    finishReason,
    providerMetadata,
    reasoning: reasoning.length > 0 ? reasoning : undefined,
    text,
    textBlocks,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    ...(providerToolRounds.length > 0 ? { providerToolRounds } : {}),
    usage,
    ...(signedReasoningReset ? { signedReasoningReset } : {}),
  };
}
