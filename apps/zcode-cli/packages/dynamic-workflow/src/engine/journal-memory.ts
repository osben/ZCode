/**
 * In-memory {@link JournalStorePort}: used in phase one for fake-driver tests and replay/resume.
 * Purely in-memory and synchronous; deep-copy on input and output so later writes cannot
 * accidentally mutate references held by callers (simulating a storage boundary).
 * The production implementation uses node:sqlite (DatabaseSync, synchronous) in the ZCode
 * session store and shares JournalStorePort. Transactions are not part of the port; the driver
 * combines journal and session writes.
 */

import type {
  ActorRecord,
  Caps,
  GetNodeOptions,
  JournalStorePort,
  ListActorsOptions,
  ListEventsOptions,
  ListNodesOptions,
  NodeKind,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
} from "./types.js";

/** Structured deep copy to isolate references on either side of the storage boundary. Values are JSON-compatible or plain data such as PersonaSpec. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Exported copy of a node row; `withResult: false` matches SQLite omitting `result_json` from the select (key absent). */
function nodeCopy(node: NodeRecord, withResult: boolean): NodeRecord {
  const copy = clone(node);
  if (!withResult) delete copy.result;
  return copy;
}

/** Composite key for an actor / node. */
function key(siteId: string, ordinal: number): string {
  return `${siteId}@${ordinal}`;
}

export class InMemoryJournalStore implements JournalStorePort {
  // Bucket by runId to match the storage semantics: one store can hold multiple runs.
  private readonly runs = new Map<string, RunRecord>();
  private readonly actors = new Map<string, Map<string, ActorRecord>>();
  private readonly nodes = new Map<string, Map<string, NodeRecord>>();
  private readonly events = new Map<string, StoredEvent[]>();

  createRun(record: RunRecord): void {
    if (this.runs.has(record.runId)) {
      throw new Error(`journal: run ${record.runId} already exists`);
    }
    this.runs.set(record.runId, clone(record));
    this.actors.set(record.runId, new Map());
    this.nodes.set(record.runId, new Map());
    this.events.set(record.runId, []);
  }

  getRun(runId: string): RunRecord | undefined {
    const r = this.runs.get(runId);
    return r === undefined ? undefined : clone(r);
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    r.status = status;
    if (status === "pending" || status === "running") {
      // Non-terminal means no settlement: when resume moves a run back to running, clear remnants
      // from its previous lifecycle, or the failure_json written by orphan reconciliation would
      // coexist with running (the journal snapshot would report both “running” and “failed”). Also
      // clear contradictory settlement data (failure/result attached to a non-terminal run).
      delete r.failure;
      delete r.result;
      delete r.stopReason;
      delete r.supersededBy;
      return;
    }
    // The failure tuple (failure / stopReason / supersededBy) is **rewritten as a whole**: the
    // settlement object contains the complete truth about this failure, and absent fields mean no
    // failure. Under the old “absent = leave untouched” semantics, an externally written failed +
    // Interrupted state survived a later completed settlement, so the row said both “completed”
    // and “interrupted” (SQLite uses the same coalesce behavior, so both implementations match).
    if (settlement?.stopReason === undefined) delete r.stopReason;
    else r.stopReason = settlement.stopReason;
    if (settlement?.supersededBy === undefined) delete r.supersededBy;
    else r.supersededBy = settlement.supersededBy;
    if (settlement?.failure === undefined) delete r.failure;
    else r.failure = clone(settlement.failure);
    // Artifacts follow the opposite rule: an absent key means “leave untouched,” so a repeated
    // settlement without an artifact does not erase the previously settled artifact. `result: null`
    // is a valid artifact; only undefined means absent.
    if (settlement?.result !== undefined) r.result = clone(settlement.result);
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    r.spentTokens = spentTokens;
  }

