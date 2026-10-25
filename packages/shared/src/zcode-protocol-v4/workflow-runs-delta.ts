// ============================================================
// Key-level deltas for workflowRuns: diff (producer), apply (consumer), and canonical key order
// ============================================================
// Why this exists: `workflowRuns` is a **high-frequency** state key, while `state.updated` means replacing a whole key.
// One engine event changes one node but previously resent the entire table — O(N) bytes per event and O(N²) over a full run.
// This caused nodes/subagents to be capped at 256 and silently omitted after wide fan-out reached the limit. This module computes “what
// changed in this step,” making wire bytes proportional to the **change size**, not the state size.
//
// Three structural facts are useful before reading the code, otherwise a few branches may look like fallbacks:
//   1. The reducer only **evicts** terminal entries when a table is full; it never reorders (workflow-runs-eviction.ts). So diff's
//      fast path still compares by index and falls back to key-based comparison only when indices no longer align, to find “what left”; if it sees a reorder,
//      it cannot represent it and resends the whole key (see RESYNC).
//   2. The reducer creates a new object only for the **run that changed**; other runs and unchanged entries retain their references. So
//      diff first checks references, and deep comparison happens only for the run that actually changed.
//   3. Correctness never depends on references: matching references are only a fast path; otherwise it always falls back to structural comparison.
//
// Contract (pinned by property tests): for any pair (prior, next) produced by the reducer,
// `JSON.stringify(applyAll(snapshot with prior, diff(prior, next)).workflowRuns) === JSON.stringify(next)`
// — **byte-for-byte**, not merely deep-equal. Key order is therefore a first-class part of this module; see {@link canonicalWorkflowRun}.

import type {
  ConversationDelta,
  WorkflowRunEntryRef,
  WorkflowRunHeaderKey,
  WorkflowRunRemovedDelta,
  WorkflowRunUpdatedDelta,
} from "./delta.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunSchema,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunState,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/**
 * **Canonical key order** for a run object = declaration order in `workflowRunSchema`.
 *
 * The only part of byte-for-byte equality not guaranteed by “same values” is key order: the reducer advances state with `{...run, newKey: v}`,
 * so newly appearing optional keys (reports / phases / concurrency…) are appended to the object in **arrival order**, while apply
 * has no such history when rebuilding a run. Reorder both sides with this list so the order matches — which is why the reducer's
 * output also passes through this function (one shared point, not two).
 *
 * Derived from the schema rather than hand-copied: a hand-maintained run field list once caused
 * an incident (see the header comment in delta.ts).
 */
const WORKFLOW_RUN_KEYS = Object.keys(workflowRunSchema.shape) as (keyof WorkflowRunState)[];
const WORKFLOW_RUN_KEY_SET: ReadonlySet<string> = new Set<string>(WORKFLOW_RUN_KEYS);

/** header = run minus the two tables incrementally synchronized by (siteId, ordinal). Order still follows schema declaration order. */
export const WORKFLOW_RUN_HEADER_KEYS: readonly WorkflowRunHeaderKey[] = WORKFLOW_RUN_KEYS.filter(
  (key): key is WorkflowRunHeaderKey => key !== "actors" && key !== "nodes",
);

/**
 * **Required** keys in the header, also derived from schema (`safeParse(undefined)` succeeds = optional).
 * Used in one place only: determine whether the header in a `workflowRun.updated` is sufficient for an unknown run to **be born**.
 */
const runShape = workflowRunSchema.shape as unknown as Record<
  string,
  { safeParse: (value: unknown) => { success: boolean } }
>;
const WORKFLOW_RUN_REQUIRED_HEADER_KEYS: readonly WorkflowRunHeaderKey[] =
  WORKFLOW_RUN_HEADER_KEYS.filter((key) => !runShape[key]!.safeParse(undefined).success);

/** Deduplication key for the two instance tables. The `\0` separator has the same reason as the reducer's derived actor state: ("a",12) and ("a1",2) must not collide. */
export function workflowRunEntryKey(entry: { siteId: string; ordinal: number }): string {
  return `${entry.siteId}\0${entry.ordinal}`;
}

