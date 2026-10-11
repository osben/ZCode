// ============================================================
// Ownership ledger for unlisted entries: how each `unlistedByPhase` cell is incremented, decremented, and removed.
// ============================================================
// Split out of workflow-runs-eviction.ts (the main file's max-lines gate), under the same
// discipline: pure functions, no clock, no I/O. Eviction describes "who leaves the table"; this
// module describes "how it is still counted after leaving".
//
// The read side is drawn by **site** (docs/dynamic-workflow/presentation.md "Past six
// participants"): a site's roster, count ring, and "N more" must each add back the unlisted entries
// from their own cell. The two run-level counters (workflow-runs-caps.ts) say how many entries a
// run omitted in total, but not which site omitted them — this cell table fills that gap.
//
// The four values in each cell answer different questions; all describe **the current state** (not historical totals):
//   - `actors`: how many subagents from this birth phase are **currently absent from the table**, whether rejected, evicted, or
//     orphaned and settled at birth. This can increase or decrease — an evicted subagent returns to the table when it is dispatched again
//     (activation in workflow-runs-eviction.ts), so decrement this cell at that point;
//   - `actorsSettled` / `actorsFailed`: how many of those have **settled**, and how many failed when settling;
//   - `settled`: number of **settled nodes** omitted from this cell.
// Drop a cell when all four values are zero; when the last cell is dropped, remove the entire key, following this family's "omit when empty" convention.
//
// After every change, clamp the cell so `actorsFailed ≤ actorsSettled ≤ actors`. This is the cell's
// **invariant**, not a patch: this rule is what lets `actorsSettled` both increase and decrease. It
// must be able to decrease — a subagent may look "completed" between two asks, so eviction marks it
// as settled; its next dispatch then returns it to the table (this section once said actorsSettled
// "only ever increases, because a settled subagent is never dispatched back onto the table," which
// was wrong for subagents with multiple asks). But this cell cannot remember **which** subagent
// returned, so decrementing `actorsSettled` at activation would require guessing, and a wide
// fan-out makes that guess wildly inaccurate: hundreds of subagents in the phase may have been
// **rejected at birth** and never settled; each returning entry would subtract from a counter that
// does not belong to it. Clamping is wrong only when a cell is crowded, and only temporarily — the
// settled marker from the returning completed subagent is effectively attributed to another
// unlisted subagent in the same phase until that cell drains; as subagents return to the table, each
// phase's count corrects itself. The two run-level counters remain exact throughout.

import type { WorkflowRunState, WorkflowRunUnlistedPhase } from "./workflow-runs.js";

/** Increment applied to one cell. `actors` may be negative (a subagent returns to the table); the others are always positive. */
export interface WorkflowRunUnlistedDelta {
  actors?: number;
  actorsSettled?: number;
  actorsFailed?: number;
  settled?: number;
}

/**
 * Adds a value to the cell for a birth phase.
 *
 * **When the cell table is full, drop the ownership detail** (return the original table): a site can omit a number it did not otherwise have, but run-level counts must not
 * be inaccurate — callers still increment those as usual. The table can be one entry longer than `maxPhases`: the extra cell is "no phase," sharing the table with
 * named phases.
 *
 * `undefined` always means "no cells" (key absent), so decrementing the final cell to all zeros removes the entire table.
 */
export function addToUnlistedBucket(
  buckets: readonly WorkflowRunUnlistedPhase[] | undefined,
  phaseName: string | undefined,
  delta: WorkflowRunUnlistedDelta,
  maxPhases: number,
): WorkflowRunUnlistedPhase[] | undefined {
  const current = buckets ?? [];
  const index = current.findIndex((bucket) => bucket.phaseName === phaseName);
  if (index < 0 && current.length >= maxPhases + 1) {
    return buckets === undefined ? undefined : [...buckets];
  }
  const base = index < 0 ? undefined : current[index]!;
  // Clamp at zero: two preconditions for decrementing `actors` may fail (ownership detail was dropped when the cell table was full, or the actual birth phase differs from
  // the phase used for a redispatch), so clamping may undercount by one, while not clamping would send a negative number over the protocol.
  const actors = atLeastZero((base?.actors ?? 0) + (delta.actors ?? 0));
  // Clamp to `actorsFailed ≤ actorsSettled ≤ actors` (the invariant from the header): this cell cannot identify who returned to the table,
  // so the "settled" counts can decrease only along with the "absent from the table" count.
  const actorsSettled = Math.min(
    atLeastZero((base?.actorsSettled ?? 0) + (delta.actorsSettled ?? 0)),
    actors,
  );
  const actorsFailed = Math.min(
    atLeastZero((base?.actorsFailed ?? 0) + (delta.actorsFailed ?? 0)),
    actorsSettled,
  );
  const settled = atLeastZero((base?.settled ?? 0) + (delta.settled ?? 0));
  if (actors === 0 && actorsSettled === 0 && actorsFailed === 0 && settled === 0) {
    if (index < 0) return buckets === undefined ? undefined : [...buckets];
    const remaining = current.filter((_, position) => position !== index);
    return remaining.length > 0 ? remaining : undefined;
  }
  // Key order matches schema declaration order: this object is sent as-is in deltas, so both sides' bytes must match.
  const merged: WorkflowRunUnlistedPhase = {
    ...(phaseName === undefined ? {} : { phaseName }),
    actors,
    ...(actorsSettled > 0 ? { actorsSettled } : {}),
    ...(actorsFailed > 0 ? { actorsFailed } : {}),
    settled,
  };
  if (index < 0) return [...current, merged];
  const next = [...current];
  next[index] = merged;
  return next;
}

/**
 * Applies a cell table back to the run: **omit the key for an empty table** (rather than keeping an empty array).
 *
 * "Zero entries ⇒ key absent" is the protocol contract for this field (see the schema comment) and the basis of idempotency: a reduction that changes nothing
 * must produce a byte-for-byte identical run object so the top-level structural comparison returns null.
 */
export function withUnlistedBuckets(
  run: WorkflowRunState,
  buckets: readonly WorkflowRunUnlistedPhase[] | undefined,
): WorkflowRunState {
  if (buckets === run.unlistedByPhase) return run;
  if (buckets === undefined || buckets.length === 0) {
    if (run.unlistedByPhase === undefined) return run;
    const { unlistedByPhase: _emptied, ...withoutKey } = run;
    return withoutKey;
  }
  return { ...run, unlistedByPhase: [...buckets] };
}

function atLeastZero(value: number): number {
  return value > 0 ? value : 0;
}