  updateRunCaps(runId: string, caps: Caps): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    // Deep-copy like other writes so references are not shared across the storage boundary: a later
    // replacement of the caller's caps must not accidentally modify the stored row.
    r.caps = clone(caps);
  }

  updateRunScript(runId: string, scriptText: string, scriptHash: string): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    // Write both columns together (resume compares the hash with the text); leave every other row field untouched, like updateRunUsage.
    r.scriptText = scriptText;
    r.scriptHash = scriptHash;
  }

  putActor(record: ActorRecord): void {
    const bucket = this.requireActorBucket(record.runId);
    bucket.set(key(record.siteId, record.ordinal), clone(record));
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const a = this.actors.get(runId)?.get(key(siteId, ordinal));
    return a === undefined ? undefined : clone(a);
  }

  listActors(runId: string, opts: ListActorsOptions): ActorRecord[] {
    const bucket = this.actors.get(runId);
    if (bucket === undefined) return [];
    const matched = [...bucket.values()].filter(
      (actor) => opts.name === undefined || actor.name === opts.name,
    );
    return matched.map((actor) => {
      const copy = clone(actor);
      if (!opts.withPersona) delete copy.persona;
      return copy;
    });
  }

  putNode(record: NodeRecord): void {
    const bucket = this.requireNodeBucket(record.runId);
    bucket.set(key(record.siteId, record.ordinal), clone(record));
  }

  getNode(
    runId: string,
    siteId: string,
    ordinal: number,
    opts?: GetNodeOptions,
  ): NodeRecord | undefined {
    const n = this.nodes.get(runId)?.get(key(siteId, ordinal));
    return n === undefined ? undefined : nodeCopy(n, opts?.withResult ?? true);
  }

  listNodes(runId: string, opts: ListNodesOptions): NodeRecord[] {
    const bucket = this.nodes.get(runId);
    if (bucket === undefined) return [];
    // Map iteration order is insertion order, matching SQLite's `order by id` (upsert changes neither
    // the ID nor its position in the Map).
    const kinds = opts.kinds;
    const matched = [...bucket.values()].filter(
      (node) => kinds === "all" || kinds.includes(node.kind),
    );
    const limited = opts.limit === undefined ? matched : matched.slice(0, Math.max(0, opts.limit));
    const budgeted =
      opts.maxResultBytes === undefined ? limited : withinBytes(limited, opts.maxResultBytes);
    return budgeted.map((node) => nodeCopy(node, opts.withResult));
  }

  countNodes(runId: string, kind: NodeKind): number {
    const bucket = this.nodes.get(runId);
    if (bucket === undefined) return 0;
    let count = 0;
    for (const node of bucket.values()) if (node.kind === kind) count += 1;
    return count;
  }

  sumResultBytes(runId: string, kind: NodeKind): number {
    const bucket = this.nodes.get(runId);
    if (bucket === undefined) return 0;
    let bytes = 0;
    for (const node of bucket.values()) if (node.kind === kind) bytes += resultBytes(node);
    return bytes;
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    // An orphan event (before createRun) violates the contract, just like putActor/putNode. Silently
    // creating a bucket would write events that can never belong to any run; SQLite has a foreign
    // key safeguard, while the in-memory version relies on this check.
    const list = this.events.get(runId);
    if (list === undefined) throw new Error(`journal: unknown run ${runId}`);
    // The append timestamp has the same meaning as SQLite's `dwf_event.time_created` (both
    // implementations share one contract test). All “how long ago” values in the event log must be
    // calculated from it; using Date.now() at read time would label the entire cold-replayed history
    // as “just now.”
    const stored: StoredEvent = {
      sequence: list.length,
      event: clone(event),
      timeCreated: Date.now(),
    };
    list.push(stored);
    return clone(stored);
  }

  listEvents(runId: string, opts: ListEventsOptions): StoredEvent[] {
    const list = this.events.get(runId);
    if (list === undefined) return [];
    // Report rank is counted across the **entire run**, independent of types / cursor / limit. Assign
    // each report event a rank in the unfiltered sequence before filtering, matching SQLite's
    // row_number() being computed before the filter.
    const reportLimit = opts.reportItems === "all" ? undefined : opts.reportItems.limit;
    const stripped = new Set<number>();
    if (reportLimit !== undefined) {
      let rank = 0;
      for (const stored of list) {
        if (stored.event.type !== "report") continue;
        rank += 1;
        if (rank > reportLimit) stripped.add(stored.sequence);
      }
    }
    // sequence and array index are identical in the in-memory implementation (appendEvent assigns
    // list.length), but compare by sequence rather than index offset: the cursor means “strictly
    // greater than this sequence,” matching SQLite's `where sequence > ?`. Both implementations
    // share the same contract test, so the semantics must be identical.
    const types = opts.types;
    const after = opts.afterSequence;
    const filtered = list.filter(
      (e) =>
        (types === "all" || types.includes(e.event.type)) &&
        (after === undefined || e.sequence > after),
    );
    const limited =
      opts.limit === undefined ? filtered : filtered.slice(0, Math.max(0, opts.limit));
    return limited.map((stored) => {
      const copy = clone(stored);
      if (stripped.has(stored.sequence)) delete (copy.event as { item?: unknown }).item;
      return copy;
    });
  }

  private requireActorBucket(runId: string): Map<string, ActorRecord> {
    const bucket = this.actors.get(runId);
    if (bucket === undefined) throw new Error(`journal: unknown run ${runId}`);
    return bucket;
  }

  private requireNodeBucket(runId: string): Map<string, NodeRecord> {
    const bucket = this.nodes.get(runId);
    if (bucket === undefined) throw new Error(`journal: unknown run ${runId}`);
    return bucket;
  }
}

/**
 * UTF-8 serialized byte length of a row's `result`, measured the same way as SQLite's
 * `octet_length(result_json)` (`result_json` is `JSON.stringify(result)`). Rows without a result count as 0.
 */
function resultBytes(node: NodeRecord): number {
  if (node.result === undefined) return 0;
  const text = JSON.stringify(node.result);
  return text === undefined ? 0 : new TextEncoder().encode(text).length;
}

/** Prefix rule for `maxResultBytes`: stop before adding a row that would exceed the cap; always include the first row, matching SQLite. */
function withinBytes(nodes: readonly NodeRecord[], maxResultBytes: number): NodeRecord[] {
  const kept: NodeRecord[] = [];
  let total = 0;
  for (const node of nodes) {
    const bytes = resultBytes(node);
    if (kept.length > 0 && total + bytes > maxResultBytes) break;
    kept.push(node);
    total += bytes;
  }
  return kept;
}