/**
 * Rebuild a run object in canonical key order (shallow rebuild: nested values retain their references because they come from the same facts).
 *
 * Treat keys with an `undefined` value as absent, matching `JSON.stringify` semantics — the protocol has only “key present” and
 * “key absent,” no third state. Keys outside the schema are appended in their original order: this module has no authority to drop caller data.
 */
export function canonicalWorkflowRun(run: WorkflowRunState): WorkflowRunState {
  const source = run as unknown as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const key of WORKFLOW_RUN_KEYS) {
    const value = source[key];
    if (value !== undefined) canonical[key] = value;
  }
  for (const key of Object.keys(source)) {
    if (WORKFLOW_RUN_KEY_SET.has(key)) continue;
    const value = source[key];
    if (value !== undefined) canonical[key] = value;
  }
  return canonical as unknown as WorkflowRunState;
}

/**
 * Structural equality for JSON values. Shared by the reducer's idempotency predicate (previously a full-run `JSON.stringify` comparison costing
 * O(N) bytes per event) and diff's “did this key/entry change?” check, so the two predicates cannot diverge.
 *
 * Differs from `JSON.stringify` in only two ways, both **more** accurate: key order does not affect comparison; keys with an `undefined` value
 * are equivalent to absent keys (stringify also drops them).
 */
export function jsonValueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonValueEqual(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let present = 0;
  for (const key of Object.keys(left)) {
    const value = left[key];
    if (value === undefined) continue;
    present += 1;
    if (!jsonValueEqual(value, right[key])) return false;
  }
  let expected = 0;
  for (const key of Object.keys(right)) if (right[key] !== undefined) expected += 1;
  return present === expected;
}

/** Reducer idempotency predicate: replay the same event without content change and produce no delta or revision bump. */
export function workflowRunUnchanged(previous: WorkflowRunState, next: WorkflowRunState): boolean {
  return jsonValueEqual(previous, next);
}

/**
 * Whether a header is sufficient for an **unknown run to be born**: every required key is present.
 *
 * Only diff's “birth” branch creates a complete header — `runId` never changes for an existing run and is therefore never in
 * its patches, so merging multiple deltas (coalesce rule 6) cannot **assemble** a complete header. This invariant supports
 * the merge rule: merging cannot turn two no-ops for an unknown run into a birth from nothing.
 */
export function isCompleteWorkflowRunHeader(header: unknown): boolean {
  if (typeof header !== "object" || header === null) return false;
  const record = header as Record<string, unknown>;
  return WORKFLOW_RUN_REQUIRED_HEADER_KEYS.every((key) => record[key] !== undefined);
}

/**
 * Key-level delta between two workflowRuns states.
 *
 * There is one fallback: for an unrepresentable structural change (entries deleted or reordered; see item 1 in the header) or a revision change with
 * no operations, resend the whole key as `state.updated`. This is fully valid in the protocol (whole-key replacement)
 * and acts as a barrier in coalesce; the only cost is reverting to the pre-change byte volume.
 */
export function diffWorkflowRunsState(
  prior: WorkflowRunsState | undefined,
  next: WorkflowRunsState,
): ConversationDelta[] {
  const priorRuns = prior?.runs ?? [];
  const nextIds = new Set(next.runs.map((run) => run.runId));
  const ops: ConversationDelta[] = [];
  // Send evictions first, in prior order: the client removes departed runs before applying remaining deltas to the live table.
  for (const run of priorRuns) {
    if (nextIds.has(run.runId)) continue;
    ops.push({ op: "workflowRun.removed", runId: run.runId, revision: next.revision });
  }
  const priorById = new Map(priorRuns.map((run) => [run.runId, run]));
  for (const run of next.runs) {
    const before = priorById.get(run.runId);
    if (before === run) continue;
    const op = diffWorkflowRun(before, run, next.revision);
    if (op === null) return [{ op: "state.updated", patch: { workflowRuns: next } }];
    if (op !== undefined) ops.push(op);
  }
  // Revision changed with no operations: container version has no separate carrier, so resend the whole key.
  // The reducer never produces this input (it returns null when nothing changes), so this branch is not reached in production.
  if (ops.length === 0 && (prior?.revision ?? -1) !== next.revision) {
    return [{ op: "state.updated", patch: { workflowRuns: next } }];
  }
  return ops;
}

