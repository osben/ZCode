// ============================================================
// Upsert semantics for the **bounded tables** in workflowRuns.
// ============================================================
// Pure functions for updating table entries and checking capacity; they do not read the clock or perform I/O.
//
// These two functions cover both halves of the same rule: how a table identifies the same record, and
// what to do when it is full. At capacity, **reject new entries but continue updating existing ones**;
// freezing a running instance at "queued" would mislead readers more than omitting one instance (the
// diagram would show that step as never started). Deciding what may make room for a new entry is a
// workflow-runs-eviction.ts.

import type { WorkflowRunPendingQuestion } from "./workflow-runs.js";

/** Result of one bounded upsert. `truncated` means the record **was not added to the table**, not that an existing record was updated in place. */
export interface BoundedUpsert<T> {
  list: T[];
  truncated: boolean;
}

/**
 * Upsert into a bounded list by (siteId, ordinal), the deduplication key for actors, nodes, and reports.
 *
 * `admitNew: false` extends "do not admit new entries" beyond the capacity limit (for replayed events or
 * an intermediate phase for an instance outside the table; see `born` in the reducer's node branch).
 * Its result is **identical** to capacity rejection because both mean the instance is not in the table.
 * Callers count it the same way.
 */
export function upsertBoundedByInstance<T extends { siteId: string; ordinal: number }>(
  list: readonly T[],
  entry: T,
  limit: number,
  options: { admitNew?: boolean } = {},
): BoundedUpsert<T> {
  const index = list.findIndex(
    (item) => item.siteId === entry.siteId && item.ordinal === entry.ordinal,
  );
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (options.admitNew === false || list.length >= limit) {
    return { list: [...list], truncated: true };
  }
  return { list: [...list, entry], truncated: false };
}

/**
 * Upsert into the bounded waiting-question table by `qid`.
 *
 * Uses the same capacity rule as {@link upsertBoundedByInstance} (reject new entries, update existing
 * ones), but with a different key: questions do not have site-instance identity, so qid is the key.
 * Keep this separate instead of using a generic function because key selection is the main distinction;
 * a generic call site would hide how this table deduplicates entries behind a key-selector callback.
 */
export function upsertBoundedByQid(
  list: readonly WorkflowRunPendingQuestion[],
  entry: WorkflowRunPendingQuestion,
  limit: number,
): BoundedUpsert<WorkflowRunPendingQuestion> {
  const index = list.findIndex((item) => item.qid === entry.qid);
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}
