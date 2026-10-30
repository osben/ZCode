import { SessionEventType } from "../deps.js";
import type { ModelToolCall, TraceContext } from "../deps.js";
import {
  buildRepeatedToolCallReminderBody,
  buildToolCallBudgetReminderBody,
  detectRepeatedToolCallWarnings,
  detectToolCallBudgetWarning,
} from "../helpers/index.js";
import {
  buildToolCallRotationReminderBody,
  createToolLoopHistory,
  isPollingToolCall,
  recordToolCallRotation,
} from "../helpers/tool-loop-patterns.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { systemReminderAttachmentEntry, toModelToolCall } from "../../agent/message-history.js";
import type { ToolExecutionResult } from "../../tool/types.js";
import { commitTurnRequestEntries } from "./turn-output-token-continuation.js";

export async function handleToolCallAnomalyWarnings(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: {
    modelTraceContext: TraceContext;
    results: readonly ToolExecutionResult[];
    toolCalls: ModelToolCall[];
  },
): Promise<void> {
  const budgetWarning = detectToolCallBudgetWarning(
    state.toolCallCount,
    options.toolCalls.length,
    state,
    runtime.config.modelAnomalyGuard,
  );
  if (budgetWarning) {
    if (budgetWarning.warningInjected) {
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        systemReminderAttachmentEntry(
          "model_anomaly",
          buildToolCallBudgetReminderBody(budgetWarning.observedCount),
        ),
      ]);
    }
    const warningEvent = runtime.createEvent(
      SessionEventType.ModelAnomalyWarning,
      {
        category: "tool_call_budget",
        severity: "warning",
        observedCount: budgetWarning.observedCount,
        threshold: budgetWarning.threshold,
        warningInjected: budgetWarning.warningInjected,
      },
      options.modelTraceContext,
    );
    await runtime.appendEvent(warningEvent, options.modelTraceContext);
    state.events.push(warningEvent);
  }

  const resultByToolCallId = new Map<string, ToolExecutionResult>();
  for (const result of options.results) {
    resultByToolCallId.set(result.toolCallId, result);
  }
  // Polling-shaped calls are transparent: they neither advance nor reset the streak or the rotation window.
  const loopToolCalls = options.toolCalls.filter(
    (toolCall) =>
      !isPollingToolCall(
        toolCall.name,
        toolCall.input,
        resultByToolCallId.get(toolCall.id),
      ),
  );

  const repeatedWarnings = detectRepeatedToolCallWarnings(
    loopToolCalls.map(toModelToolCall),
    state,
    runtime.config.modelAnomalyGuard,
  );
  for (const warning of repeatedWarnings) {
    if (warning.warningInjected) {
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        systemReminderAttachmentEntry(
          "model_anomaly",
          buildRepeatedToolCallReminderBody(warning.toolName, warning.observedCount),
        ),
      ]);
    }
    const warningEvent = runtime.createEvent(
      SessionEventType.ModelAnomalyWarning,
      {
        category: "repeated_tool_call",
        severity: "warning",
        observedCount: warning.observedCount,
        threshold: warning.threshold,
        toolCallId: warning.toolCallId,
        toolName: warning.toolName,
        warningInjected: warning.warningInjected,
      },
      options.modelTraceContext,
    );
    await runtime.appendEvent(warningEvent, options.modelTraceContext);
    state.events.push(warningEvent);
  }

  state.toolLoopHistory ??= createToolLoopHistory();
  for (const toolCall of loopToolCalls.map(toModelToolCall)) {
    const rotation = recordToolCallRotation(
      state.toolLoopHistory,
      {
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
        modelStepIndex: state.modelStepCount,
      },
      state,
      runtime.config.modelAnomalyGuard,
    );
    if (!rotation) continue;
    if (rotation.warningInjected) {
      commitTurnRequestEntries(runtime, state.turnRequestState, [
        systemReminderAttachmentEntry(
          "model_anomaly",
          buildToolCallRotationReminderBody(rotation.toolNames, rotation.period, rotation.cycles),
        ),
      ]);
    }
    const warningEvent = runtime.createEvent(
      SessionEventType.ModelAnomalyWarning,
      {
        category: "tool_call_rotation",
        severity: "warning",
        observedCount: rotation.cycles,
        threshold: rotation.threshold,
        toolCallId: rotation.toolCallId,
        toolName: rotation.toolName,
        warningInjected: rotation.warningInjected,
      },
      options.modelTraceContext,
    );
    await runtime.appendEvent(warningEvent, options.modelTraceContext);
    state.events.push(warningEvent);
    runtime.logger?.info("Model tool-call rotation warning emitted", {
      event: "model_anomaly.tool_rotation",
      module: "core.runtime",
      period: rotation.period,
      toolNames: rotation.toolNames,
      cycles: rotation.cycles,
      warningInjected: rotation.warningInjected,
    });
  }
}
