import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
} from "@zcode/contracts";
import type {
  ExecutionPort,
  DynamicWorkflowRunSnapshot,
  SubagentTaskSnapshot,
  WorkflowTaskSnapshot,
} from "@zcode/contracts";
import {
  isTerminalRuntimeTask,
  type RuntimeTaskSnapshot,
  type RuntimeTaskType,
} from "../../runtime-task/registry.js";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import { serializeWorkflowArtifact } from "./workflow-artifact.js";

type BackgroundTaskSnapshot =
  | NonNullable<Awaited<ReturnType<NonNullable<ExecutionPort["getBackgroundTask"]>>>>
  | SubagentTaskSnapshot
  | WorkflowTaskSnapshot
  // A workflow-run snapshot reuses WorkflowTaskSnapshot's shape but widens output to
  // unknown (the artifact is determined by the script's top-level return value), so it
  // is not a subtype of WorkflowTaskSnapshot and must be listed separately.
  | DynamicWorkflowRunSnapshot;

/**
 * Name-dispatch predicate for dwf runs: CreateWorkflow starts a run and
 * ResumeWorkflowRun resumes it. They are two entry points into the same run lifecycle,
 * so snapshots, waiting, cancellation, notifications, and registry behavior are shared.
 *
 * Note: the CreateWorkflow approval-dialog Refine special cases
 * (product-projection.ts / turn-control.ts) deliberately do **not** use this predicate.
 * ResumeWorkflowRun has no causalityGraph or graph refinement in its dialog and uses the
 * default ask behavior. Adding its name to those special cases would expose a Refine
 * option without a graph.
 */
export function isDynamicWorkflowRunDispatchToolName(name: string): boolean {
  return (
    name === CREATE_WORKFLOW_TOOL_NAME ||
    name === AMEND_WORKFLOW_TOOL_NAME ||
    name === RESUME_WORKFLOW_RUN_TOOL_NAME
  );
}

