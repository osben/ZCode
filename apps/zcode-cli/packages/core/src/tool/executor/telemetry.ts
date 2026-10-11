import type { ToolExecutionSpanWriter } from "@zcode/contracts";
import type { ExecutableToolCall, ToolExecutionResult } from "../types.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";

export async function runToolCallWithTelemetry(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  options: ToolExecuteOptions | undefined,
  execute: (telemetry: ToolExecutionSpanWriter | undefined) => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  const scope = deps.agentTelemetry?.startTool({
    registeredToolName: toolCall.name,
    toolCallId: toolCall.id,
  });
  if (!scope) return execute(undefined);
  return scope.run(async () => {
    try {
      return await execute(scope);
    } catch (error) {
      // The business executor closes spans based on actual outcomes on every normal
      // return path. Handle only unstructured exceptions thrown directly while
      // publishing ToolCallStarted/Error events, so the span does not end up marked
      // missing_terminal.
      if (options?.signal?.aborted) {
        scope.finishCancelled("abort_signal");
      } else {
        scope.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}
