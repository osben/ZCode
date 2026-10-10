// Canonical implementation of delta application semantics (pure functions).
// This is part of the protocol semantics: this function defines whether coalesce preserves semantics —
// applyAll(s, coalesce(ds)) must be byte-for-byte identical to applyAll(s, ds) (golden test).
// The client store's apply logic is a host-specific adaptation of this function and must not introduce extra branches.
import type { ConversationDelta } from "./delta.js";
import type { ConversationSnapshot } from "./snapshot.js";
import type { ConversationRow } from "./rows.js";
import type { StreamablePath } from "./core.js";
import { applyWorkflowRunRemoved, applyWorkflowRunUpdated } from "./workflow-runs-delta.js";

/**
 * Used only by the server to reduce batches within an unpublished candidate snapshot.
 *
 * During cold recovery, calling immutable apply for each item copies the growing rows.window on every append/upsert
 * and linearly searches for rowId again, degrading long sessions to O(N²). The candidate snapshot is not yet visible externally,
 * so this explicit isolation boundary can reuse the same array and incremental index; ordinary clients continue using the
 * immutable semantics above so later events cannot mutate a published snapshot.
 */
export interface MutableConversationSnapshotAccumulator {
  snapshot: ConversationSnapshot;
  rowIndexById: Map<number, number>;
}

export function createMutableConversationSnapshotAccumulator(
  snapshot: ConversationSnapshot,
): MutableConversationSnapshotAccumulator {
  const window = [...snapshot.rows.window];
  return {
    snapshot: {
      ...snapshot,
      rows: { ...snapshot.rows, window },
    },
    rowIndexById: new Map(window.map((row, index) => [row.rowId, index])),
  };
}

// row.delta may only apply to streaming rows (an invariant guaranteed by the server).
// Protocol semantics for this function: no-op when the path or row does not exist (a patch targeting an unloaded row is a no-op).
function appendToRow(row: ConversationRow, path: StreamablePath, append: string): ConversationRow {
  switch (path) {
    case "text":
      if (row.kind === "assistantText" || row.kind === "reasoning") {
        return { ...row, text: row.text + append };
      }
      return row;
    case "inputText":
      if (row.kind === "toolCall") {
        return { ...row, inputText: row.inputText + append };
      }
      return row;
    case "output.text":
      if (row.kind === "toolCall" && row.output) {
        return {
          ...row,
          output: { ...row.output, text: row.output.text + append },
        };
      }
      return row;
    case "summaryText":
      if (row.kind === "subagent") {
        return { ...row, summaryText: row.summaryText + append };
      }
      return row;
  }
}

/** Applies one delta and returns a new snapshot (the input is not mutated). */
export function applyConversationDelta(
  snapshot: ConversationSnapshot,
  delta: ConversationDelta,
): ConversationSnapshot {
  switch (delta.op) {
    case "row.appended":
      return {
        ...snapshot,
        rows: {
          ...snapshot.rows,
          window: [...snapshot.rows.window, delta.row],
          totalCount: snapshot.rows.totalCount + 1,
          firstRowId: snapshot.rows.firstRowId ?? delta.row.rowId,
        },
      };
    case "row.upserted": {
      const index = snapshot.rows.window.findIndex((row) => row.rowId === delta.row.rowId);
      // An unloaded rowId is a no-op (evicted rows can only be retrieved through rows/range).
      if (index === -1) return snapshot;
      const window = [...snapshot.rows.window];
      window[index] = delta.row;
      return { ...snapshot, rows: { ...snapshot.rows, window } };
    }
    case "row.removed": {
      const window = snapshot.rows.window.filter((row) => row.rowId < delta.fromRowId);
      const removed = snapshot.rows.window.length - window.length;
      const removesEntireActiveBranch =
        snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      return {
        ...snapshot,
        rows: {
          ...snapshot.rows,
          window,
          // After the first rewind, rowId continues increasing monotonically; if the old firstRowId is retained, the UI will mistake
          // rowId gaps left by the old branch for "load earlier." Both full and tail windows must clear
          // the active-branch pagination anchor and count when truncating from the first row, then establish a new first row on the next append.
          totalCount: removesEntireActiveBranch
            ? 0
            : Math.max(0, snapshot.rows.totalCount - removed),
          firstRowId: removesEntireActiveBranch ? null : snapshot.rows.firstRowId,
        },
      };
    }
    case "row.delta": {
      const index = snapshot.rows.window.findIndex((row) => row.rowId === delta.rowId);
      const target = snapshot.rows.window[index];
      if (index === -1 || target === undefined) return snapshot;
      const window = [...snapshot.rows.window];
      window[index] = appendToRow(target, delta.path, delta.append);
      return { ...snapshot, rows: { ...snapshot.rows, window } };
    }
    case "state.updated":
      // Replace the entire value at each key: keys present in the patch overwrite existing values and are never deep-merged.
      return { ...snapshot, ...delta.patch };
    // workflowRuns is the only state key with an incremental update path (delta.ts explains why). The full rule lives in
    // workflow-runs-delta.ts; both twins delegate to it, so their semantics cannot drift apart.
    case "workflowRun.updated":
      return {
        ...snapshot,
        workflowRuns: applyWorkflowRunUpdated(snapshot.workflowRuns, delta),
      };
    case "workflowRun.removed":
      return {
        ...snapshot,
        workflowRuns: applyWorkflowRunRemoved(snapshot.workflowRuns, delta),
      };
  }
}

