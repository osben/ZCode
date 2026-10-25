// ============================================================
// Runtime guard for the submit profile.
// ============================================================
// Kept in a separate file because workflow-driver.ts is already over max-lines and this logic only reads driver deps / sink / session state;
// it is unrelated to the rest of the state machine.
//
// The static profile is inferred from the site's may-set. If a typed ask reaches a session that does not match it, the analysis was not precise enough—
// it is not the script's fault and must not silently break the run:
//   - `mono` with a different schema: restore the generic submit_result declaration for this session and make the runtime recompute its tool surface;
//     use generic behavior afterward (the suffix contains the full schema). This invalidates one cache prefix but preserves correctness.
//   - `untyped`: this runtime has no submit port (the factory did not inject one based on the profile), so there is no tool to restore.
//     Fail **this ask** with DriverError identifying the site instead of exhausting nudge and failing with ResultNotSubmitted, which would misrepresent an analysis issue as a model issue.

import { submitResultToolEntry } from "@zcode/core";
import {
  GENERIC_SUBMIT_PROFILE,
  canonicalJson,
  refToString,
  WorkflowError,
  type AskMessage,
  type InstanceRef,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/** Log event name when the static profile does not match the ask. */
const SUBMIT_PROFILE_MISMATCH_EVENT = "dynamic_workflow.submit_profile.mismatch";

/**
 * Make the session's submit_result shape match this typed ask. Return false if the ask has already failed and the caller must not dispatch
 * another turn. Generic sessions and mono sessions with the same schema pass through unchanged.
 */
export function ensureSubmitProfileFits(
  deps: AgentRuntimeWorkflowDriverDeps,
  sink: WorkflowReportSink,
  state: SessionState,
  instance: InstanceRef,
  message: AskMessage,
): boolean {
  const profile = state.submitProfile;
  if (profile.kind === "generic") return true;
  if (profile.kind === "mono" && canonicalJson(profile.schema) === canonicalJson(message.schema)) {
    return true;
  }
  if (profile.kind === "untyped") {
    sink.askFailed(
      instance,
      new WorkflowError(
        "DriverError",
        `Typed ask ${refToString(instance)} reached subagent session ${state.sessionId} whose static ` +
          `submit profile is "untyped" (no submit_result registered): the ask→actor analysis missed this ask.`,
      ),
    );
    return false;
  }
  deps.logger?.warn?.(
    "Dynamic workflow submit profile mismatch: falling back to the generic submit_result",
    {
      event: SUBMIT_PROFILE_MISMATCH_EVENT,
      module: "bootstrap.app",
      instance: refToString(instance),
      runId: deps.runId ?? "run",
      sessionId: state.sessionId,
    },
  );
  // Same registry and name: register replaces the typed entry. Do not log; replacement is intentional. Invalidate the cache,
  // or getTools will keep sending the old typed declaration to the model.
  state.runtime.getToolRegistry().register(submitResultToolEntry, { silentDuplicateWarning: true });
  state.runtime.invalidateToolCache();
  state.submitProfile = GENERIC_SUBMIT_PROFILE;
  return true;
}
