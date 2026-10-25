// ============================================================
// Dynamic Workflow Run Service: reconcile orphan runs during construction.
// ============================================================
// dynamic-workflow-run-service.ts reached oxlint's 400-line limit, so orphan-run reconciliation
// (interruptedRunFailure / reconcileOrphanRuns) was split into this file; the public API remains
// exported from dynamic-workflow-run-service.ts. See invariant 4 in that file's header for semantics.

import type { Logger } from "@zcode/contracts";
import type { JournalStorePort, RunRecord, WorkflowErrorJson } from "@zcode/dynamic-workflow";
import { supportsNonTerminalRunQuery } from "./dynamic-workflow-run-journal.js";
import {
  INTERRUPTED_FAILURE_CODE,
  TERMINAL_RUN_STATUSES,
} from "./dynamic-workflow-run-observation.js";

/**
 * Subset of deps required for reconciliation (a structural subset of DynamicWorkflowRunServiceDeps,
 * passed through unchanged by the service). List only these three rather than importing all deps:
 * reconciliation reads only the journal and recognizes only this session; extra dependencies would
 * obscure what it actually touches.
 */
interface DynamicWorkflowOrphanReconcileDeps {
  journal: JournalStorePort;
  parentSessionId: string;
  logger?: Logger;
}

/**
 * Failure encoding for interrupted runs. Reuse the engine's {@link WorkflowErrorJson} shape (stored
 * in dwf_run.failure_json and read through the same surface as engine failures), but use a **dedicated** code:
 *
 *   - It cannot be `DriverError`: script-thrown errors use that code too (dynamic-workflow-runtime/src/harness.ts),
 *     and sharing a code would force us to distinguish "process killed" from "script failed" by message text.
 *   - Status cannot be `cancelled`, which means "cancelled by the user". Both states are resumable
 *     (the resume gate checks {@link INTERRUPTED_FAILURE_CODE}), but their meanings must remain distinct.
 */
function interruptedRunFailure(runId: string): WorkflowErrorJson {
  return {
    code: INTERRUPTED_FAILURE_CODE,
    message: `dynamic workflow run ${runId} was interrupted: the owning process exited before the run settled`,
  };
}

/**
 * Reconcile orphaned runs for this parent session during construction (the prior failure mode was:
 * the process closed after run-started, leaving the dwf_run row **stuck in running forever**. For runs
 * absent from this process's registry, getTask/waitForTask returned the journal snapshot directly,
 * so every journal read after session recovery said "still running" with no way to self-heal).
 *
 * Why run this during **construction**: at this point the service instance has no in-flight runs, so
 * any non-terminal journal row for this session can only be residue from a dead process. A second
 * construction is naturally idempotent because no non-terminal rows remain.
 *
 * Three boundaries:
 *   - **Reconcile only this session** (`deps.parentSessionId`). A global sweep could mark in-flight
 *     runs from sibling sessions in the same process as dead; session single ownership excludes two
 *     processes for the same session.
 *   - **Do not synthesize dwf_event**. The event log records "what the engine emitted"; the run row
 *     is authoritative for state. `run-settled` belongs to the engine, not the sweeper.
 *   - **Do not let reconciliation failure break construction**. Reconciliation is a self-healing
 *     action, not a precondition for a run: log a warning and continue if a query or write fails
 *     (the only consequence is that the stale row remains); never turn app construction into startup failure.
 */
export function reconcileOrphanRuns(deps: DynamicWorkflowOrphanReconcileDeps): void {
  const { journal, logger, parentSessionId } = deps;
  if (!supportsNonTerminalRunQuery(journal)) {
    logger?.warn?.("Dynamic workflow orphan run reconciliation skipped", {
      event: "dynamic_workflow.run.reconcile_skipped",
      module: "bootstrap.app",
      reason: "journal_missing_list_non_terminal_runs",
    });
    return;
  }

  let orphans: RunRecord[];
  try {
    orphans = journal.listNonTerminalRuns(parentSessionId);
  } catch (error) {
    logger?.warn?.("Dynamic workflow orphan run query failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.run.reconcile_failed",
      module: "bootstrap.app",
    });
    return;
  }

  for (const record of orphans) {
    // This file's TERMINAL_RUN_STATUSES is authoritative for terminal-state checks; journal status filtering is only a prefilter.
    if (TERMINAL_RUN_STATUSES.has(record.status)) continue;
    try {
      // stopped(interrupted) is recoverable and distinguishable from user cancellation or a
      // model-side stop: reason says "the process died," and code provides a second piece of evidence.
      journal.updateRunStatus(record.runId, "stopped", {
        stopReason: "interrupted",
        failure: interruptedRunFailure(record.runId),
      });
      logger?.warn?.("Dynamic workflow run reconciled as interrupted", {
        event: "dynamic_workflow.run.reconciled_interrupted",
        module: "bootstrap.app",
        previousStatus: record.status,
        runId: record.runId,
      });
    } catch (error) {
      logger?.warn?.("Dynamic workflow orphan run reconciliation failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.run.reconcile_failed",
        module: "bootstrap.app",
        runId: record.runId,
      });
    }
  }
}
