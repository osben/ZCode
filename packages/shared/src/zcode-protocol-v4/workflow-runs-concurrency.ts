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

/** Event `reason` for resetting an idle bucket to its ceiling. This is not a cooldown; clear any old cooldown when received. */
const CONCURRENCY_IDLE_RESET_REASON = "idle_reset";

/**
 * Reduce `concurrency-changed` into `run.concurrency`.
 *
 * Derive the ceiling from the greatest `previous` / `next` seen by this run (the event omits it; the bucket starts at the ceiling, so the first
 * event's `previous` is the ceiling and remains the maximum in a sequence that only decreases). `cooldownMs` is present only for rate limits with Retry-After;
 * `idle_reset` clears it. If `next` is invalid or absent, return unchanged: without a cap there is nothing to display.
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
  const ceiling = Math.max(run.concurrency?.ceiling ?? 0, previous, next);
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
 * Reduce `run-started` into `run.concurrency.limit`, the bound **for this run**. The payload includes the engine's
 * `caps.maxConcurrency` and the `concurrencyCeiling` computed by the CLI when it creates the payload (the ceiling is a process fact,
 * not an engine fact, so the CLI adds it, following the precedent of `resumedFrom`).
 *
 * Record it only when `maxConcurrency < ceiling`: a run at the ceiling stays byte-for-byte identical, with no extra keys.
 * Older CLIs do not send `concurrencyCeiling`; without a readable ceiling, we cannot tell whether the run was lowered, so leave it unchanged.
 *
 * Preserve shared bucket fields (`cap` / `key` / `cooldownMs`): resume emits another `run-started` for the same runId, and by then the process may
 * have learned a rate-limited lower cap. Replacing it with the ceiling would report a false value. Likewise, `ceiling` only increases, following the watermark rule in `reduceConcurrencyChanged`.
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
  // Store the ceiling separately in `run.concurrencyCeiling`: the settings stepper needs to know its upper bound,
  // and a run at the ceiling has no `concurrency` object. If it cannot be read, retain the known value, following the subagentModel fallback rule.
  const withCeiling =
    ceiling === undefined || run.concurrencyCeiling === ceiling
      ? run
      : { ...run, concurrencyCeiling: ceiling };
  if (limit === undefined || ceiling === undefined || limit >= ceiling) return withCeiling;
  const existing = withCeiling.concurrency;
  const concurrency: WorkflowRunConcurrency = {
    // Without shared bucket data, start cap at the ceiling: that is where the bucket starts, as also assumed when reduceConcurrencyChanged derives the ceiling.
    ...(existing ?? { cap: ceiling }),
    ceiling: Math.max(existing?.ceiling ?? 0, ceiling),
    limit,
  };
  return { ...withCeiling, concurrency };
}

/**
 * Reduce `run-caps-changed` into `run.concurrency.limit`: this run's own bound changed **while it was active**. A revision that changes only
 * `max_concurrency` takes effect in place; the run is not stopped or restarted. The engine emits this event after updating caps, with the same payload shape as `run-started`
 * (engine `caps.maxConcurrency` plus CLI-provided `concurrencyCeiling`). Read the same two fields and apply the same “record only below the ceiling” rule as
 * `reduceRunStartedConcurrency`, so the same value produces the same result through either path.
 *
 * Resolve the ceiling from the payload, then the value already known for this run. It is a process fact that remains constant for the run, and `run-started` stores it
 * in `run.concurrencyCeiling`, giving this event an extra fallback. If neither is available, whether the value was lowered cannot be determined, so leave it unchanged.
 * The same applies when `caps` cannot be read.
 *
 * When the limit rises to the ceiling, **remove** `limit` instead of setting it to the ceiling: by protocol, a run at the ceiling has no per-run bound. After removal,
 * if shared bucket state has nothing to report (cap is at its ceiling and not cooling down), omit the entire `concurrency` key, making the run byte-for-byte identical to one that was never lowered.
 * If `limit` was already absent, leave everything unchanged to preserve idempotency.
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
  if (maxConcurrency < ceiling) {
    const concurrency: WorkflowRunConcurrency = {
      // Without shared bucket data, start cap at the ceiling, following the same assumption as reduceRunStartedConcurrency.
      ...(existing ?? { cap: ceiling }),
      ceiling: Math.max(existing?.ceiling ?? 0, ceiling),
      limit: maxConcurrency,
    };
    return { ...withCeiling, concurrency };
  }
  if (existing?.limit === undefined) return withCeiling;
  const { limit: _lifted, ...shared } = existing;
  return shared.cooldownMs === undefined && shared.cap >= shared.ceiling
    ? withoutConcurrency(withCeiling)
    : { ...withCeiling, concurrency: shared };
}

/** Remove the entire `concurrency` key instead of leaving an empty object: by protocol, a run at the ceiling has no such key. */
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