/** Delta for one run: `undefined` = no change, `null` = unrepresentable structural change (resend the whole key). */
function diffWorkflowRun(
  before: WorkflowRunState | undefined,
  run: WorkflowRunState,
  revision: number,
): WorkflowRunUpdatedDelta | undefined | null {
  const source = run as unknown as Record<string, unknown>;
  // key is a union of header keys, and TS narrows values to never on keyed assignment; assemble through a record here and assert at the boundary.
  const patch: Record<string, unknown> = {};
  const cleared: WorkflowRunHeaderKey[] = [];
  if (before === undefined) {
    // Birth: full header (including runId, which clients use to determine whether this op can create the entry) + all rows.
    for (const key of WORKFLOW_RUN_HEADER_KEYS) {
      const value = source[key];
      if (value !== undefined) patch[key] = value;
    }
    return {
      op: "workflowRun.updated",
      runId: run.runId,
      revision,
      run: patch as WorkflowRunUpdatedDelta["run"],
      ...(run.actors.length > 0 ? { actors: [...run.actors] } : {}),
      ...(run.nodes.length > 0 ? { nodes: [...run.nodes] } : {}),
    };
  }
  const previous = before as unknown as Record<string, unknown>;
  for (const key of WORKFLOW_RUN_HEADER_KEYS) {
    const left = previous[key];
    const right = source[key];
    if (left === right) continue;
    if (right === undefined) {
      cleared.push(key);
      continue;
    }
    if (left !== undefined && jsonValueEqual(left, right)) continue;
    patch[key] = right;
  }
  const actors = diffWorkflowRunEntries(before.actors, run.actors);
  const nodes = diffWorkflowRunEntries(before.nodes, run.nodes);
  if (actors === null || nodes === null) return null;
  const changedHeader = Object.keys(patch).length > 0 || cleared.length > 0;
  if (!changedHeader && actors === undefined && nodes === undefined) return undefined;
  // Key order = application order (header → deletions → upserts): if the same key is removed then added, it lands at the end, matching sequential application
  // of two ops.
  return {
    op: "workflowRun.updated",
    runId: run.runId,
    revision,
    ...(Object.keys(patch).length > 0 ? { run: patch as WorkflowRunUpdatedDelta["run"] } : {}),
    ...(cleared.length > 0 ? { cleared } : {}),
    ...(actors?.removed.length ? { removedActors: actors.removed } : {}),
    ...(nodes?.removed.length ? { removedNodes: nodes.removed } : {}),
    ...(actors?.changed.length ? { actors: actors.changed } : {}),
    ...(nodes?.changed.length ? { nodes: nodes.changed } : {}),
  };
}

/** Changes to one instance table in this step: removed entries (identity only) + changed entries (full values, in next order). */
interface EntryDiff<T> {
  removed: WorkflowRunEntryRef[];
  changed: T[];
}

/**
 * Changes between two instance tables. `undefined` = no change, `null` = unrepresentable structural change (resend the whole key).
 *
 * Fast path compares by **index**: the reducer normally appends and updates in place, so unchanged entries require only one
 * pointer comparison. First misalignment (different identity at an index, or prior longer than next) means an entry left — eviction
 * (workflow-runs-eviction.ts) — so fall back to key-based comparison to find “what left.”
 *
 * The key-based path still requires **survivors to align by index**: this model cannot express order changes beyond deletion (the protocol has no
 * entry-move operation), so it must resend the whole key.
 */
function diffWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  before: readonly T[],
  after: readonly T[],
): EntryDiff<T> | undefined | null {
  if (before === after) return undefined;
  if (before.length <= after.length) {
    const changed: T[] = [];
    let aligned = true;
    for (let index = 0; index < after.length && aligned; index += 1) {
      const entry = after[index]!;
      const previous = before[index];
      if (previous === undefined) {
        changed.push(entry);
        continue;
      }
      if (previous === entry) continue;
      if (previous.siteId !== entry.siteId || previous.ordinal !== entry.ordinal) aligned = false;
      else if (!jsonValueEqual(previous, entry)) changed.push(entry);
    }
    if (aligned) return changed.length > 0 ? { removed: [], changed } : undefined;
  }
  return diffWorkflowRunEntriesByKey(before, after);
}

