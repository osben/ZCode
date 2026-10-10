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
  JournalStorePort,
  ListEventsOptions,
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

  putActor(record: ActorRecord): void {
    const bucket = this.requireActorBucket(record.runId);
    bucket.set(key(record.siteId, record.ordinal), clone(record));
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const a = this.actors.get(runId)?.get(key(siteId, ordinal));
    return a === undefined ? undefined : clone(a);
  }

  listActors(runId: string): ActorRecord[] {
    const bucket = this.actors.get(runId);
    return bucket === undefined ? [] : [...bucket.values()].map(clone);
  }

  putNode(record: NodeRecord): void {
    const bucket = this.requireNodeBucket(record.runId);
    bucket.set(key(record.siteId, record.ordinal), clone(record));
  }

  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined {
    const n = this.nodes.get(runId)?.get(key(siteId, ordinal));
    return n === undefined ? undefined : clone(n);
  }

  listNodes(runId: string): NodeRecord[] {
    const bucket = this.nodes.get(runId);
    return bucket === undefined ? [] : [...bucket.values()].map(clone);
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

  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[] {
    const list = this.events.get(runId);
    if (list === undefined) return [];
    // sequence and array index are identical in the in-memory implementation (appendEvent assigns
    // list.length), but compare by sequence rather than index offset: the cursor means “strictly
    // greater than this sequence,” matching SQLite's `where sequence > ?`. Both implementations
    // share the same contract test, so the semantics must be identical.
    const after = opts?.afterSequence;
    const filtered = after === undefined ? list : list.filter((e) => e.sequence > after);
    const limited =
      opts?.limit === undefined ? filtered : filtered.slice(0, Math.max(0, opts.limit));
    return limited.map(clone);
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
