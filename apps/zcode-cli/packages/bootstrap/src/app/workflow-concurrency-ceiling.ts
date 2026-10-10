// ============================================================
// Workflow concurrency ceiling: the single implementation of the CPU-derived value.
// ============================================================
// `max(1, min(16, availableParallelism() − 2))`
// This is both each run's own concurrency limit (set at submission, stored in dwf_run, and reused
// on resume) and the **starting point and ceiling** for each provider bucket in the process-level
// governor. Keep the formula in one function: copies in run service, snippet service, and the legacy
// `Workflow` tool would drift independently and make the run limit disagree with the bucket ceiling.

import { availableParallelism as osAvailableParallelism } from "node:os";

/** Hard maximum for concurrency (retains the legacy concurrency formula). */
const WORKFLOW_CONCURRENCY_CEILING_MAX = 16;
/** Number of cores reserved for the main agent and host process. */
const RESERVED_PARALLELISM = 2;
/** Floor: on a dual-core machine, parallelism - 2 == 0, so at least one probe must remain running. */
const WORKFLOW_CONCURRENCY_FLOOR = 1;

/**
 * CPU-derived concurrency ceiling. `availableParallelism` can be injected to fix the core count in
 * tests (floor and hard-ceiling cases).
 */
export function resolveWorkflowConcurrencyCeiling(
  availableParallelism: () => number = osAvailableParallelism,
): number {
  return Math.max(
    WORKFLOW_CONCURRENCY_FLOOR,
    Math.min(WORKFLOW_CONCURRENCY_CEILING_MAX, availableParallelism() - RESERVED_PARALLELISM),
  );
}

/**
 * Requested concurrency limit -> effective limit for this run.
 *
 * **Clamp instead of rejecting**: this setting only reduces concurrency. An oversized value expresses
 * "do not limit me"; turning it into a tool failure would force the model to guess the machine's core
 * count. Missing/non-finite values also mean "unlimited" = the ceiling. Round fractional values down
 * (3.7 in-flight asks is not meaningful, while rounding up would exceed the user's value).
 *
 * Keep this next to the ceiling because submission-time limits and mid-run retuning **must** use the
 * same clamp. Otherwise the same `max_concurrency` could produce different values through the two
 * paths, which live in separate run-service and retune modules.
 */
export function clampRunConcurrency(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.max(1, Math.min(ceiling, Math.floor(requested)));
}
