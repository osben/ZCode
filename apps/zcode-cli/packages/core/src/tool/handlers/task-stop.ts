import {
  CoreErrorType,
  TASK_STOP_TOOL_NAME,
  TaskStopInputJsonSchema,
  TaskStopInputSchema,
  TaskStopOutputJsonSchema,
  TaskStopOutputSchema,
  createCoreError,
  type TaskStopInput,
  type TaskStopOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";

const MAX_TASK_STOP_MODEL_BYTES = 100_000;
const TASK_STOP_LOOKUP_FAILURE_GUIDANCE =
  "This lookup failure does not mean the task has completed or stopped; use the full task_id returned when the task started to stop it.";

// Provider requests use metadata.description directly; a short internal summary would hide parameters, return values, and usage
// context from the model. Keep the short summary for the capability.
const TASK_STOP_PROVIDER_DESCRIPTION = [
  "",
  "- Stops a running background task by its ID",
  "- Takes a task_id parameter identifying the task to stop",
  "- Returns a success or failure status",
  "- Use this tool when you need to terminate a long-running task",
  "",
].join("\n");

const taskStopHandler: ToolHandler = async (input, context) => {
  const parsed = TaskStopInputSchema.parse(input) as TaskStopInput;
  const taskId = parsed.task_id ?? parsed.shell_id;
  if (!taskId) {
    return taskStopFailure(1, "Missing required parameter: task_id");
  }

  if (!context.backgroundTaskControlPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Background task control is not configured for TaskStop",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: TASK_STOP_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const result = await context.backgroundTaskControlPort.stopBackgroundTask(taskId, {
    // Stopped by the model itself: the terminal notification is written as model-initiated
    // (sub-agent reads "was stopped by ZCode", workflow reads "was stopped by you (TaskStop)",
    // background commands just say "was stopped"), not as the user's decision.
    initiator: "model",
    strict: true,
    traceContext: context.traceContext,
  });
  if (!result.ok) {
    if (result.reason === "background_task_not_running") {
      return taskStopFailure(
        3,
        `Task ${taskId} is not running (status: ${result.status ?? "unknown"})`,
      );
    }
    if (result.reason === "background_task_cancel_not_supported") {
      throw taskStopError(`Task ${taskId} cannot be stopped`, 1, {
        reason: result.reason,
        status: result.status,
        taskId,
        taskType: result.type,
        toolCallId: context.toolCallId,
      });
    }
    // A bare "task not found" is easily misread by the model as already stopped; state clearly that the lookup failed (not a terminal state) and require the full ID.
    return taskStopFailure(
      1,
      `No task found with ID: ${taskId}. ${TASK_STOP_LOOKUP_FAILURE_GUIDANCE}`,
    );
  }

  const taskType = result.type ?? "background_task";
  const output: TaskStopOutput = {
    message: `Successfully stopped task: ${result.taskId} (${result.command ?? taskType})`,
    task_id: result.taskId,
    task_type: taskType,
    ...(result.command ? { command: result.command } : {}),
  };
  return output;
};

export const taskStopToolEntry: ToolEntry = {
  aliases: ["KillShell", "KillBash"],
  capability: "Stop a running background task by ID",
  metadata: {
    shouldDefer: true,
    name: TASK_STOP_TOOL_NAME,
    searchHint: "kill a running background task",
    description: TASK_STOP_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10000,
    maxOutputBytes: MAX_TASK_STOP_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: taskStopHandler,
  formatModelContent: formatTaskStopModelContent,
  inputSchema: TaskStopInputJsonSchema,
  outputSchema: TaskStopOutputJsonSchema,
  runtimeInputSchema: TaskStopInputSchema,
  runtimeOutputSchema: TaskStopOutputSchema,
  permission: {
    permission: "backgroundTask.stop",
    reason: "TaskStop stops a running background task in the current runtime",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_TASK_STOP_MODEL_BYTES,
    maxModelBytes: MAX_TASK_STOP_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_TASK_STOP_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10000,
    maxMs: 10000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "TaskStop was cancelled before the stop request completed",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatTaskStopModelContent(output: unknown): string {
  return JSON.stringify(TaskStopOutputSchema.parse(output));
}

// 修复原因：找不到任务、任务已结束、缺少 task_id 原来都是抛出的异常，模型收到不带 <tool_use_error> 的原文；
// 它们是可预期的输入或状态错误，现在返回失败由 executor 包装（00-tool-change-chain.md「TaskStop 查找失败提示」）。
function taskStopFailure(errorCode: 1 | 3, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

function taskStopError(message: string, code: 1 | 3, context: Record<string, unknown>): Error {
  return createCoreError(CoreErrorType.ToolExecutionFailed, message, {
    context: {
      ...context,
      code,
      toolName: TASK_STOP_TOOL_NAME,
    },
    recoverable: true,
  });
}