/** Applies a sequence of deltas in order. */
export function applyConversationDeltas(
  snapshot: ConversationSnapshot,
  deltas: readonly ConversationDelta[],
): ConversationSnapshot {
  let current = snapshot;
  for (const delta of deltas) {
    current = applyConversationDelta(current, delta);
  }
  return current;
}

/**
 * Applies one delta in place to an unpublished candidate snapshot; semantics must match applyConversationDelta.
 * Callers must not expose accumulator.snapshot to subscribers and then call this function again.
 */
export function applyConversationDeltaMutable(
  accumulator: MutableConversationSnapshotAccumulator,
  delta: ConversationDelta,
): void {
  const snapshot = accumulator.snapshot;
  switch (delta.op) {
    case "row.appended":
      accumulator.rowIndexById.set(delta.row.rowId, snapshot.rows.window.length);
      snapshot.rows.window.push(delta.row);
      snapshot.rows.totalCount += 1;
      snapshot.rows.firstRowId ??= delta.row.rowId;
      return;
    case "row.upserted": {
      const index = accumulator.rowIndexById.get(delta.row.rowId);
      if (index === undefined) return;
      snapshot.rows.window[index] = delta.row;
      return;
    }
    case "row.removed": {
      const removesEntireActiveBranch =
        snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      let writeIndex = 0;
      for (const row of snapshot.rows.window) {
        if (row.rowId >= delta.fromRowId) continue;
        snapshot.rows.window[writeIndex] = row;
        writeIndex += 1;
      }
      const removed = snapshot.rows.window.length - writeIndex;
      snapshot.rows.window.length = writeIndex;
      snapshot.rows.totalCount = removesEntireActiveBranch
        ? 0
        : Math.max(0, snapshot.rows.totalCount - removed);
      snapshot.rows.firstRowId = removesEntireActiveBranch ? null : snapshot.rows.firstRowId;
      accumulator.rowIndexById.clear();
      snapshot.rows.window.forEach((row, index) => accumulator.rowIndexById.set(row.rowId, index));
      return;
    }
    case "row.delta": {
      const index = accumulator.rowIndexById.get(delta.rowId);
      if (index === undefined) return;
      const target = snapshot.rows.window[index];
      if (target === undefined) return;
      snapshot.rows.window[index] = appendToRow(target, delta.path, delta.append);
      return;
    }
    case "state.updated":
      // As in the immutable implementation, replace each key present in the patch; do not deep-merge.
      Object.assign(snapshot, delta.patch);
      return;
    // The immutable implementation calls the same pure function: workflowRuns is a state key, not a rows window, so there is no in-place append optimization,
    // and accumulator.snapshot already belongs to the candidate snapshot, so assigning a new container cannot affect a published snapshot.
    case "workflowRun.updated":
      snapshot.workflowRuns = applyWorkflowRunUpdated(snapshot.workflowRuns, delta);
      return;
    case "workflowRun.removed":
      snapshot.workflowRuns = applyWorkflowRunRemoved(snapshot.workflowRuns, delta);
  }
}

/** Applies a sequence of deltas in place, only for an unpublished candidate snapshot. */
export function applyConversationDeltasMutable(
  accumulator: MutableConversationSnapshotAccumulator,
  deltas: readonly ConversationDelta[],
): void {
  for (const delta of deltas) applyConversationDeltaMutable(accumulator, delta);
}
