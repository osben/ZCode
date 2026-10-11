// ============================================================
// Background stop path for workflow runs (the local_dynamic_workflow dispatch from runtime.stopBackgroundTask).
// ============================================================
//
// This is the endpoint of the **only cancellation path**. Both entry points converge on this implementation:
//   1. GUI：v4 `cancelBackgroundWork {workId}` → `app.cancelBackgroundTask`
//      → `runtime.cancelBackgroundTask` → `runtime.stopBackgroundTask`（lenient）
//   2. Model: `TaskStop` tool → `backgroundTaskControlPort.stopBackgroundTask`
//      (runtime-tools.ts binds it to the same `runtime.stopBackgroundTask`, with strict: true)
// The only difference is strict (strict returns not_running for an already-terminal task instead of lenient success);
// dispatch and all behavior after this module are identical—there is no second cancellation semantic.
//
// This is a separate module to keep background.ts small and avoid adding branch complexity.
// background.ts retains only one import and one dispatch line.

import type { AgentRuntimeInternal } from "../internal.js";
import type {
  RuntimeBackgroundStopInitiator,
  RuntimeBackgroundStopResult,
  TypedRuntimeBackgroundStopTarget,
} from "./background-stop-types.js";

/**
 * Stops a workflow run by passing taskId (≡ runId ≡ workId; there is no identity mapping table) to
 * `DynamicWorkflowRunPort.cancel`。
 *
 * the AbortController in the port's internal abort registry: abort an in-flight ask, kill the sandbox subprocess, and have the engine
 * settle the run through `stop(initiator)` as `stopped(user | model)` (**not** `errored`—the journal is the persistent record read by the app,
 * and the two states have different semantics and resume UX; the harness must never encode a failure as a stop).
 *
 * Both fallback cases return structured results instead of pretending success:
 *   - The entire port is absent (an unwired host) → capability unsupported;
 *   - The port returns false for an unknown/already-settled run → not_found.
 */
export async function stopDynamicWorkflowBackgroundTask(
  this: AgentRuntimeInternal,
  target: TypedRuntimeBackgroundStopTarget,
  unsupported: (target: TypedRuntimeBackgroundStopTarget) => RuntimeBackgroundStopResult,
  initiator?: RuntimeBackgroundStopInitiator,
): Promise<RuntimeBackgroundStopResult> {
  const port = this.dynamicWorkflowRunPort;
  if (!port) {
    return unsupported(target);
  }
  // Record who stopped it before aborting: the terminal notification is created later when the waiter settles, and the registry entry is
  // the only shared state between the two. Write before abort, or settlement may read an empty value first.
  if (initiator !== undefined && target.registryTask !== undefined) {
    this.runtimeTaskRegistry.update(target.taskId, (current) => ({
      ...current,
      stopInitiator: initiator,
    }));
  }
  // Persist the reason with cancellation so when the run settles as `stopped(user|model)`,
  // terminal notifications and GetWorkflowRun can read who stopped it from the journal instead of relying only on the registry fallback above.
  // The fact that the user explicitly stopped it also feeds AmendWorkflow's confirmation rule: after the user says "stop," the model must ask before revising it.
  const cancelled = await port.cancel(target.taskId, initiator);
  if (!cancelled) {
    return {
      ok: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: target.taskId,
      type: "local_dynamic_workflow",
    };
  }
  return {
    ok: true,
    status: "cancelled",
    taskId: target.taskId,
    type: "local_dynamic_workflow",
  };
}
