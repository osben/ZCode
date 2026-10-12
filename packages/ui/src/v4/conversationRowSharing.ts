// Conversation row structural sharing (docs/performance/conversation-row-structural-sharing.md).
//
// Bug cause: when the store receives a whole snapshot / row.upserted it swaps in freshly deserialized row
// objects, with zero sharing between historical snapshots; the SessionPane closure chain also retains
// hundreds of historical snapshots, so a single 200KB tool inputText ended up stored a hundred-plus times
// in the heap. Here, at the UI store layer, we swap the "deeply equal by value" parts back to the old
// references. Only identity is reused, semantics unchanged, so this does not go into @zcode/shared's apply
// (the client-side apply takes no semantic branches).
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Returns a value deeply equal to next, reusing as much of prev as possible: if fully equal, prev is
 * returned; on partial equality a new shell is created with prev's child values hung back on (including
 * old string references with identical content). Never mutates next — it may share structure with other
 * snapshots produced by apply. Only recurses into JSON shapes (plain objects / arrays).
 */
export function shareStructure<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    let allPrev = prev.length === next.length;
    let changed = false;
    const out = next.map((item: unknown, index) => {
      const shared = index < prev.length ? shareStructure(prev[index], item) : item;
      if (shared !== item) changed = true;
      if (index >= prev.length || shared !== prev[index]) allPrev = false;
      return shared;
    });
    if (allPrev) return prev as T;
    return (changed ? out : next) as T;
  }
  if (isPlainObject(next)) {
    if (!isPlainObject(prev)) return next;
    const keys = Object.keys(next);
    let allPrev = keys.length === Object.keys(prev).length;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const item = next[key];
      const hasPrev = Object.hasOwn(prev, key);
      const shared = hasPrev ? shareStructure(prev[key], item) : item;
      if (shared !== item) changed = true;
      if (!hasPrev || shared !== prev[key]) allPrev = false;
      out[key] = shared;
    }
    if (allPrev) return prev as T;
    return (changed ? out : next) as T;
  }
  // Primitives: strings with identical content are swapped back to the prev reference so next's copy can be GC'd.
  return (typeof next === "string" && prev === next ? prev : next) as T;
}

/**
 * A row pool across stores: held by SessionDataLayer with a lifetime longer than a single store (a cold
 * open after keep-warm expiry creates a new store, but old snapshots may still be retained, and new rows
 * should reuse them). Holds only WeakRef, never extends a row's lifetime.
 */
export class ConversationRowPool {
  private readonly rows = new Map<string, WeakRef<ConversationRow>>();
  private readonly registry = new FinalizationRegistry<{
    key: string;
    ref: WeakRef<ConversationRow>;
  }>(({ key, ref }) => {
    // Only delete entries still pointing at the collected row, to avoid wrongly deleting a new row
    // registered later under the same key.
    if (this.rows.get(key) === ref) this.rows.delete(key);
  });

  private key(topic: string, rowId: number): string {
    return `${topic}\u0000${rowId}`;
  }

  /** Registers without comparing: the new strings of a streaming row.delta are new anyway; per-frame deep comparison is pure overhead. */
  remember(topic: string, row: ConversationRow): void {
    const key = this.key(topic, row.rowId);
    if (this.rows.get(key)?.deref() === row) return;
    const ref = new WeakRef(row);
    this.rows.set(key, ref);
    this.registry.register(row, { key, ref });
  }

  shareRow(topic: string, row: ConversationRow): ConversationRow {
    const prev = this.rows.get(this.key(topic, row.rowId))?.deref();
    const shared = prev ? shareStructure(prev, row) : row;
    this.remember(topic, shared);
    return shared;
  }

  /** Shares row by row; reuses the prevWindow array when every row equals its position-matched prevWindow row. */
  shareWindow(
    topic: string,
    rows: ConversationRow[],
    prevWindow?: readonly ConversationRow[],
  ): ConversationRow[] {
    let allPrev = prevWindow !== undefined && prevWindow.length === rows.length;
    let changed = false;
    const out = rows.map((row, index) => {
      const shared = this.shareRow(topic, row);
      if (shared !== row) changed = true;
      if (allPrev && shared !== prevWindow![index]) allPrev = false;
      return shared;
    });
    if (allPrev) return prevWindow as ConversationRow[];
    return changed ? out : rows;
  }
}
