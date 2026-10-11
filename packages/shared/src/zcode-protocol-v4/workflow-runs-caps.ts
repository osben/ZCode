// ============================================================
// Boundary accounting: rejected-instance counters, the whole-key entry budget, and the single step-counting rule for readers
// ============================================================
// Lives outside the main reduction file for the same reason as workflow-runs-concurrency.ts /
// -phases.ts / -started.ts (the main file's max-lines limit), and follows the same discipline:
// pure functions, no clock, no I/O.
//
// These three things are facets of one concern. The limit's semantics are **reject-new** (existing
// entries keep updating), so a run wide enough to hit the limit always has some instances that
// never enter the table:
//   - Counters make rejected instances **countable**; `truncated` only says that some data was omitted, not how much.
//   - The entry budget keeps the entire state key **bounded**; the per-run limit multiplied by maxRuns comes too close to the snapshot limit.
//   - workflowRunStepCounts is the only permitted way to count steps. It combines listed and
//     unlisted entries; the three readers (run card, timeline summary, TUI mirror) used to count
//     separately, so the same run showed three different step counts.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunState,
  type WorkflowRunUsage,
} from "./workflow-runs.js";

/** How an event for a rejected instance affects the two counters. */
export interface UnlistedInstanceEvent {
  /** This instance was rejected by the upsert limit, rather than already being in the table and updated in place. */
  rejected: boolean;
  /** Whether this event advanced the run's watermark. False means a replay or late event; leave both counters unchanged. */
  advancesWaterMark: boolean;
  eventType: string;
  /** The `cached` flag on `node-settled`: a cache-hit settlement has no queued event, so it is itself the birth event. */
  cached: boolean;
}

/**
 * Record an event for a **rejected** instance in the two usage counters.
 *
 * There are two birth events (matching the phaseName / node-progress checks in the main reducer): `node-queued`
 * and `node-settled { cached: true }` emitted directly on a replay cache hit. Intermediate phases are not counted; they describe
 * the same instance progressing, not a new instance.
 *
 * Why `nodesUnlistedSettled` does not need clamping to `nodesUnlisted`: within one run, the engine emits at most one `node-queued` per instance
 * (repair / nudge does not requeue, and there are no backoff retries) and at most one `node-settled` (guarded by the scheduler's settled latch); a cache-hit settlement includes its own birth. Therefore, settled count ≤ birth count is structural. If that ever stops being true, the engine or `run-started` reset is broken; clamping would only hide the bug.
 */
export function countUnlistedInstance(
  usage: WorkflowRunUsage,
  event: UnlistedInstanceEvent,
): WorkflowRunUsage {
  if (!event.rejected || !event.advancesWaterMark) return usage;
  const settled = event.eventType === "node-settled";
  const born = event.eventType === "node-queued" || (settled && event.cached);
  if (!born && !settled) return usage;
  const nodesUnlisted = (usage.nodesUnlisted ?? 0) + (born ? 1 : 0);
  const nodesUnlistedSettled = (usage.nodesUnlistedSettled ?? 0) + (settled ? 1 : 0);
  return {
    ...usage,
    // Omit the entire key when zero, matching reports / pendingQuestions: runs that never hit a limit gain no extra key.
    ...(nodesUnlisted > 0 ? { nodesUnlisted } : {}),
    ...(nodesUnlistedSettled > 0 ? { nodesUnlistedSettled } : {}),
  };
}

/**
 * A **previously unlisted** instance returned to the node table (activation in workflow-runs-eviction.ts dispatched work and reinserted it):
 * decrement `nodesUnlisted`.
 *
 * Clamp at zero instead of allowing a negative value: this counter is **incremented** without identities for deduplication, and an instance returning to the table should have been counted already (at rejected birth or eviction). Clamping may undercount by one; without it, a negative value goes over the protocol and readers add it directly to the step total. When it reaches zero, omit the whole key (matching {@link countUnlistedInstance}), so remove the key instead of writing zero.
 */
export function discountUnlistedInstance(usage: WorkflowRunUsage): WorkflowRunUsage {
  const current = usage.nodesUnlisted ?? 0;
  if (current === 0) return usage;
  const { nodesUnlisted: _returned, nodesUnlistedSettled: settled, ...head } = usage;
  return {
    ...head,
    ...(current > 1 ? { nodesUnlisted: current - 1 } : {}),
    ...(settled === undefined ? {} : { nodesUnlistedSettled: settled }),
  };
}

/**
 * Whole-key entry budget ({@link WORKFLOW_RUNS_LIMITS.maxTotalEntries}): when exceeded, evict the **oldest terminal run**
 * until within budget or no eligible run remains.
 *
 * Three things are never evicted: active runs (`pending` / `running`), because removing their entries while they produce facts would blind the panel;
 * the run receiving the event, because the new fact must be retained; and **partial** entries from any run, because this protocol has no entry-deletion operation and removing only some entries would break downstream deltas (diffs can resend only a whole key).
 *
 * Pure and deterministic: only the order of `runs` (oldest first) and each status matter, so replaying events from a cold start evicts the same set.
 * Within budget, return **the same array** to preserve unchanged run references and the delta fast path.
 */
export function evictForEntryBudget(
  runs: WorkflowRunState[],
  eventRunId: string,
): WorkflowRunState[] {
  let total = 0;
  for (const run of runs) total += run.nodes.length + run.actors.length;
  if (total <= WORKFLOW_RUNS_LIMITS.maxTotalEntries) return runs;
  let remaining = runs;
  while (total > WORKFLOW_RUNS_LIMITS.maxTotalEntries) {
    const index = remaining.findIndex(
      (run) => run.runId !== eventRunId && run.status !== "pending" && run.status !== "running",
    );
    // Nothing is eligible (all runs are active, or only the event's run remains): keep the over-budget state.
    // Exceeding the budget honestly is better than erasing a live run from the panel to preserve a number.
    if (index < 0) break;
    total -= remaining[index]!.nodes.length + remaining[index]!.actors.length;
    remaining = [...remaining.slice(0, index), ...remaining.slice(index + 1)];
  }
  return remaining;
}

/**
 * Count how many steps a run has taken and settled — **listed + unlisted**.
 *
 * All readers (run card, timeline summary, TUI mirror) must use this function. They previously counted `nodes` independently, so the same
 * run that hit the limit showed three different counts, all below its actual step count.
 */
export function workflowRunStepCounts(run: WorkflowRunState): { total: number; settled: number } {
  let settledInList = 0;
  for (const node of run.nodes) if (node.phase === "settled") settledInList += 1;
  return {
    total: run.nodes.length + (run.usage.nodesUnlisted ?? 0),
    settled: settledInList + (run.usage.nodesUnlistedSettled ?? 0),
  };
}