function diffWorkflowRunEntriesByKey<T extends { siteId: string; ordinal: number }>(
  before: readonly T[],
  after: readonly T[],
): EntryDiff<T> | undefined | null {
  const survives = new Set(after.map(workflowRunEntryKey));
  const removed: WorkflowRunEntryRef[] = [];
  const survivors: T[] = [];
  for (const entry of before) {
    if (survives.has(workflowRunEntryKey(entry))) survivors.push(entry);
    else removed.push({ siteId: entry.siteId, ordinal: entry.ordinal });
  }
  if (survivors.length > after.length) return null;
  const changed: T[] = [];
  for (let index = 0; index < after.length; index += 1) {
    const entry = after[index]!;
    const previous = survivors[index];
    if (previous === undefined) {
      changed.push(entry);
      continue;
    }
    // Survivors must remain in their original order at the start of next; otherwise this is a reorder and the whole key must be resent.
    if (previous.siteId !== entry.siteId || previous.ordinal !== entry.ordinal) return null;
    if (previous === entry || jsonValueEqual(previous, entry)) continue;
    changed.push(entry);
  }
  if (removed.length === 0 && changed.length === 0) return undefined;
  return { removed, changed };
}

/**
 * Apply `workflowRun.updated`.
 *
 * Container revision uses **max**: coalesce can merge a later op into an earlier position (rule 6), so the last op in the output sequence
 * may not carry the highest revision. Revision is monotonic by contract; max makes byte-for-byte final-state equivalence before and after merging
 * independent of op position.
 *
 * Identity: unchanged runs and entries retain their references; the changed run and container are new objects — the GUI memoizes at these two levels.
 */
export function applyWorkflowRunUpdated(
  state: WorkflowRunsState | undefined,
  delta: WorkflowRunUpdatedDelta,
): WorkflowRunsState {
  const runs = state?.runs ?? [];
  const revision = Math.max(state?.revision ?? 0, delta.revision);
  const index = runs.findIndex((run) => run.runId === delta.runId);
  if (index < 0) {
    // Unknown run + complete header = birth; unknown run + incomplete header means this op is not about facts held by the client,
    // so treat it as a no-op (same decision as row.upserted for an unloaded row) and only advance container revision.
    if (!isCompleteWorkflowRunHeader(delta.run)) {
      return state !== undefined && state.revision === revision ? state : { revision, runs };
    }
    const born = canonicalWorkflowRun({
      ...(delta.run as Partial<WorkflowRunState>),
      actors: delta.actors === undefined ? [] : [...delta.actors],
      nodes: delta.nodes === undefined ? [] : [...delta.nodes],
    } as WorkflowRunState);
    return { revision, runs: [...runs, born] };
  }
  const existing = runs[index]!;
  const merged: Record<string, unknown> = { ...existing, ...delta.run };
  // “Empty ⇒ key absent” is the protocol contract for several keys, so the delta must express “this key was removed.”
  for (const key of delta.cleared ?? []) delete merged[key];
  // Application order: header → deletions → upserts. If the same key is removed then added within an op, it lands at the end, matching sequential
  // application of two ops; the reverse order (add then remove) would remove an entry that just returned.
  const actors = removeWorkflowRunEntries(existing.actors, delta.removedActors);
  const nodes = removeWorkflowRunEntries(existing.nodes, delta.removedNodes);
  if (actors !== existing.actors) merged.actors = actors;
  if (nodes !== existing.nodes) merged.nodes = nodes;
  if (delta.actors !== undefined && delta.actors.length > 0) {
    merged.actors = upsertWorkflowRunEntries(actors, delta.actors);
  }
  if (delta.nodes !== undefined && delta.nodes.length > 0) {
    merged.nodes = upsertWorkflowRunEntries(nodes, delta.nodes);
  }
  const next = [...runs];
  next[index] = canonicalWorkflowRun(merged as unknown as WorkflowRunState);
  return { revision, runs: next };
}

