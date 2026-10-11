// ============================================================
// AgentRuntime-backed WorkflowDriver: bridge for submitting typed results (submit_result).
// ============================================================
// Split out because workflow-driver.ts again reached oxlint's 400-line max-lines limit. The session-level submit port is now a free function,
// symmetric with the adjacent escalation bridge (`makeSessionEscalatePort` in workflow-driver-escalation.ts)—both follow the same sequence
// (block mid-turn → report → engine returns a decision → resolve deferred). The public surface is unchanged; the driver class keeps only the call.
//
// All access to driver state is passed explicitly through {@link SubmitBridgeHost} (session table + upward reporting surface).
// This file owns no state; the original method body is preserved, with `this.` changed to `host.`.

import type {
  SessionId,
  SubmitResultRequest,
  SubmitVerdict as ContractsSubmitVerdict,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import { WorkflowError, type WorkflowReportSink } from "@zcode/dynamic-workflow";
import { defer, rejectWith } from "./workflow-driver-helpers.js";
import type { SessionState } from "./workflow-driver-types.js";

/**
 * Host surface the driver supplies to the submit bridge. Both are **references** to private driver state, not copies: `sessions` is
 * the class's session table, and `sink` is Boundary B's reporting surface (`askSubmitAttempted` receives the engine's decision synchronously in this call stack, so both must belong to the same lifecycle).
 */
export interface SubmitBridgeHost {
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly sink: WorkflowReportSink;
}

/**
 * Create a session-level submit port: the `submit_result` handler calls it mid-turn and blocks until a decision arrives.
 *
 * The closure binds to this session, so the model cannot override routing identity (instance comes from `currentInstance`).
 */
export function makeSessionSubmitPort(
  host: SubmitBridgeHost,
  sessionId: SessionId,
): WorkflowSubmitPort {
  return {
    respond: (request: SubmitResultRequest): Promise<ContractsSubmitVerdict> => {
      const state = host.sessions.get(sessionId);
      const instance = state?.currentInstance;
      if (state === undefined || instance === undefined) {
        // Submit arrived without an active ask: reject directly instead of routing to the engine (which would hang).
        return Promise.resolve(rejectWith("no active ask is awaiting a submitted result"));
      }
      // Untyped-ask guard (phase 1.5 deviation note): the spec requires "an all-untyped actor does
      // not register submit_result," but the driver cannot see the actor's aggregated typed info at
      // createActorSession time (it needs the site graph, which is not passed through), so it always
      // registers. To avoid depending on the engine's "submitAttempted early-returns for untyped"
      // behavior (which would leave the deferred hanging forever), intercept inside the driver:
      // when an untyped ask receives a submit, immediately reply with a synthetic rejection so the
      // model uses plain text instead, and never report askSubmitAttempted. Phase 2 should pass
      // per-actor typed info through from the actor-graph projection and actually skip registration
      // on untyped-only actors (this matters for the prompt-cache frozen-tools invariant).
      if (!state.currentTyped) {
        return Promise.resolve(
          rejectWith(
            "this ask does not accept submit_result; provide your answer as your final message",
          ),
        );
      }
      // Single-current-instance invariant: at most one deferred may be pending. If one already exists (unexpected), reject the old one first to avoid a leak.
      state.pendingSubmit?.reject(
        new WorkflowError("DriverError", "This submit was superseded by a newer submit."),
      );
      const deferred = defer<ContractsSubmitVerdict>();
      state.pendingSubmit = deferred;
      // Report synchronously: the engine validates in this call stack and returns its decision through respondToSubmit (resolving the deferred synchronously).
      host.sink.askSubmitAttempted(instance, request.result);
      return deferred.promise;
    },
  };
}