export function registerRuntimeBackgroundTask(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  output: Record<string, unknown>,
  turnId?: RuntimeTaskSnapshot["turnId"],
): void {
  const taskType = runtimeTaskTypeForToolCall(toolCall);
  if (!taskType || !deps.runtimeTaskRegistry) return;
  const existing = deps.runtimeTaskRegistry.get(taskId);
  const description = runtimeTaskDescription(toolCall, output) ?? defaultRuntimeTaskDescription(taskType);
  const outputFile = backgroundTaskOutputMetadata(output).outputFile;
  // When a terminal task is resumed in the same process without restarting (rearming a
  // dwf run; the v4 command path and tool path converge in trackBackgroundTask), the
  // existing entry carries notified:true from the previous claim. Preserving it would
  // make claimRuntimeBackgroundTaskNotification reject the restored run's terminal
  // model notification. Stale error/completedAt/resultText would also leak through the
  // `?? current.*` chain in updateRuntimeBackgroundTask into the new running entry.
  // Therefore rearming resets the **settlement fields** (notified/completedAt/error/
  // exitCode/resultText/pid), while preserving the **identity fields** with
  // existing ?? new (agentId/agentType/parentToolCallId/turnId/description/startedAt).
  // parentToolCallId anchors the tool-card-to-details flow across resume; replacing it
  // with this rearm descriptor's id would break the join.
  //
  // Reset only at the **rearm boundary**: only dwf dispatch names reuse the same runId
  // across resume and start a new lifecycle from a terminal entry. In that case the
  // previous lifecycle's notified flag must be invalidated. Single-lifecycle tasks such
  // as Bash/Agent discard their task ids after one run, but a late-mounted tracker may
  // register against an already-claimed terminal entry (notified:true). That is the
  // claim token for the **same** lifecycle; resetting indiscriminately would enqueue the
  // same terminal model notification twice. “The bug is name-independent” refers to
  // reachable paths (the v4 command path also rearms through the CreateWorkflow name),
  // not to resetting every registration.
  //
  // Deliberately do **not** reset outputFile with settlement fields: workflow runs never
  // write it, and the existing-value fallback is reserved for future artifact
  // externalization. Revisit it when externalization is implemented; do not clear it or
  // broaden its semantics as a side effect.
  const rearm = isDynamicWorkflowRunDispatchToolName(toolCall.name);
  // A new life means rearming a **terminal** entry. It must use register(), not update():
  // register stamps the current activeBranchGeneration, while update's {...existing}
  // would carry the previous lifecycle's branch generation into the new one. On
  // cancel → rewind (branch generation +1) → resume, runtime-command-generation would
  // then discard the new task's events as stale-branch residue, losing the terminal
  // notification again. An existing running entry is not a new life and keeps update's
  // merge semantics and its branch generation.
  const newLife = rearm && existing !== undefined && isTerminalRuntimeTask(existing);
  const next: RuntimeTaskSnapshot = {
    ...existing,
    agentId: existing?.agentId ?? taskId,
    agentType: existing?.agentType ?? taskType,
    description: existing?.description ?? description,
    isBackgrounded: true,
    outputFile: outputFile ?? existing?.outputFile,
    parentToolCallId: existing?.parentToolCallId ?? toolCall.id,
    startedAt: existing?.startedAt ?? new Date(),
    status: "running",
    taskId,
    taskType,
    type: taskType,
    turnId: existing?.turnId ?? turnId,
    // Reset settlement fields only when rearming starts a new lifecycle; preserve them when reattaching without rearming.
    notified: rearm ? false : (existing?.notified ?? false),
    completedAt: rearm ? undefined : existing?.completedAt,
    error: rearm ? undefined : existing?.error,
    exitCode: rearm ? undefined : existing?.exitCode,
    resultText: rearm ? undefined : existing?.resultText,
    pid: rearm ? undefined : existing?.pid,
    // The previous lifecycle's stop initiator does not apply to the new one.
    stopInitiator: rearm ? undefined : existing?.stopInitiator,
  };
  if (existing && !newLife) {
    deps.runtimeTaskRegistry.update(taskId, () => next);
    return;
  }
  // First registration or a new lifecycle: remove the inherited branchGeneration and let register stamp the current active branch.
  const { branchGeneration: _previousLife, ...fresh } = next;
  deps.runtimeTaskRegistry.register(fresh);
}

export function updateRuntimeBackgroundTask(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot?: BackgroundTaskSnapshot,
): void {
  const taskType = runtimeTaskTypeForToolCall(toolCall);
  if (!taskType || !deps.runtimeTaskRegistry) return;
  deps.runtimeTaskRegistry.update(taskId, (current) => ({
    ...(isTerminalRuntimeTask(current)
      ? current
      : {
          ...current,
          completedAt: runtimeTaskCompletedAt(status, snapshot) ?? current.completedAt,
          description:
            runtimeTaskDescription(toolCall, undefined, snapshot) ?? current.description,
          error: runtimeTaskError(snapshot) ?? current.error,
          exitCode: runtimeTaskExitCode(snapshot) ?? current.exitCode,
          isBackgrounded: true,
          outputFile: backgroundTaskOutputMetadata(snapshot).outputFile ?? current.outputFile,
          pid: runtimeTaskPid(snapshot) ?? current.pid,
          // `?? current.resultText`: undefined never clears a stored artifact (both
          // intermediate running snapshots and terminal snapshots without an artifact
          // pass through here).
          resultText: runtimeTaskResultText(toolCall, status, snapshot) ?? current.resultText,
          status: normalizeRuntimeTaskStatus(status),
          taskType,
          type: taskType,
        }),
  }));
}

/**
 * Artifact text from a workflow run. Read it only from a **terminal** snapshot dispatched
 * by a dwf name (CreateWorkflow / ResumeWorkflowRun): TaskOutput reads only registry
 * entries, and dwf never writes outputFile, so an artifact absent from the entry becomes
 * unreachable after restart.
 *
 * Legacy `Workflow` is deliberately excluded: its result travels through `output.response` on the existing notification path, preserving that contract.
 */
