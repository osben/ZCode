// ============================================================
// Active control surface for a run: one command updates both the engine and seat gate.
// ============================================================
// docs/dynamic-workflow/concurrency.md, "The control path". An active run has two enforcement
// points in different layers: the scheduler is in the engine (`@zcode/dynamic-workflow`), while
// the seat gate is below the driver (in this package). The command sender (run service's
// `retuneConcurrency`) cannot reach either directly: the engine exists only after the harness is
// assembled in the child process, and launch creates the gate.
//
// The run service therefore creates an **empty** handle in the registry entry; each side attaches itself when it is created:
// the harness receives `bind(engine)` (passed through the same seam as `signal`), and launch receives `bindSeatGate(gate)`.
// The handle makes no decisions: liveness checks, no-op semantics, and persistence live in the engine's `setMaxConcurrency`. The gate changes its limit only
// after the engine confirms a real change, so the two enforcement points cannot disagree.
//
// Ordering affects correctness: **engine first**. Its boolean is the command's decision (already settled / value unchanged ⇒ false, no change).
// If the gate changed its limit first, a run that had already settled could retain an in-memory limit that disagrees with the journal row.

import type { FillHoleResult, HoleFill, OpenHole } from "@zcode/dynamic-workflow";
import type { RunControlBinding } from "@zcode/dynamic-workflow-runtime";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

export interface WorkflowRunControl extends RunControlBinding {
  /**
   * Change this run's own concurrency limit in place. Return **whether it actually changed**: `false` means nothing happened—the engine is not yet
   * attached (in the microtasks before launch), the run has settled, or the new value matches the current one. The caller falls back accordingly.
   */
  setMaxConcurrency(maxConcurrency: number): boolean;
  /**
   * Bind after launch creates the seat gate; if absent, the run has only the scheduler enforcement
   * point. What launch passes in is not the gate itself but the combined move of "swap the gate's
   * limit + re-register this run's bound on the governor" (docs/dynamic-workflow/concurrency.md,
   * "The control path"), so one retune moves both the gate and the growth cap.
   */
  bindSeatGate(gate: Pick<WorkflowRunSeatGate, "setLimit">): void;
  /**
   * Deliver a waiting hole's function body from the effective script (docs/execution-engine.md,
   * "The engine's part"). Returns `undefined` when the engine is not yet attached—the same meaning
   * as `setMaxConcurrency` returning false: at this moment there is no engine to command, and the
   * caller (the fill service) reports `hole_not_waiting` accordingly. A hole has only the engine
   * as its enforcement point; the gate plays no part.
   */
  fillHole(fill: HoleFill): FillHoleResult | undefined;
  /**
   * Holes the engine currently has parked (the sole source of the snapshot's `waiting` projection;
   * docs/execution-engine.md, "The run snapshot"). Returns `undefined` when the engine is not yet
   * attached, which reads the same as "no engine is waiting" on the read surface.
   */
  openHoles(): readonly OpenHole[] | undefined;
}

/** Engine facet held by the control surface: two commands (limit, fill) and one query (parked holes). */
type BoundEngine = Parameters<RunControlBinding["bind"]>[0];

export function createWorkflowRunControl(): WorkflowRunControl {
  let engine: BoundEngine | undefined;
  let seatGate: Pick<WorkflowRunSeatGate, "setLimit"> | undefined;
  return {
    bind: (bound) => {
      engine = bound;
    },
    fillHole: (fill) => engine?.fillHole(fill),
    openHoles: () => engine?.openHoles(),
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

/**
 * The move launch hands to {@link WorkflowRunControl.bindSeatGate}: one retune swaps the seat
 * gate's limit and re-registers this run's bound on the process-level governor (which raises the
 * growth cap for the keys this run has used; docs/dynamic-workflow/concurrency.md, "The
 * governor"). Without a governor, only the gate remains.
 */
export function runBoundTarget(
  seatGate: Pick<WorkflowRunSeatGate, "setLimit">,
  concurrency: Pick<WorkflowConcurrencyPort, "setRunBound"> | undefined,
  runId: string,
): Pick<WorkflowRunSeatGate, "setLimit"> {
  return {
    setLimit: (limit) => {
      seatGate.setLimit(limit);
      concurrency?.setRunBound(runId, limit);
    },
  };
}
