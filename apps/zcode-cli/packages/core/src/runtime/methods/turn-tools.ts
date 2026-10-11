import { createPartId, TurnMachineImpl } from "../deps.js";
import type {
  MessageId,
  ModelToolCall,
  ToolCallId,
  TraceContext,
  ToolCall,
  ToolExecutionResult,
} from "../deps.js";
import { emitStreamingToolLedgerUpdate, toRecordInput } from "../helpers/index.js";
import type { RuntimeModelTextResult, StreamedToolExecutionResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { emitSyntheticStreamedToolError } from "./streaming-tool-synthetic-result.js";
import {
  persistPendingToolPart,
  projectToolNameForNonEmptyBoundary,
} from "./tool-part-persistence.js";
import { persistToolModelStepFinish } from "./turn-step-finish.js";
import { mcpToolPartMetadata } from "./tool-part-metadata.js";
import { drainInlineGuideForNextRequest } from "./turn-guide-drain.js";
import { handleToolCallAnomalyWarnings } from "./turn-tool-warnings.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import {
  isAutomationMutationRestrictedTurn,
  isOffPeakCreateRestrictedTurn,
  recordCompletedToolBatch,
} from "./turn-loop-state.js";
import { settleToolResults, type ToolResultPart } from "./tool-result-settlement.js";