function runtimeTaskResultText(
  toolCall: ExecutableToolCall,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): string | undefined {
  if (!isDynamicWorkflowRunDispatchToolName(toolCall.name)) return undefined;
  if (status === "running") return undefined;
  if (!snapshot || !("output" in snapshot)) return undefined;
  return serializeWorkflowArtifact(snapshot.output);
}

export function claimRuntimeBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): boolean {
  if (!runtimeTaskTypeForToolCall(toolCall) || !deps.runtimeTaskRegistry) return true;
  let claimed = false;
  const task = deps.runtimeTaskRegistry.update(taskId, (current) => {
    if (current.notified) return current;
    claimed = true;
    return { ...current, notified: true };
  });
  return task === undefined ? true : claimed;
}

export function releaseRuntimeBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): void {
  if (!runtimeTaskTypeForToolCall(toolCall) || !deps.runtimeTaskRegistry) return;
  deps.runtimeTaskRegistry.update(taskId, (current) =>
    current.notified ? { ...current, notified: false } : current,
  );
}

export function removeRuntimeBackgroundTask(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): void {
  if (!runtimeTaskTypeForToolCall(toolCall) || !deps.runtimeTaskRegistry) return;
  deps.runtimeTaskRegistry.remove(taskId);
}

function runtimeTaskTypeForToolCall(toolCall: ExecutableToolCall): RuntimeTaskType | undefined {
  switch (toolCall.name) {
    case "Bash":
      return "local_bash";
    case "Workflow":
      return "local_workflow";
    default:
      // The two dwf entry points (CreateWorkflow / ResumeWorkflowRun) share a taskType.
      // Without it, registerRuntimeBackgroundTask returns immediately, losing both the
      // session-cleanup guard and TaskOutput visibility.
      return isDynamicWorkflowRunDispatchToolName(toolCall.name)
        ? "local_dynamic_workflow"
        : undefined;
  }
}

function defaultRuntimeTaskDescription(taskType: RuntimeTaskType): string {
  switch (taskType) {
    case "local_bash":
      return "Bash background command";
    case "local_workflow":
      return "Workflow background task";
    case "local_dynamic_workflow":
      return "Dynamic workflow run";
    case "local_agent":
      return "Agent background task";
    case "monitor_mcp":
      return "Monitor background task";
  }
}

function normalizeRuntimeTaskStatus(status: string): RuntimeTaskSnapshot["status"] {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "cancelled":
    case "timed_out":
      return "killed";
    case "lost":
      return "lost";
    default:
      return "failed";
  }
}

function runtimeTaskDescription(
  toolCall: ExecutableToolCall,
  output?: Record<string, unknown>,
  snapshot?: BackgroundTaskSnapshot,
): string | undefined {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  if (snapshot && "description" in snapshot && typeof snapshot.description === "string") {
    return snapshot.description;
  }
  if (snapshot && "name" in snapshot && typeof snapshot.name === "string") return snapshot.name;
  if (output && typeof output.name === "string") return output.name;
  if (typeof input.description === "string") return input.description;
  if (typeof input.command === "string") return input.command;
  if (typeof input.name === "string") return input.name;
  if (typeof input.scriptPath === "string") return input.scriptPath;
  return undefined;
}

function runtimeTaskCompletedAt(
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
): Date | undefined {
  if (status === "running") return undefined;
  return snapshot?.completedAt ?? new Date();
}

function runtimeTaskError(snapshot: BackgroundTaskSnapshot | undefined): string | undefined {
  if (!snapshot || !("error" in snapshot)) return undefined;
  const error = snapshot.error;
  return typeof error === "string" ? error : error?.message;
}

function runtimeTaskExitCode(snapshot: BackgroundTaskSnapshot | undefined): number | undefined {
  if (!snapshot || !("result" in snapshot)) return undefined;
  return snapshot.result?.exitCode;
}

function runtimeTaskPid(snapshot: BackgroundTaskSnapshot | undefined): number | undefined {
  if (!snapshot || !("pid" in snapshot)) return undefined;
  return snapshot.pid;
}
