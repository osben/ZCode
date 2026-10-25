// ============================================================
// Workflow default concurrency: the single implementation of the CPU-derived value
// ============================================================
// docs/dynamic-workflow/concurrency.md "Two bounds on a run": `max(4, min(16, availableParallelism() − 2))`
// is the **default concurrency** D — the upper bound for runs without a `max_concurrency`,
// the starting point and idle-reset landing point of each provider bucket in the
// process-level governor, and the concurrency of the legacy `Workflow` tool and snippets.
// It is a starting point, **not** a ceiling: a user-provided `max_concurrency` above or
// below it is used as-is, and bucket auto-growth goes up to 2D at most (beyond that it
// only follows the in-flight runs' upper bound).
//
// This number used to be called the "ceiling", and a run's own bound was clamped below it;
// user feedback said small machines / small remotes only got two subagents, while the
// subagents were waiting on a remote provider, not on local cores — so the ceiling
// semantics were removed and the floor raised from 1 to 4.
// A formula copied to multiple places drifts independently; it converged into this one function.

import { availableParallelism as osAvailableParallelism } from "node:os";

/** Hard cap of the default concurrency (inherited from the legacy concurrency formula). Governs the default only, not a user-provided bound. */
export const WORKFLOW_DEFAULT_CONCURRENCY_MAX = 16;
/** Floor: on machines with few cores and small remotes, `cores − 2` leaves only one or two, and subagents are not bottlenecked on local cores. */
const WORKFLOW_DEFAULT_CONCURRENCY_FLOOR = 4;
/** Cores reserved for the main agent and host process. */
const RESERVED_PARALLELISM = 2;
/**
 * Auto-growth factor of the governor's buckets: when no in-flight run asks for more, the
 * cap climbs at most to `2 × D` by probing
 * (docs/dynamic-workflow/concurrency.md "The governor").
 */
export const WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR = 2;

/**
 * CPU-derived default concurrency. `availableParallelism` is injectable so tests can pin
 * the core count (the floor / hard-cap cases).
 */
export function resolveWorkflowDefaultConcurrency(
  availableParallelism: () => number = osAvailableParallelism,
): number {
  return Math.max(
    WORKFLOW_DEFAULT_CONCURRENCY_FLOOR,
    Math.min(WORKFLOW_DEFAULT_CONCURRENCY_MAX, availableParallelism() - RESERVED_PARALLELISM),
  );
}

/**
 * Requested concurrency bound -> the bound actually in effect for this run
 * (docs/dynamic-workflow/concurrency.md "Two bounds on a run").
 *
 * **No ceiling**: above the default and below the default are both used as-is — if the
 * user asks for 40, they get 40; what the provider can bear is the governor's business.
 * Absent / non-finite reads as "no bound of its own" = default concurrency; non-integers
 * floor (asking for "3.7 in-flight asks" is meaningless, and rounding up would silently
 * exceed the number the user stated); floor of 1.
 *
 * The bound set at submission time and a mid-run retune **must** go through the same rule
 * (otherwise the same `max_concurrency` would land on two different numbers via the two
 * paths), and those two paths live in the run service and retune modules respectively, so
 * it lives here.
 */
export function normalizeRunConcurrency(
  requested: number | undefined,
  defaultConcurrency: number,
): number {
  if (requested === undefined || !Number.isFinite(requested)) return defaultConcurrency;
  return Math.max(1, Math.floor(requested));
}