/** Apply `workflowRun.removed`: remove the run. An unknown runId only advances revision. */
export function applyWorkflowRunRemoved(
  state: WorkflowRunsState | undefined,
  delta: WorkflowRunRemovedDelta,
): WorkflowRunsState {
  const runs = state?.runs ?? [];
  const revision = Math.max(state?.revision ?? 0, delta.revision);
  const remaining = runs.filter((run) => run.runId !== delta.runId);
  if (remaining.length === runs.length) {
    return state !== undefined && state.revision === revision ? state : { revision, runs };
  }
  return { revision, runs: remaining };
}

/**
 * Remove entries by (siteId, ordinal); return **the same array** when none match (preserve references for untouched tables).
 * An unmatched key is a defined no-op: coalescing unions deletions from two ops, some of which may never have reached this client.
 */
function removeWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  current: readonly T[],
  removed: readonly { siteId: string; ordinal: number }[] | undefined,
): T[] {
  if (removed === undefined || removed.length === 0) return current as T[];
  const dropped = new Set(removed.map(workflowRunEntryKey));
  const next = current.filter((entry) => !dropped.has(workflowRunEntryKey(entry)));
  return next.length === current.length ? (current as T[]) : next;
}

/**
 * Upsert by (siteId, ordinal): replace existing keys in place and append new keys to the end.
 *
 * The client **never** applies limits (maxNodes / maxActors / maxRuns): only the producer may evict, and eviction must be explicit
 * (`workflowRun.removed` / `removedActors` / `removedNodes`). Client-side truncation would silently diverge the two sides.
 */
function upsertWorkflowRunEntries<T extends { siteId: string; ordinal: number }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const next = [...current];
  const indexByKey = new Map<string, number>();
  next.forEach((entry, index) => indexByKey.set(workflowRunEntryKey(entry), index));
  for (const entry of incoming) {
    const key = workflowRunEntryKey(entry);
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, next.length);
      next.push(entry);
      continue;
    }
    next[index] = entry;
  }
  return next;
}

/**
 * Are all four entry tables in a `workflowRun.updated` within their wire limits?
 *
 * The **two deletion tables** are what can exceed limits. Merged upsert tables are inherently bounded: by the merge rule, earlier upsert keys
 * deleted by the later op are removed, so every remaining key is still in the table after applying the op and the table itself stays within its limit.
 * Deletion tables have no such guard — the merge cannot distinguish “key born and evicted within this window” from “key the client already held”; each eviction frees a slot, so distinct keys deleted in a wide flush window can exceed 1024.
 * This was impossible before eviction: tables only grew, so distinct keys touched in one incarnation could not exceed the table limit.
 *
 * An oversized payload is not stripped of one key: it makes the whole patch fail to parse, the
 * frame is dropped, and that subscription goes silent from then on (the shape of the incident
 * recorded in workflow-runs.ts), while neither of the publisher's two backstops (500 ops / 1 MiB)
 * triggers at this size. Check all four tables because this guard is cheap and should not depend
 * on the argument above remaining valid.
 *
 * Merging is an **optimization**, so refusing to merge is always safe: each op is within limits, and delivering them separately preserves the final state byte-for-byte.
 */
export function workflowRunUpdateWithinWireBounds(
  delta: WorkflowRunUpdatedDelta,
  limits: WorkflowRunWireBounds = WORKFLOW_RUNS_LIMITS,
): boolean {
  return (
    (delta.actors?.length ?? 0) <= limits.maxActors &&
    (delta.removedActors?.length ?? 0) <= limits.maxActors &&
    (delta.nodes?.length ?? 0) <= limits.maxNodes &&
    (delta.removedNodes?.length ?? 0) <= limits.maxNodes
  );
}

/**
 * Wire limits for the entry tables. An injection point kept only for tests (the default is
 * {@link WORKFLOW_RUNS_LIMITS}): the real limit is 1024, and the "merge refused" path is
 * reachable only with a small limit, which the property tests need to actually exercise.
 */
