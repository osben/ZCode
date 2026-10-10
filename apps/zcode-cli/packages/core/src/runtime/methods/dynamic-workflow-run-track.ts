import { CREATE_WORKFLOW_TOOL_NAME, type TraceContext } from "@zcode/contracts";
import type { ExecutableToolCall } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * Re-enrolls a **resumed** dwf run in background tracking.
 *
 * The submit path is tracked automatically by the tool executor when CreateWorkflow returns backgrounded. Resume
 * is a v4 command with no in-flight tool call, so nothing handles four things: runtime-task registry registration (**session
 * reclamation guard**—without it, a session with a running task is reclaimed as idle and completion notifications have nowhere to go), BackgroundTaskStarted
 * (the backgroundWorks panel and cancellable flag), polling/terminal waiter, and settlement notification. This method synthesizes a
 * tool descriptor and uses the executor's same trackBackgroundTask path to restore all four at once.
 *
 * Descriptor-field choices:
 *   - `id` uses the **original toolCallId** (restored from dwf_run.tool_call_id) as the association key between the tool card and detail page,
 *     and as registry parentToolCallId. If an old run has none, synthesize a resume-prefixed id (observable and not impersonating a real tool row).
 *   - `name` is always CreateWorkflow: per-tool lifecycle dispatch (snapshot/wait/cancel/notification format) looks up behavior by this name.
 *   - `input.name` feeds the display-name fallback chain (workflowTaskSubject). The resume command may provide it; if absent,
 *     the tracker falls back to taskId, and the UI handles it as fallbackName (same semantics as submit).
 *
 * turnId is deliberately absent: resume is initiated by a UI command, not by a model turn (same reasoning as rootTraceContext
 * for run progress events; see dynamic-workflow-run-progress.ts).
 */
export async function trackResumedDynamicWorkflowRun(
  this: AgentRuntimeInternal,
  input: { runId: string; toolCallId?: string; name?: string; traceContext?: TraceContext },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const toolCall: ExecutableToolCall = {
    id: input.toolCallId ?? `resume-${input.runId}`,
    name: CREATE_WORKFLOW_TOOL_NAME,
    input: input.name === undefined ? {} : { name: input.name },
  };
  await this.executor.trackExternalBackgroundTask(
    toolCall,
    { backgroundTaskId: input.runId, status: "backgrounded" },
    traceContext,
    undefined,
  );
}
