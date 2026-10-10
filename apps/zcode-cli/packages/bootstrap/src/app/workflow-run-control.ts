// ============================================================
// Active control surface for a run: one command updates both the engine and seat gate.
// ============================================================
// An active run has two enforcement points in different
// layers: the scheduler is in the engine (`@zcode/dynamic-workflow`), while the seat gate is below the driver (in this package). The command sender
// (run service's `retuneConcurrency`) cannot reach either directly: the engine exists only after the harness is assembled in the child process,
// and launch creates the gate.
//
// The run service therefore creates an **empty** handle in the registry entry; each side attaches itself when it is created:
// the harness receives `bind(engine)` (passed through the same seam as `signal`), and launch receives `bindSeatGate(gate)`.
// The handle makes no decisions: liveness checks, no-op semantics, and persistence live in the engine's `setMaxConcurrency`. The gate changes its limit only
// after the engine confirms a real change, so the two enforcement points cannot disagree.
//
// Ordering affects correctness: **engine first**. Its boolean is the command's decision (already settled / value unchanged ⇒ false, no change).
// If the gate changed its limit first, a run that had already settled could retain an in-memory limit that disagrees with the journal row.

import type { RunControlBinding } from "@zcode/dynamic-workflow-runtime";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

export interface WorkflowRunControl extends RunControlBinding {
  /**
   * Change this run's own concurrency limit in place. Return **whether it actually changed**: `false` means nothing happened—the engine is not yet
   * attached (in the microtasks before launch), the run has settled, or the new value matches the current one. The caller falls back accordingly.
   */
  setMaxConcurrency(maxConcurrency: number): boolean;
  /** Bind after launch creates the seat gate; if absent, the run has only the scheduler enforcement point. */
  bindSeatGate(gate: Pick<WorkflowRunSeatGate, "setLimit">): void;
}

export function createWorkflowRunControl(): WorkflowRunControl {
  let engine: { setMaxConcurrency(maxConcurrency: number): boolean } | undefined;
  let seatGate: Pick<WorkflowRunSeatGate, "setLimit"> | undefined;
  return {
    bind: (bound) => {
      engine = bound;
    },
    bindSeatGate: (gate) => {
      seatGate = gate;
    },
    setMaxConcurrency: (maxConcurrency) => {
      if (engine === undefined) return false;
      if (!engine.setMaxConcurrency(maxConcurrency)) return false;
      seatGate?.setLimit(maxConcurrency);
      return true;
    },
  };
}