export interface WorkflowRunWireBounds {
  readonly maxActors: number;
  readonly maxNodes: number;
}

/** Merge two `workflowRun.updated` ops for the same run (payload portion of coalesce rule 6; the rule itself is in coalesce.ts). */
export function mergeWorkflowRunUpdates(
  earlier: WorkflowRunUpdatedDelta,
  later: WorkflowRunUpdatedDelta,
): WorkflowRunUpdatedDelta {
  const run: Record<string, unknown> = { ...earlier.run, ...later.run };
  // Header keys and `cleared` are opposites and must cancel each other during merge: a key assigned later is no longer “cleared,”
  // and a key cleared later has no value. Keeping only one side makes apply write-then-delete (or delete-then-write), depending on key order.
  const laterCleared = new Set<string>(later.cleared ?? []);
  for (const key of laterCleared) delete run[key];
  const cleared: WorkflowRunHeaderKey[] = [];
  for (const key of earlier.cleared ?? []) {
    if (run[key] === undefined && !cleared.includes(key)) cleared.push(key);
  }
  for (const key of later.cleared ?? []) {
    if (!cleared.includes(key)) cleared.push(key);
  }
  const removedActors = mergeRemovedRefs(earlier.removedActors, later.removedActors);
  const removedNodes = mergeRemovedRefs(earlier.removedNodes, later.removedNodes);
  const actors = mergeEntryLists<WorkflowRunActor>(
    earlier.actors,
    later.actors,
    later.removedActors,
  );
  const nodes = mergeEntryLists<WorkflowRunNode>(earlier.nodes, later.nodes, later.removedNodes);
  return {
    op: "workflowRun.updated",
    runId: later.runId,
    // Keep the highest high-water mark: the merged op occupies the earlier position, so apply uses max to keep container revision at the highest value.
    revision: Math.max(earlier.revision, later.revision),
    ...(Object.keys(run).length > 0 ? { run: run as WorkflowRunUpdatedDelta["run"] } : {}),
    ...(cleared.length > 0 ? { cleared } : {}),
    ...(removedActors === undefined ? {} : { removedActors }),
    ...(removedNodes === undefined ? {} : { removedNodes }),
    ...(actors === undefined ? {} : { actors }),
    ...(nodes === undefined ? {} : { nodes }),
  };
}

/** Union deletions from both sides, deduplicating by first occurrence (deletion filters by key, so order affects bytes only). */
function mergeRemovedRefs(
  earlier: readonly WorkflowRunEntryRef[] | undefined,
  later: readonly WorkflowRunEntryRef[] | undefined,
): WorkflowRunEntryRef[] | undefined {
  if (earlier === undefined && later === undefined) return undefined;
  const merged: WorkflowRunEntryRef[] = [];
  const seen = new Set<string>();
  for (const ref of [...(earlier ?? []), ...(later ?? [])]) {
    const key = workflowRunEntryKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged.length > 0 ? merged : undefined;
}

/**
 * Entry tables are overwritten by later keys and preserve first-seen order; return undefined when neither side has entries (do not create the key).
 *
 * **Remove every earlier upsert key deleted by the later op**: sequential application inserts it, then removes it, so it must not appear in the merged op.
 * If the later op adds the same key back, it appears there only once and lands at the end — exactly where sequential application places it.
 */
function mergeEntryLists<T extends { siteId: string; ordinal: number }>(
  earlier: readonly T[] | undefined,
  later: readonly T[] | undefined,
  laterRemoved: readonly WorkflowRunEntryRef[] | undefined,
): T[] | undefined {
  if (earlier === undefined && later === undefined) return undefined;
  const dropped = new Set((laterRemoved ?? []).map(workflowRunEntryKey));
  const kept =
    dropped.size === 0
      ? (earlier ?? [])
      : (earlier ?? []).filter((entry) => !dropped.has(workflowRunEntryKey(entry)));
  const merged = upsertWorkflowRunEntries(kept, later ?? []);
  return merged.length > 0 ? merged : undefined;
}
