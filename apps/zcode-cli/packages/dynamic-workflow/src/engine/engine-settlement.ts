/**
 * engine.ts reached oxlint's max-lines limit (400), so the three terminal run paths
 * (completed / stopped / errored) and their shared finishRun helper were moved here; the public
 * surface is still exported from engine.ts.
 *
 * Free functions read and write engine state through the {@link EngineState} seam;
 * WorkflowEngine's complete / stop / failRun methods are thin delegates. `isRunSettled()` enforces
 * first-wins as the first check on each path.
 */

import type { EngineState } from "./engine-state.js";
import type { RunSettlementRecord, RunStatus, RunStopReason } from "./types.js";
import { WorkflowError } from "./types.js";

/**
 * The sandbox script returned a top-level artifact successfully; settle as completed.
 *
 * Asks may still be in flight when the script returns (losers in `Promise.race`, or asks without
 * `await`). Abort them as in the cancel path: call cancelAsk on the driver side, reject the deferred
 * with Cancelled, and emit node-settled(cancelled). Otherwise, three things go wrong: scheduler's
 * liveNodes holds the node forever, the driver-side turn keeps consuming tokens, and the event log
 * has a node-dispatched that never gets node-settled.
 */
export function settleCompleted(state: EngineState, artifact: unknown): void {
  if (state.isRunSettled()) return;
  state.markSettled();
  state.abortInFlight(
    new WorkflowError("Cancelled", "Run completed; in-flight subagent tasks were abandoned."),
    true,
  );
  // Persist the artifact with the terminal state in one write. Two writes would create a crash
  // window with “completed but artifact lost”; the journal row is the artifact's only durable
  // home (`run-settled` events are intentionally not widened).
  finishRun(state, "completed", { result: artifact });
  state.resolveSettled({ status: "completed", artifact });
}

/**
 * External stop: abort in-flight asks (reject the deferred with Cancelled and emit
 * node-settled(cancelled)), then settle the run as `stopped(reason)`. Keep completed journal entries
 * so they can be resumed. All four reasons use the same path: `user` / `model` (the initiator passed
 * by the cancel entry point), `interrupted` (sandbox failure in the harness), and `provider`
 * (deterministic model-side error reported by the driver through `stopRun`). `error` is present only
 * for the latter two.
 */
export function settleStopped(
  state: EngineState,
  reason: RunStopReason,
  error?: WorkflowError,
  supersededBy?: string,
): void {
  if (state.isRunSettled()) return;
  state.markSettled();
  state.abortInFlight(new WorkflowError("Cancelled", "Run stopped."), true);
  // Persist the successor ID and reason for `superseded` **in one write**: the stopped envelope is
  // rewritten as a whole, and two writes would create a window where the run is superseded but the
  // replacing run is unknown.
  finishRun(state, "stopped", {
    stopReason: reason,
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(error === undefined ? {} : { failure: error.toJSON() }),
  });
  state.resolveSettled({
    status: "stopped",
    reason,
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(error === undefined ? {} : { error }),
  });
}

/** Run-level failure (script error): abort in-flight asks (reject with the run error) and settle the run as errored. */
export function settleFailed(state: EngineState, error: WorkflowError): void {
  if (state.isRunSettled()) return;
  state.markSettled(error);
  state.abortInFlight(error, false);
  finishRun(state, "errored", { failure: error.toJSON() });
  state.resolveSettled({ status: "errored", error });
}

/**
 * The `run-settled` event contains only {status, stopReason?, error?}; artifacts are written only
 * to the journal, not the high-frequency progress stream.
 *
 * All three terminal paths go through here, so driver dispose runs exactly once and first-wins is
 * natural. It happens **after** `run-settled`: dispose releases resources after settlement (the
 * actor runtime's shutdown chain); it is not part of settlement and adds no event to the log.
 */
function finishRun(state: EngineState, status: RunStatus, settlement?: RunSettlementRecord): void {
  state.journal.updateRunStatus(state.runId, status, settlement);
  state.record({
    type: "run-settled",
    status,
    ...(settlement?.stopReason === undefined ? {} : { stopReason: settlement.stopReason }),
    ...(settlement?.supersededBy === undefined ? {} : { supersededBy: settlement.supersededBy }),
    ...(settlement?.failure === undefined ? {} : { error: settlement.failure }),
  });
  state.driver.dispose?.();
}
