// Pure coalescing functions: merge rules used by the CLI flush buffer.
// Semantics: coalesce(deltas) must be equivalent to delivering each delta individually. Both delivery profiles must produce byte-for-byte identical terminal state for the same event sequence. Merging must not change the final state after apply.
//
// Rules (closed set):
//   1. Adjacent row.delta entries with the same (rowId, path) concatenate append values.
//   2. Adjacent state.updated entries shallow-merge patch keys (whole-key replacement makes this safe).
//   3. A row.upserted with the same rowId after row.delta drops the earlier delta (whole-row replacement includes all appends).
//   4. row.removed is a barrier that no rule may cross.
//   5. Splitting frames that exceed limits is outside this function (the transport frames them).
//   6. Merge workflowRun.updated entries with the same runId into the **earliest** one (see mergeWorkflowRunUpdate below).
import type { ConversationDelta, WorkflowRunUpdatedDelta } from "./delta.js";
import {
  mergeWorkflowRunUpdates,
  workflowRunUpdateWithinWireBounds,
  type WorkflowRunWireBounds,
} from "./workflow-runs-delta.js";

function isBarrier(delta: ConversationDelta): boolean {
  return delta.op === "row.removed";
}

/**
 * Barriers for rule 6: places that replace the entire `workflowRuns` key (`state.updated` includes that key) and `workflowRun.removed` for
 * **the same run**. Other operations and this run's deltas affect disjoint state and commute: row operations do not touch the state key, another run's delta does not touch this run,
 * and a state.updated without workflowRuns does not touch this key.
 */
function isWorkflowRunBarrier(delta: ConversationDelta, runId: string): boolean {
  if (delta.op === "state.updated") return delta.patch.workflowRuns !== undefined;
  return delta.op === "workflowRun.removed" && delta.runId === runId;
}

/**
 * Rule 6: merge a `workflowRun.updated` into the **last** delta in the window with the same runId.
 *
 * Why search backward instead of checking only adjacent entries: a run with broad fan-out emits one delta per engine event, and other runs and row operations
 * can separate them in the window. Merging only adjacent entries would merge none of them.
 *
 * Why target the **last** entry rather than an earlier one: when merges succeed, at most one delta for the same run remains after a barrier
 * (each new one is merged into it). “Earliest” and “last” are then the same operation, and the merge stays at the earliest position,
 * preserving birth order in `runs[]`. If a merge is rejected, two entries remain. Merging into the **earlier** one would move a later upsert
 * before an intervening removal, making a key that was removed and then re-added disappear.
 *
 * The merged operation stays at the earlier position but carries a later revision, so apply takes the maximum container revision (see
 * applyWorkflowRunUpdated). A merge cannot **construct** a complete header, so it cannot turn two no-op updates to an unknown run into a newly created run (see isCompleteWorkflowRunHeader).
 *
 * If the merged payload **exceeds wire limits**, do not merge (keep both operations as-is so individual delivery reaches the same terminal state).
 * Freeing a slot would break the bound “distinct keys removed in one window ≤ table limit,” and an oversized frame is dropped in full. See
 * workflowRunUpdateWithinWireBounds for the rationale.
 *
 * Returns true when the update has been merged, so the caller does not push it again.
 */
function mergeWorkflowRunUpdate(
  result: ConversationDelta[],
  delta: WorkflowRunUpdatedDelta,
  bounds: WorkflowRunWireBounds | undefined,
): boolean {
  let target = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    const prev = result[i];
    if (prev === undefined || isWorkflowRunBarrier(prev, delta.runId)) break;
    if (prev.op === "workflowRun.updated" && prev.runId === delta.runId) {
      target = i;
      break;
    }
  }
  if (target < 0) return false;
  const merged = mergeWorkflowRunUpdates(result[target] as WorkflowRunUpdatedDelta, delta);
  // If rejected, **do not try an earlier entry**; that is exactly how the intervening removal described above would be crossed.
  if (!workflowRunUpdateWithinWireBounds(merged, bounds)) return false;
  result[target] = merged;
  return true;
}

/**
 * Semantics-preserving merge of the delta sequence in one flush window.
 * Input and output both follow authoritative log order; this is a pure function and does not mutate its input.
 * `bounds` defaults to protocol capacity limits; merged state must match the result of applying each delta individually.
 */
export function coalesceConversationDeltas(
  deltas: readonly ConversationDelta[],
  bounds?: WorkflowRunWireBounds,
): ConversationDelta[] {
  const result: ConversationDelta[] = [];

  for (const delta of deltas) {
    // Rule 3: row.upserted subsumes earlier row.delta entries for the same rowId.
    // Search only back to the nearest barrier (rule 4), and do not cross a prior upserted/appended for that rowId;
    // crossing it would drop appends from the previous row generation and change terminal state.
    if (delta.op === "row.upserted") {
      for (let i = result.length - 1; i >= 0; i--) {
        const prev = result[i];
        if (prev === undefined || isBarrier(prev)) break;
        if (prev.op === "row.delta" && prev.rowId === delta.row.rowId) {
          result.splice(i, 1);
          continue;
        }
        if (
          (prev.op === "row.upserted" || prev.op === "row.appended") &&
          prev.row.rowId === delta.row.rowId
        ) {
          break;
        }
      }
    }

    // Rule 6: eviction subsumes all earlier deltas for the run (birth + eviction in one window means the client never saw the run,
    // equivalent to individual delivery's terminal state). Search backward only to the nearest barrier.
    if (delta.op === "workflowRun.removed") {
      for (let i = result.length - 1; i >= 0; i--) {
        const prev = result[i];
        if (prev === undefined || isWorkflowRunBarrier(prev, delta.runId)) break;
        if (prev.op === "workflowRun.updated" && prev.runId === delta.runId) result.splice(i, 1);
      }
    }

    if (delta.op === "workflowRun.updated" && mergeWorkflowRunUpdate(result, delta, bounds))
      continue;

    const last = result[result.length - 1];

    // Rule 1: concatenate adjacent row.delta entries with the same (rowId, path).
    if (
      delta.op === "row.delta" &&
      last?.op === "row.delta" &&
      last.rowId === delta.rowId &&
      last.path === delta.path
    ) {
      result[result.length - 1] = {
        op: "row.delta",
        rowId: delta.rowId,
        path: delta.path,
        append: last.append + delta.append,
      };
      continue;
    }

    // Rule 2: shallow-merge adjacent state.updated entries (later keys override earlier ones; whole-key replacement makes this safe).
    if (delta.op === "state.updated" && last?.op === "state.updated") {
      result[result.length - 1] = {
        op: "state.updated",
        patch: { ...last.patch, ...delta.patch },
      };
      continue;
    }

    // Adjacent row.upserted entries with the same rowId: keep the last one (transitivity of whole-row replacement).
    if (
      delta.op === "row.upserted" &&
      last?.op === "row.upserted" &&
      last.row.rowId === delta.row.rowId
    ) {
      result[result.length - 1] = delta;
      continue;
    }

    result.push(delta);
  }

  return result;
}

/**
 * Conflation helper for latest-state topics such as sessions-index: keep only the last update for each key.
 * Preserve order by outputting retained items in the order of their last occurrence.
 */
export function conflateByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const lastIndexByKey = new Map<string, number>();
  items.forEach((item, index) => {
    lastIndexByKey.set(keyOf(item), index);
  });
  return items.filter((item, index) => lastIndexByKey.get(keyOf(item)) === index);
}
