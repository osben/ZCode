/**
 * External agent turns (specs/acp-agent-runtime.md "Chat delegation (phase 4)").
 *
 * Replaces `runRegularTurnLoop` when the turn model is a marker for an `acp-agent` provider. One
 * assistant step is driven by the agent process: its message and thought chunks are streamed as
 * ModelStreaming events and persisted like a text-only model step. Tools, compaction, reminders,
 * memory and title generation do not run on this path.
 */
import {
  CoreErrorType,
  ExternalAgentTurnError,
  createCoreError,
  type CoreError,
  type ExternalAgentPermissionAnswer,
  type ExternalAgentPermissionAsk,
  type ExternalAgentPromptBlock,
  type ExternalAgentTurnDriver,
  type ExternalAgentTurnEvent,
  type ExternalAgentTurnResult,
  type ModelReasoningContentBlock,
  type ModelStreamingPayload,
  type ModelUsage,
  type ModelUsageSummary,
} from "@zcode/contracts";
import type { ResolvedTurnAttachment } from "../types.js";
import { createChildTraceContext, createMessageId, createPartId, TurnMachineImpl } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { ExternalAgentToolRows } from "./external-agent-tool-rows.js";
import { answerExternalAgentPermission } from "./external-agent-permission.js";
import { setExternalAgentSessionTitle } from "./session-title.js";
import { recordModelHistoryRound } from "./turn-loop-state.js";
import { createModelStreamingEventQueue } from "./model-streaming-event-queue.js";
import { captureAssistantPersistenceAnchor, persistCompletedAssistantStep } from "./turn-stop.js";
import {
  createTurnCancelledError,
  emptyTokenUsageInfo,
  throwIfTurnAborted,
} from "../helpers/index.js";

const EXTERNAL_AGENT_FAILED_MESSAGE = "External agent turn failed";
const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/s;

/** Why an external-agent model cannot run this turn; undefined when the turn may run. */
export interface ExternalAgentTurnTraits {
  readonly automationId?: string;
  readonly offPeakTaskId?: string;
  readonly offPeakExecutionId?: string;
  readonly botGroupSource?: unknown;
  readonly backgroundSource?: unknown;
  readonly inputVisibility?: string;
  readonly command?: "compact" | "dream";
}

/**
 * Only foreground chat turns run on an external agent. Automations, off-peak tasks, bot turns,
 * background results, runtime continuations and manual compaction/dream need the regular path.
 */
export function externalAgentTurnRefusal(
  agentId: string,
  traits: ExternalAgentTurnTraits,
): CoreError | undefined {
  const what = traits.command
    ? `/${traits.command}`
    : traits.automationId !== undefined
      ? "automation turns"
      : traits.offPeakTaskId !== undefined || traits.offPeakExecutionId !== undefined
        ? "off-peak tasks"
        : traits.botGroupSource !== undefined
          ? "bot turns"
          : traits.backgroundSource !== undefined
            ? "background results"
            : traits.inputVisibility === "model-only"
              ? "runtime continuations"
              : undefined;
  if (what === undefined) return undefined;
  return createCoreError(
    CoreErrorType.ModelError,
    `ACP agent ${agentId} runs only interactive chat turns; ${what} need a ZCode model. Switch the model to continue.`,
    { recoverable: true },
  );
}

/** Latest real user input as ACP blocks: the text and the current turn's images. */
export function buildExternalAgentPrompt(
  input: string,
  attachments: readonly ResolvedTurnAttachment[],
): ExternalAgentPromptBlock[] {
  const blocks: ExternalAgentPromptBlock[] = [{ type: "text", text: input }];
  for (const attachment of attachments) {
    const block = attachment.contentBlock;
    if (block.type !== "image") continue;
    const match = DATA_URL_PATTERN.exec(block.dataUrl);
    if (!match) continue;
    blocks.push({ type: "image", mimeType: match[1]!, data: match[2]! });
  }
  return blocks;
}

