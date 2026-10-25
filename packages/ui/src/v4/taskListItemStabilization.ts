// Reference stabilization for task-list rows (shared across lanes).
//
// sessions-index / Controller tasks-index rebuilds the entire ZCodeTaskMeta[] on every content frame,
// even when content is unchanged (for example, only an activity timestamp the list does not use changed). Downstream consumers treat “a new array reference” as new data:
// grouped views refresh the whole tree, virtualizers remeasure, and workspace row caches are invalidated — appearing as
// “the whole left list reloads when a tool result appears on the right.” Stabilize references row by row: reuse the old object when content is equivalent;
// reuse the old array when the full list is equivalent, short-circuiting every memo/effect that depends on array/element identity.
import type { ZCodeTaskMeta } from "@zcode/shared";

export function buildTaskListItemIdentityKey(meta: ZCodeTaskMeta): string {
  return `${meta.workspaceIdentity?.trim() || meta.workspacePath}::${meta.taskId}`;
}

/**
 * Structural equivalence: ignore key insertion order and treat `undefined` values as absent (consistent with JSON serialization).
 *
 * Deliberately avoid `JSON.stringify` comparison: upstream Controller / tasks-index joins use conditional spreads
 * (`...(x ? { k: v } : {})`) extensively, so objects with identical content but different key order always differ as strings. Stabilization would
 * silently degrade into “a new reference every frame” — the “whole list flashes” regression would return without an error, log, or metric.
 * Field-by-field comparison avoids depending on this implicit construction-order assumption and exits at the first difference.
 */
export function areStabilizedValuesEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => areStabilizedValuesEquivalent(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => areStabilizedValuesEquivalent(leftRecord[key], rightRecord[key]));
}

/** Compare field by field (including nested structures; task metadata objects are small, so the cost is negligible). */
export function areTaskListItemsEquivalent(left: ZCodeTaskMeta, right: ZCodeTaskMeta): boolean {
  return areStabilizedValuesEquivalent(left, right);
}

/** Stabilize references: reuse old objects for equivalent rows and reuse the entire old array when order and content are unchanged. */
export function stabilizeTaskListItems<T extends ZCodeTaskMeta>(previous: T[], next: T[]): T[] {
  if (previous.length === 0) {
    // 空快照仍然等价；每次返回新空数组会使无任务项目的整棵目录失效。
    return next.length === 0 ? previous : next;
  }
  const previousByKey = new Map(
    previous.map((meta) => [buildTaskListItemIdentityKey(meta), meta] as const),
  );
  let identical = previous.length === next.length;
  const stabilized = next.map((meta, index) => {
    const previousMeta = previousByKey.get(buildTaskListItemIdentityKey(meta));
    if (previousMeta && areTaskListItemsEquivalent(previousMeta, meta)) {
      if (identical && previous[index] !== previousMeta) {
        identical = false;
      }
      return previousMeta;
    }
    identical = false;
    return meta;
  });
  return identical ? previous : stabilized;
}