export async function executeToolCallsForModelStep(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    modelTraceContext: TraceContext;
    result: RuntimeModelTextResult;
    streamedToolResults?: StreamedToolExecutionResult[];
    toolCalls: ModelToolCall[];
  },
): Promise<"continue" | "break"> {
  const model = state.model;
  if (!model) {
    throw new Error("Model-backed tool execution requires the loop Model");
  }
  const coreToolCalls: ToolCall[] = options.toolCalls.map((tc) => ({
    id: tc.id as ToolCallId,
    // Model-step admission already validated the type/ID; preserve the recoverable original blank name here
    // so the executor hits a registry miss instead of treating the storage placeholder as a real tool.
    name: tc.name,
    input: tc.input,
  }));
  const streamedResultsById = new Map(
    (options.streamedToolResults ?? []).map((entry) => [entry.toolCallId, entry]),
  );
  const toolCallById = new Map(coreToolCalls.map((toolCall) => [toolCall.id, toolCall]));
  const toolParts = new Map<string, ToolResultPart>();
  for (const [declarationIndex, toolCall] of coreToolCalls.entries()) {
    const streamed = streamedResultsById.get(toolCall.id as ToolCallId);
    if (streamed) {
      toolParts.set(toolCall.id, {
        declarationIndex,
        partID: streamed.partID,
        input: streamed.input,
        startedAt: streamed.result.startedAt.getTime(),
      });
      if (streamed.ledgerRecorded === false) {
        await persistPendingToolPart(this, {
          assistantMessageId: options.assistantMessageId,
          declarationIndex,
          input: streamed.input,
          partID: streamed.partID,
          toolCall,
          traceContext: options.modelTraceContext,
          model,
          metadata: mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
        });
        await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
          assistantMessageId: options.assistantMessageId,
          toolCall,
          status: "tool_call_closed",
          executionTiming: "during_stream",
          input: streamed.input,
        });
        await emitSyntheticStreamedToolError(
          this,
          state.events,
          options.modelTraceContext,
          streamed.result,
        );
      }
      continue;
    }
    const partID = createPartId();
    const normalizedInput = toRecordInput(toolCall.input);
    toolParts.set(toolCall.id, {
      declarationIndex,
      partID,
      input: normalizedInput,
      startedAt: Date.now(),
    });
    await persistPendingToolPart(this, {
      assistantMessageId: options.assistantMessageId,
      declarationIndex,
      input: normalizedInput,
      partID,
      toolCall,
      traceContext: options.modelTraceContext,
      model,
      metadata: mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation),
    });
    await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
      assistantMessageId: options.assistantMessageId,
      toolCall,
      status: "tool_call_closed",
      input: normalizedInput,
    });
  }

  // Once assistant tool_use is in history, Stop must not throw before creating tool results.
  // Pass the aborted signal to the executor so the existing cancellation path creates a ToolCancelled result
  // for every tool call, then lets the turn loop observe the abort.
  const schedule = await this.scheduleTools(coreToolCalls);
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.scheduleTools(coreToolCalls, this.toScheduleState(schedule)),
  );
  const pendingToolCalls = coreToolCalls.filter(
    (toolCall) => !streamedResultsById.has(toolCall.id as ToolCallId),
  );
  let pendingExecutionResults: ToolExecutionResult[] = [];
  state.turnMachine = new TurnMachineImpl(state.turnMachine.startToolExecution());
  if (pendingToolCalls.length > 0) {
    const pendingSchedule =
      pendingToolCalls.length === coreToolCalls.length
        ? schedule
        : await this.scheduleTools(pendingToolCalls);
    const scheduledEvents = await this.emitToolScheduledEvents(
      pendingToolCalls,
      pendingSchedule,
      options.assistantMessageId,
      options.modelTraceContext,
    );
    state.events.push(...scheduledEvents);
    for (const toolCall of pendingToolCalls) {
      await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
        assistantMessageId: options.assistantMessageId,
        toolCall,
        status: "tool_queued",
        input: toolParts.get(toolCall.id)?.input,
      });
    }

    this.logger?.debug("Executing tools", {
      streamedToolCallCount: streamedResultsById.size,
      toolCallCount: pendingToolCalls.length,
      tools: pendingToolCalls.map((tc) => tc.name),
    });
    const execution = await this.executeTools(pendingToolCalls, pendingSchedule, {
      automationTurn: isAutomationMutationRestrictedTurn(state),
      offPeakTurn: isOffPeakCreateRestrictedTurn(state),
      signal: state.turnAbortSignal,
      traceContext: options.modelTraceContext,
      subagentModelOverride: state.subagentModelOverride,
      model: state.model,
      onBatchStart: async (toolCallIds) => {
        // The executor still returns cancelled results for an aborted batch, but tool parts that never entered
        // a handler must not be incorrectly marked running.
        if (state.turnAbortSignal?.aborted) return;
        for (const toolCallId of toolCallIds) {
          const toolCall = toolCallById.get(toolCallId as ToolCallId);
          if (!toolCall) continue;
          const persisted = toolParts.get(toolCall.id);
          if (!persisted) continue;
          persisted.startedAt = Date.now();
          const projectedToolName = projectToolNameForNonEmptyBoundary(toolCall.name);
          await this.persistPart(
            {
              id: persisted.partID,
              sessionID: this.sessionId,
              messageID: options.assistantMessageId,
              type: "tool",
              callID: toolCall.id,
              declarationIndex: persisted.declarationIndex,
              tool: projectedToolName.toolName,
              metadata: projectedToolName.metadata,
              state: {
                status: "running",
                input: persisted.input,
                title: projectedToolName.toolName,
                metadata:
                  mcpToolPartMetadata(this.registry.getMetadata(toolCall.name)?.mcpPresentation) ??
                  {},
                time: {
                  start: persisted.startedAt,
                },
              },
            },
            options.modelTraceContext,
          );
          await emitStreamingToolLedgerUpdate(this, state.events, options.modelTraceContext, {
            assistantMessageId: options.assistantMessageId,
            toolCall,
            status: "tool_started",
            input: persisted.input,
            startedAt: new Date(persisted.startedAt),
          });
        }
      },
    });
    pendingExecutionResults = execution.results;
    state.events.push(...execution.events);
  }
  const resultById = new Map<string, ToolExecutionResult>();
  for (const streamed of streamedResultsById.values()) {
    resultById.set(streamed.result.toolCallId, streamed.result);
  }
  for (const pending of pendingExecutionResults) {
    resultById.set(pending.toolCallId, pending);
  }
  const results = coreToolCalls
    .map((toolCall) => resultById.get(toolCall.id))
    .filter((result): result is ToolExecutionResult => result !== undefined);
  await settleToolResults.call(this, state, {
    assistantMessageId: options.assistantMessageId,
    modelTraceContext: options.modelTraceContext,
    results,
    toolParts,
    toolCallById,
    streamedResultsById,
  });


  const stopTurnResult = results.find((result) => result.turnControl?.stopTurnAfterResult === true);
  if (stopTurnResult) {
    await persistToolModelStepFinish(this, state, options);
    if (stopTurnResult.turnControl?.reason === "automation_create_limit") {
      // Only the user can free a slot after the limit is reached. Passing an ordinary error back to the model
      // causes repeated List/Delete/Create calls or even attempts to bypass it with Bash. End the current turn with one text response only.
      state.automationCreateLimitReached = true;
      recordCompletedToolBatch(state);
      this.logger?.info("Automation create limit switched turn to text-only response", {
        event: "automation.create_limit.text_only_continuation",
        module: "core.runtime",
        reason: stopTurnResult.turnControl.reason,
        status: "completed",
        toolCallId: stopTurnResult.toolCallId,
        toolName: stopTurnResult.toolName,
      });
      return "continue";
    }
    if (state.activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn: state.activeTurn,
        events: state.events,
        reasonCode: "guide.noToolBoundary",
        traceContext: state.turnTraceContext,
      });
    }
    this.logger?.info("Tool result requested turn stop", {
      event: "tool.turn_control.stop",
      module: "core.runtime",
      reason: stopTurnResult.turnControl?.reason,
      status: "completed",
      toolCallId: stopTurnResult.toolCallId,
      toolName: stopTurnResult.toolName,
    });
    if (state.activeTurn) state.activeTurn.steerable = false;
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.complete(state.modelResponse, "success"),
    );
    return "break";
  }

  await handleToolCallAnomalyWarnings(this, state, {
    modelTraceContext: options.modelTraceContext,
    toolCalls: options.toolCalls,
  });
  await persistToolModelStepFinish(this, state, options);
  if (coreToolCalls.length > 0 && results.length === coreToolCalls.length) {
    state.completedRealToolResultBatch = true;
  }
  await drainInlineGuideForNextRequest(this, state);
  recordCompletedToolBatch(state);
  this.logger?.debug("After inject, message count", {
    compactToolTurnsSinceLastCompact: state.compactTracking?.toolTurnsSinceCompact,
    count: this.messageHistory.getMessageCount(),
    reactiveCompactAttemptedInCurrentModelStep: state.reactiveCompactAttemptedInCurrentModelStep,
  });
  return "continue";
}

