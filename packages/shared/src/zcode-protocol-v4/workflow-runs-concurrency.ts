// ============================================================
// Adaptive concurrency portion of the workflowRuns reducer
// ============================================================
// Split out of workflow-runs-reducer.ts to meet the max-lines limit: the main reducer only dispatches the switch,
// and the `concurrency-changed` rules live here. Like the main reducer, this module uses pure functions and does not read the clock.
// Event `cooldownMs` is relative; the UI derives the deadline from when it receives the state.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunConcurrency,
  type WorkflowRunState,
} from "./workflow-runs.js";

/** `reason` value in the event: the bucket reset to default concurrency after becoming idle; this is not a cooldown, so clear any old cooldown on receipt. */
const CONCURRENCY_IDLE_RESET_REASON = "idle_reset";

/**
 * Reduce `concurrency-changed` into `run.concurrency`.
 *
 * `ceiling` is default concurrency D (docs/dynamic-workflow/concurrency.md, "Protocol state"): always use the value
 * recorded by `run-started` in `run.concurrencyCeiling`. The shared bucket can auto-grow to 2D, and a raised run can go higher,
 * so the greatest observed previous / next value is no longer D. It is only a fallback for **older CLIs** that omit
 * `concurrencyCeiling`: their bucket starts at the ceiling and only decreases, so its maximum is the ceiling. `cooldownMs` is
 * present only for rate limits with Retry-After; `idle_reset` clears it. If `next` is unreadable (missing / not a positive integer),
 * only advance the watermark: without a cap there is nothing to display.
 *
 * Preserve `limit`: it is this run's own bound from `run-started`, independent of shared bucket changes. The governor lowering
 * or raising a provider key does not change the limit the user set for this run.
 */
export function reduceConcurrencyChanged(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const next = positiveInteger(payload.next);
  if (next === undefined) return run;
  const previous = positiveInteger(payload.previous) ?? next;
  const ceiling = run.concurrencyCeiling ?? Math.max(run.concurrency?.ceiling ?? 0, previous, next);
  const key = nonEmptyString(payload.key);
  const limit = run.concurrency?.limit;
  const cooldownMs =
    payload.reason === CONCURRENCY_IDLE_RESET_REASON
      ? undefined
      : nonNegativeInteger(payload.cooldownMs);
  const concurrency: WorkflowRunConcurrency = {
    ...(key === undefined || key.length > WORKFLOW_RUNS_LIMITS.maxConcurrencyKeyLength
      ? {}
      : { key }),
    cap: next,
    ceiling,
    ...(limit === undefined ? {} : { limit }),
    ...(cooldownMs === undefined ? {} : { cooldownMs }),
  };
  return { ...run, concurrency };
}

/**
 * `run-started` → `run.concurrency.limit`: this run's **own** limit
 * (docs/dynamic-workflow/concurrency.md, "Two bounds on a run"). The payload carries the engine's
 * `caps.maxConcurrency` and `concurrencyCeiling`, default concurrency D computed by the CLI when building the payload (the wire key
 * predates the term "default concurrency" and remains for compatibility with older clients). D is a process fact, not an engine fact,
 * so the CLI adds it to the payload, following the `resumedFrom` precedent.
 *
 * Record only when `maxConcurrency ≠ D`—both **above and below**: D is a starting point, not a limit, and users can give a run
 * more concurrency than the default. A run at the default remains byte-for-byte unchanged with no extra key. Older CLIs omit
 * `concurrencyCeiling`, so when D cannot be read there is no way to tell whether this run has its own limit; leave it unchanged.
 *
 * Preserve shared-bucket fields (`cap` / `key` / `cooldownMs`) as-is: resume emits another `run-started` for the same runId,
 * and by then the process may have learned a rate-limited lower cap. Replacing it with D would report a false higher value.
 */