export async function runExternalAgentTurn(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  driver: ExternalAgentTurnDriver,
  prompt: readonly ExternalAgentPromptBlock[],
): Promise<void> {
  const model = state.model;
  const assistantMessageId = createMessageId();
  const assistantCreatedAt = Date.now();
  const assistantPersistenceAnchor = captureAssistantPersistenceAnchor(this);
  const traceContext = createChildTraceContext(state.turnTraceContext, {
    attributes: {
      providerId: String(model.providerId),
      modelId: String(model.modelId),
      iteration: 0,
    },
  });

  await this.persistAssistantMessage(
    assistantMessageId,
    state.currentUserMessageId,
    assistantCreatedAt,
    undefined,
    traceContext,
    model,
  );
  await this.persistPart(
    {
      id: createPartId(),
      sessionID: this.sessionId,
      messageID: assistantMessageId,
      type: "step-start",
    },
    traceContext,
  );

  const queue = createModelStreamingEventQueue({
    events: state.events,
    runtime: this,
    traceContext,
  });
  // The open segment: text and reasoning since the last tool or plan event. Each tool event closes
  // the segment, so the persisted text parts keep the order the agent produced them in.
  const segment = {
    text: "",
    reasoning: "",
    textOpen: false,
    reasoningOpen: false,
    startedAt: assistantCreatedAt,
    reasoningStartedAt: assistantCreatedAt,
  };
  const response = { text: "", reasoning: "" };
  const enqueue = (payload: Omit<ModelStreamingPayload, "assistantMessageId">) =>
    queue.enqueue({ ...payload, assistantMessageId });
  const closeBlocks = () => {
    if (segment.reasoningOpen) {
      segment.reasoningOpen = false;
      enqueue({ delta: "", done: false, kind: "reasoning_end" });
    }
    if (segment.textOpen) {
      segment.textOpen = false;
      enqueue({ delta: "", done: false, kind: "text_end" });
    }
  };
  const persistParts = async () => {
    const endedAt = Date.now();
    if (segment.reasoning.length > 0) {
      await this.persistPart(
        {
          id: createPartId(),
          sessionID: this.sessionId,
          messageID: assistantMessageId,
          type: "reasoning",
          text: segment.reasoning,
          time: { start: segment.reasoningStartedAt, end: endedAt },
        },
        traceContext,
      );
      response.reasoning += segment.reasoning;
    }
    if (segment.text.length > 0) {
      await this.persistPart(
        {
          id: createPartId(),
          sessionID: this.sessionId,
          messageID: assistantMessageId,
          type: "text",
          text: segment.text,
          time: { start: segment.startedAt, end: endedAt },
        },
        traceContext,
      );
      response.text += segment.text;
    }
    segment.text = "";
    segment.reasoning = "";
    segment.startedAt = endedAt;
    segment.reasoningStartedAt = endedAt;
  };
  // Closes the open segment so the next part starts after the tool or plan rows already persisted.
  const breakSegment = async () => {
    closeBlocks();
    await queue.drain();
    await persistParts();
  };

  const tools = new ExternalAgentToolRows({
    agentId: driver.agentId,
    assistantMessageId,
    runtime: this,
    traceContext,
    turnTraceContext: state.turnTraceContext,
    events: state.events,
  });

  // User-once asks of this turn. A turn ends only after each one is resolved, so the terminal event
  // never precedes the `PermissionResolved` of an ask it cancelled.
  const permissions = new Set<Promise<unknown>>();
  const requestPermission = (ask: ExternalAgentPermissionAsk) => {
    // Chained behind the events the agent sent before the ask, so its tool row already has the kind.
    const answer = pending
      .catch(() => undefined)
      .then(() => answerExternalAgentPermission.call(this, { state, rows: tools }, ask))
      .catch((): ExternalAgentPermissionAnswer => "cancelled");
    permissions.add(answer);
    return answer;
  };
  const settlePermissions = async () => {
    await Promise.allSettled([...permissions]);
  };

  // Every event runs on one chain: streamed text and tool rows keep the agent's wire order.
  let pending: Promise<void> = Promise.resolve();
  const handleEvent = async (event: ExternalAgentTurnEvent): Promise<void> => {
    switch (event.type) {
      case "message_delta": {
        if (segment.reasoningOpen) closeBlocks();
        if (!segment.textOpen) {
          segment.textOpen = true;
          enqueue({ delta: "", done: false, kind: "text_start" });
        }
        segment.text += event.text;
        enqueue({ delta: event.text, done: false, kind: "text_delta" });
        return;
      }
      case "reasoning_delta": {
        if (segment.textOpen) closeBlocks();
        if (!segment.reasoningOpen) {
          segment.reasoningOpen = true;
          enqueue({ delta: "", done: false, kind: "reasoning_start" });
        }
        segment.reasoning += event.text;
        enqueue({ delta: event.text, done: false, kind: "reasoning_delta" });
        return;
      }
      case "tool_call":
      case "tool_call_update":
        await breakSegment();
        await tools.apply(event.update, event.type === "tool_call_update");
        return;
      case "plan":
        await breakSegment();
        await tools.applyPlan(event.entries);
        return;
      case "session_title":
        await setExternalAgentSessionTitle.call(this, {
          title: event.title,
          traceContext: state.turnTraceContext,
        });
        return;
    }
  };
  const onEvent = (event: ExternalAgentTurnEvent) => {
    pending = pending.then(() => handleEvent(event));
    // A failed handler surfaces once, when the turn awaits `pending`; this keeps it from being unhandled.
    pending.catch(() => undefined);
  };

  const closeInterrupted = async (finish: "error" | "cancelled") => {
    closeBlocks();
    await queue.drain().catch(() => undefined);
    await persistParts();
    await this.persistAssistantMessage(
      assistantMessageId,
      state.currentUserMessageId,
      assistantCreatedAt,
      { completed: Date.now(), finish, tokens: emptyTokenUsageInfo() },
      traceContext,
      model,
    );
    state.modelResponse = response.text;
  };

  let outcome: ExternalAgentTurnResult;
  try {
    outcome = await driver.runTurn({
      sessionId: this.sessionId,
      workingDirectory: this.workingDirectory,
      prompt,
      signal: state.turnAbortSignal,
      onEvent,
      requestPermission,
    });
    await pending;
  } catch (error) {
    await pending.catch(() => undefined);
    await settlePermissions();
    const cancelled = state.turnAbortSignal.aborted;
    await tools.closeOpen(
      cancelled ? "Cancelled" : "The agent turn failed before this tool finished",
    );
    await closeInterrupted(cancelled ? "cancelled" : "error");
    if (cancelled) throwIfTurnAborted(state.turnAbortSignal);
    this.logger?.warn("External agent turn failed", {
      agentId: driver.agentId,
      event: "external_agent.turn.failed",
      module: "core.runtime",
      status: "failed",
    });
    throw toExternalAgentTurnError(error);
  }

  if (state.turnAbortSignal.aborted || outcome.stopReason === "cancelled") {
    await settlePermissions();
    await tools.closeOpen("Cancelled");
    await closeInterrupted("cancelled");
    throwIfTurnAborted(state.turnAbortSignal);
    throw createTurnCancelledError(new Error("External agent cancelled the prompt"));
  }

  state.externalAgentUsage = outcome.usage;
  closeBlocks();
  enqueue({ delta: "", done: true, kind: "finish" });
  await queue.drain();
  await settlePermissions();
  await tools.closeOpen("The agent turn ended before this tool finished");
  await persistParts();

  state.modelResponse = response.text;
  const result: RuntimeModelTextResult = {
    text: response.text,
    reasoning: response.reasoning ? [reasoningBlock(response.reasoning)] : [],
    finishReason: outcome.stopReason,
    usage: (outcome.usage ?? {}) as ModelUsage,
    toolCalls: [],
  };
  const committed = await persistCompletedAssistantStep(this, state, {
    assistantPersistenceAnchor,
    assistantCreatedAt,
    assistantMessageId,
    includeEmptyAssistant: true,
    modelTraceContext: traceContext,
    result,
  });
  if (committed) recordModelHistoryRound(state);
  state.stableProductStartMessageId = state.currentUserMessageId;
  state.stableBoundaryAssistantMessageId = assistantMessageId;
  if (state.activeTurn) state.activeTurn.steerable = false;
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.complete(state.modelResponse, "success"),
  );
}

/** Turn-level summary of an external agent's reported usage (labelled `external-agent`). */
export function externalAgentUsageSummary(usage: ModelUsage | undefined): ModelUsageSummary | undefined {
  if (usage === undefined) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return {
    source: "external-agent",
    modelRequestCount: 1,
    inputTokens,
    outputTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    webSearchRequests: 0,
    webFetchRequests: 0,
  };
}

function reasoningBlock(text: string): ModelReasoningContentBlock {
  return { type: "reasoning", text } as ModelReasoningContentBlock;
}

/** Driver failures keep their user-facing message; anything else gets the generic wording. */
function toExternalAgentTurnError(error: unknown): CoreError {
  if (error instanceof ExternalAgentTurnError) {
    return createCoreError(CoreErrorType.ModelError, error.message, {
      cause: error,
      recoverable: true,
    });
  }
  return createCoreError(CoreErrorType.ModelError, EXTERNAL_AGENT_FAILED_MESSAGE, {
    cause: error instanceof Error ? error : undefined,
    recoverable: true,
  });
}
