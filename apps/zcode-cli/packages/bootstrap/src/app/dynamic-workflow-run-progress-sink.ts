/**
 * Workflow run progress-event append sink for the parent session (create-app's `onRunEvent`).
 *
 * This lives in a separate file rather than create-app's closure so the following three **degradation
 * paths** can be tested directly. They all cover "run is in flight, observation surface has a
 * problem". Letting any exception escape would crash a running workflow, while the journal is the
 * source of truth for the run; the progress surface is observational and must never be able to terminate it.
 */

import type { DynamicWorkflowRunProgressPayload, Logger, SessionId } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";

interface DynamicWorkflowRunProgressSinkDeps {
/** Get runtime lazily: the run service is constructed **before** runtime (it is one of runtime's dependencies). */
  getRuntime: () => AgentRuntime;
/** Session owned by this app. A run's parentSessionId must match it; see the identity gate below. */
  sessionId: SessionId;
  logger?: Logger;
}

/**
 * Create a progress sink. The returned function **never throws and never returns a rejected promise**.
 *
 * ## Identity gate (load-bearing)
 *
 * Events must be written to **the session that launched the run**. This is currently 1:1 by construction:
 *
 *   ZCodeApp ──1:1── AgentRuntime ──1:1── sessionId        (`new AgentRuntime(sessionId, …)` in create-app)
 *        └──1:1── run service (built into this app; the port is not shared)
 *   The CreateWorkflow handler submits `parentSessionId = context.sessionId`
 *
 * **Only** the app-level runtime receives `dynamicWorkflowRunPort`. The subagent runtime dependency
 * object (`new AgentRuntime(...)` in `core/src/runtime/methods/subagent.ts`) and workflow actor runtime
 * (`script-workflow-child-runtime.ts`) both **omit** this port (verified directly), so child sessions
 * cannot submit through it; their CreateWorkflow requests use the "port absent -> placeholder diagnostic" path.
 *
 * Therefore `getRuntime()` returns the correct runtime. **But this invariant could change if it is not
 * documented**: if someone adds the port to child-runtime dependencies, runs launched by child
 * sessions would write events into the **parent** transcript. That bug would not throw; it would only
 * place events in the wrong conversation. Compare identities explicitly here. On mismatch, **do not
 * append** and log guidance: a missing projection is better than contaminating another session's
 * transcript. (Supporting runs launched by child sessions would require a registry that resolves a
 * runtime by sessionId; bootstrap does not have one because child runtimes live inside core. That
 * requires a separate design change.)
 */
export function createDynamicWorkflowRunProgressSink(
  deps: DynamicWorkflowRunProgressSinkDeps,
): (progress: DynamicWorkflowRunProgressPayload, routing?: { parentSessionId?: string }) => void {
  const warn = (message: string, runId: string, extra: Record<string, unknown> = {}): void => {
    deps.logger?.warn?.(message, {
      event: "dynamic_workflow.run_progress.append_failed",
      module: "bootstrap.app",
      runId,
      ...extra,
    });
  };

  return (progress, routing) => {
    const parentSessionId = routing?.parentSessionId;
    // Absence is valid (submit omitted parentSessionId): this app's port can only be reached by this
    // session, so absence is equivalent to "this session". Only an **explicit mismatch** indicates bad wiring.
    if (parentSessionId !== undefined && parentSessionId !== deps.sessionId) {
      warn("Dynamic workflow run progress dropped: parent session is not this app", progress.runId, {
        event: "dynamic_workflow.run_progress.session_mismatch",
        expectedSessionId: deps.sessionId,
        parentSessionId,
        reason: "run_parent_session_not_owned_by_this_app",
      });
      return;
    }

    // getRuntime() **throws synchronously** before runtime is constructed; a closing runtime may also
    // throw in the append chain (event store / persistence / sink fan-out). Both cases must degrade to a
    // logged no-op.
    let appended: Promise<void>;
    try {
      appended = deps.getRuntime().recordDynamicWorkflowRunProgress(progress);
    } catch (error) {
      warn("Dynamic workflow run progress append failed", progress.runId, {
        errorMessage: error instanceof Error ? error.message : String(error),
        reason: "runtime_unavailable",
      });
      return;
    }
    void appended.catch((error: unknown) => {
      warn("Dynamic workflow run progress append failed", progress.runId, {
        errorMessage: error instanceof Error ? error.message : String(error),
        reason: "append_rejected",
      });
    });
  };
}