export function reduceRunStartedConcurrency(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const limit = positiveInteger(plainRecord(payload.caps)?.maxConcurrency);
  const readCeiling = positiveInteger(payload.concurrencyCeiling);
  const ceiling =
    readCeiling !== undefined && readCeiling <= WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling
      ? readCeiling
      : undefined;
  // Store D separately (`run.concurrencyCeiling`): the settings dialog displays "Default N" and treats matching the default as
  // no run-specific limit, while a run at the default has no `concurrency` field. If unreadable, keep the known value, following
  // the same degradation rule as subagentModel.
  const withCeiling =
    ceiling === undefined || run.concurrencyCeiling === ceiling
      ? run
      : { ...run, concurrencyCeiling: ceiling };
  if (limit === undefined || ceiling === undefined || limit === ceiling) return withCeiling;
  const existing = withCeiling.concurrency;
  const concurrency: WorkflowRunConcurrency = {
    // Without shared-bucket data, start cap at D; that is where the bucket starts.
    ...(existing ?? { cap: ceiling }),
    ceiling,
    limit,
  };
  return { ...withCeiling, concurrency };
}

/**
 * `run-caps-changed` → `run.concurrency.limit`: this run's own limit changed **while it was running**
 * (a revision that changes only `max_concurrency` takes effect in place without stopping or restarting the run;
 * docs/dynamic-workflow/concurrency.md). The engine emits this event after changing caps, with the same payload shape as `run-started`
 * (engine `caps.maxConcurrency` plus CLI-supplied `concurrencyCeiling`, default concurrency D). Like `reduceRunStartedConcurrency`,
 * read the same two fields and record only when `maxConcurrency ≠ D`, so the same value cannot produce different readings through the two paths.
 *
 * Resolve D from the payload, then this run's known value. It is a process fact, constant for the whole run, and `run-started`
 * already stored it in `run.concurrencyCeiling`, so this event has one more fallback than `run-started`. If neither value exists,
 * there is no way to tell whether this number is the default; leave it unchanged. The same applies when `caps` is unreadable.
 *
 * Returning to D must **remove** `limit`, not set it to D: by protocol, a run at the default has no run-specific limit.
 * If the shared bucket also has nothing to report after removal (cap is at least D and there is no cooldown—cap above D is still
 * uninformative for a default run, whose reading is `min(cap, D)`), omit the whole `concurrency` key, byte-for-byte matching a run
 * whose limit was never changed. If `limit` was already absent, leave everything untouched (the idempotency anchor).
 */
export function reduceRunCapsChanged(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const maxConcurrency = positiveInteger(plainRecord(payload.caps)?.maxConcurrency);
  const readCeiling = positiveInteger(payload.concurrencyCeiling);
  const payloadCeiling =
    readCeiling !== undefined && readCeiling <= WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling
      ? readCeiling
      : undefined;
  const withCeiling =
    payloadCeiling === undefined || run.concurrencyCeiling === payloadCeiling
      ? run
      : { ...run, concurrencyCeiling: payloadCeiling };
  const ceiling = payloadCeiling ?? withCeiling.concurrencyCeiling;
  if (maxConcurrency === undefined || ceiling === undefined) return withCeiling;
  const existing = withCeiling.concurrency;
  if (maxConcurrency !== ceiling) {
    const concurrency: WorkflowRunConcurrency = {
      // Without shared-bucket data, start cap at D, following the same rule as reduceRunStartedConcurrency.
      ...(existing ?? { cap: ceiling }),
      ceiling,
      limit: maxConcurrency,
    };
    return { ...withCeiling, concurrency };
  }
  if (existing?.limit === undefined) return withCeiling;
  const { limit: _lifted, ...rest } = existing;
  const shared: WorkflowRunConcurrency = { ...rest, ceiling };
  return shared.cooldownMs === undefined && shared.cap >= shared.ceiling
    ? withoutConcurrency(withCeiling)
    : { ...withCeiling, concurrency: shared };
}

/** Remove the entire `concurrency` key (do not leave an empty object): by protocol, a run at the default with nothing to report omits this key. */
function withoutConcurrency(run: WorkflowRunState): WorkflowRunState {
  const { concurrency: _cleared, ...rest } = run;
  return rest;
}

/**
 * Remove `concurrency.cooldownMs` for a terminal run: nothing is dispatched afterward, so there is nothing to cool down. If absent, return the original value
 * as an idempotency anchor, following the main reducer's withoutPendingQuestions. Preserve cap / ceiling as historical facts about the concurrency under which the run operated.
 */
export function withoutCooldown(run: WorkflowRunState): WorkflowRunState {
  if (run.concurrency?.cooldownMs === undefined) return run;
  const { cooldownMs: _expired, ...rest } = run.concurrency;
  return { ...run, concurrency: rest };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
