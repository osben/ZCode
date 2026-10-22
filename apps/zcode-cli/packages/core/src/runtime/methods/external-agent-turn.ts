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
  type ExternalAgentPromptBlock,
  type ExternalAgentTurnDriver,
  type ExternalAgentTurnEvent,
  type ExternalAgentTurnResult,
  type ModelReasoningContentBlock,
  type ModelStreamingPayload,
  type ModelUsage,
} from "@zcode/contracts";
import type { ResolvedTurnAttachment } from "../types.js";
import { createChildTraceContext, createMessageId, createPartId, TurnMachineImpl } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
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
  const stream = {
    text: "",
    reasoning: "",
    textOpen: false,
    reasoningOpen: false,
    reasoningStartedAt: assistantCreatedAt,
  };
  const enqueue = (payload: Omit<ModelStreamingPayload, "assistantMessageId">) =>
    queue.enqueue({ ...payload, assistantMessageId });
  const closeBlocks = () => {
    if (stream.reasoningOpen) {
      stream.reasoningOpen = false;
      enqueue({ delta: "", done: false, kind: "reasoning_end" });
    }
    if (stream.textOpen) {
      stream.textOpen = false;
      enqueue({ delta: "", done: false, kind: "text_end" });
    }
  };
  const onEvent = (event: ExternalAgentTurnEvent) => {
    if (event.type === "message_delta") {
      if (stream.reasoningOpen) closeBlocks();
      if (!stream.textOpen) {
        stream.textOpen = true;
        enqueue({ delta: "", done: false, kind: "text_start" });
      }
      stream.text += event.text;
      enqueue({ delta: event.text, done: false, kind: "text_delta" });
      return;
    }
    if (stream.textOpen) closeBlocks();
    if (!stream.reasoningOpen) {
      stream.reasoningOpen = true;
      enqueue({ delta: "", done: false, kind: "reasoning_start" });
    }
    stream.reasoning += event.text;
    enqueue({ delta: event.text, done: false, kind: "reasoning_delta" });
  };

  const persistParts = async () => {
    const endedAt = Date.now();
    if (stream.reasoning.length > 0) {
      await this.persistPart(
        {
          id: createPartId(),
          sessionID: this.sessionId,
          messageID: assistantMessageId,
          type: "reasoning",
          text: stream.reasoning,
          time: { start: stream.reasoningStartedAt, end: endedAt },
        },
        traceContext,
      );
    }
    if (stream.text.length > 0) {
      await this.persistPart(
        {
          id: createPartId(),
          sessionID: this.sessionId,
          messageID: assistantMessageId,
          type: "text",
          text: stream.text,
          time: { start: assistantCreatedAt, end: endedAt },
        },
        traceContext,
      );
    }
  };

  // Partial output stays visible when the turn ends early; the assistant step is closed as failed
  // or cancelled and never joins the history that a later non-ACP model sees.
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
    state.modelResponse = stream.text;
  };

  let outcome: ExternalAgentTurnResult;
  try {
    outcome = await driver.runTurn({
      sessionId: this.sessionId,
      workingDirectory: this.workingDirectory,
      prompt,
      signal: state.turnAbortSignal,
      onEvent,
    });
  } catch (error) {
    await closeInterrupted(state.turnAbortSignal.aborted ? "cancelled" : "error");
    if (state.turnAbortSignal.aborted) throwIfTurnAborted(state.turnAbortSignal);
    this.logger?.warn("External agent turn failed", {
      agentId: driver.agentId,
      event: "external_agent.turn.failed",
      module: "core.runtime",
      status: "failed",
    });
    throw toExternalAgentTurnError(error);
  }

  if (state.turnAbortSignal.aborted || outcome.stopReason === "cancelled") {
    await closeInterrupted("cancelled");
    throwIfTurnAborted(state.turnAbortSignal);
    throw createTurnCancelledError(new Error("External agent cancelled the prompt"));
  }

  closeBlocks();
  enqueue({ delta: "", done: true, kind: "finish" });
  await queue.drain();
  await persistParts();

  state.modelResponse = stream.text;
  const result: RuntimeModelTextResult = {
    text: stream.text,
    reasoning: stream.reasoning ? [reasoningBlock(stream.reasoning)] : [],
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
