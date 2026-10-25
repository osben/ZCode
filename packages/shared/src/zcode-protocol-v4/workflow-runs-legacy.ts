// ============================================================
// Truncate workflowRuns for consumers **without** `workflowRunDeltas` capability.
// ============================================================
// This is not a display budget; it is wire compatibility: older consumer binaries validate actors/nodes with a limit of 256
// ({@link WORKFLOW_RUNS_LEGACY_LIMITS}), and parse errors on a known key **do not strip just that key** — they make the entire
// `state.updated` patch fail and the entire frame be dropped, silently ending that subscription. So after raising the limit to 1024, every frame sent to an old
// consumer (both whole-key patches folded from deltas and snapshots) must pass through this function first.
//
// Which 256 entries remain follows the same eviction principle as reduction (workflow-runs-eviction.ts): **keep active entries first**.
// Old mobile and new clients show the same thing — who is active now — while blindly taking "the first 256" would leave a wide run showing only
// the earliest already-finished entries on that client generation forever. Fill remaining slots with the earliest entries in table order; output stays in original table order.

import { canonicalWorkflowRun } from "./workflow-runs-delta.js";
import {
  WORKFLOW_RUNS_LEGACY_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/**
 * Truncate to the legacy bounds; set `truncated: true` on truncated runs (the read side uses it to show "showing details for only N/M steps").
 *
 * **Do not truncate anything else**: new optional keys unknown to old consumers are harmless (the
 * container is not strict, so extra keys are simply stripped), while stripping them for
 * "cleanliness" would require maintaining a second field list — exactly the shape of the
 * 2026-09-04 incident.
 *
 * Return the **same object** when no truncation is needed: this function runs on every flush, and creating a new state object unnecessarily would invalidate
 * downstream memoization by reference.
 */
export function clampWorkflowRunsForLegacy(state: WorkflowRunsState): WorkflowRunsState {
  let clamped = false;
  const runs = state.runs.map((run) => {
    const actors = clampKeepingLive(
      run.actors,
      WORKFLOW_RUNS_LEGACY_LIMITS.maxActors,
      (actor: WorkflowRunActor) => actor.status !== "completed",
    );
    const nodes = clampKeepingLive(
      run.nodes,
      WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes,
      (node: WorkflowRunNode) => node.phase !== "settled",
    );
    if (actors === run.actors && nodes === run.nodes) return run;
    clamped = true;
    // Use canonical key order: `truncated` may be a new key on this run, and spreading it directly would append it to the end of the object,
    // while the same state uses schema order elsewhere (reduction output, delta apply).
    return canonicalWorkflowRun({ ...run, actors, nodes, truncated: true });
  });
  return clamped ? { revision: state.revision, runs } : state;
}

/**
 * Truncate to `limit` entries: first keep **active entries** in table order, then fill remaining slots with the earliest entries in table order, and finally output in **original table order**
 * (two passes to select indices and one filter, so output order is table order rather than "active first").
 *
 * If active entries alone exceed the limit, take the first `limit` in table order — this still must be bounded, and older consumers' validation limits do not allow
 * exceptions. Return the same array when it is within bounds.
 */
function clampKeepingLive<T>(
  list: readonly T[],
  limit: number,
  isLive: (entry: T) => boolean,
): T[] {
  if (list.length <= limit) return list as T[];
  const kept = new Set<number>();
  for (let index = 0; index < list.length && kept.size < limit; index += 1) {
    if (isLive(list[index]!)) kept.add(index);
  }
  for (let index = 0; index < list.length && kept.size < limit; index += 1) {
    kept.add(index);
  }
  return list.filter((_, index) => kept.has(index));
}
