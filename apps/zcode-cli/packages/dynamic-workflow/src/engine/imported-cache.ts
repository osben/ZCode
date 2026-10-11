/**
 * **Consumption state** for the amend-resume import cache.
 *
 * The injected {@link ImportedRunCache} is read-only data built by the caller—the run service reads
 * it from the predecessor journal, and resume after a crash rebuilds the same table with the same
 * pure function. Therefore, “how far consumption has progressed” cannot be written back into that
 * table; it must be engine-owned state. This module contains that state and all related decisions
 * (hit / divergence / seed).
 *
 * Split from scheduler.ts and engine.ts for the same reason scheduler was originally split from
 * engine: each file remains focused and readable while meeting the per-file line limit.
 */

import { canonicalJson } from "./hash.js";
import { personaIdentity } from "./persona.js";
import type {
  ActorRef,
  ActorSessionSeed,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedRunCache,
  ImportedWorldEntry,
  InstanceRef,
  NodeRecord,
  PersonaSpec,
} from "./types.js";

/**
 * Imported-consumption state for an actor attached to a candidate: consumption cursor + divergence flag.
 *
 * **Divergence is monotonic**: once `diverged` becomes true, never consult the cache again; the
 * discarded imported suffix cannot be revived.
 */
export class ImportedActorState {
  /** Number of consumed import entries = next actorSeq eligible for a hit (also transcript truncation boundary index + 1). */
  private consumed = 0;
  private diverged = false;
  /**
   * seq of the predecessor's in-flight ask being continued (absent when there is no continuation).
   * At most one: continuation itself causes divergence, and divergence is monotonic, so there can
   * be no second one.
   */
  private carriedSeq?: number;

  constructor(private readonly candidate: ImportedActorCandidate) {}

  /**
   * Look up a fresh ask at seq in the cache: on a hit, return the entry and advance the cursor;
   * otherwise mark divergence and return undefined.
   *
   * Both miss types are handled the same: hash mismatch (instructions changed) and
   * `seq >= entries.length` (the new script added an ask for this actor). Divergence **cascades**
   * dynamically at no extra cost: an upstream ask runs live and gets a new result, which changes
   * the interpolated instruction hash downstream, causing downstream divergence automatically
   * without explicit propagation.
   *
   * This method is called only while the import cache is **open** (after closure use
   * {@link takeIfPure}), so a miss may be eligible for continuation.
   */
  take(seq: number, hash: string): ImportedAskEntry | undefined {
    if (this.diverged) return undefined;
    const entry = this.candidate.entries[seq];
    if (entry === undefined || entry.inputHash !== hash) {
      this.diverge(seq, hash, true);
      return undefined;
    }
    this.consumed = seq + 1;
    return entry;
  }

  /**
   * Lookup after cache closure: only **pure** entries (predecessor recorded `worldToolCalls === 0`)
   * can still hit. Pure asks depend only on instructions and transcript prefix—both are in the hash
   * chain—and not on the workspace, so closure does not affect their answer. Do not reuse entries
   * that touched the external world even when hashes match: the workspace they read may have been
   * modified. This ask runs live and the actor diverges from here (transcript no longer matches the
   * predecessor, so later entries cannot be revived). Conservatively treat old entries with no
   * stats or without this key in stats as having touched the world.
   *
   * After closure, also do not continue an in-flight ask: that partial transcript contains
   * predecessor observations of the **old workspace**, like an entry that used a tool.
   */
  takeIfPure(seq: number, hash: string): ImportedAskEntry | undefined {
    if (this.diverged) return undefined;
    const entry = this.candidate.entries[seq];
    if (entry === undefined || entry.inputHash !== hash || entry.stats?.worldToolCalls !== 0) {
      this.diverge(seq, hash, false);
      return undefined;
    }
    this.consumed = seq + 1;
    return entry;
  }

  /**
   * Whether the answer to the ask at this seq was **read from a predecessor transcript**: returns the
   * session that owns it, or `undefined` otherwise.
   *
   * This is true exactly when there is no divergence yet and the cursor has passed this seq. Divergence
   * is monotonic and admission is in ascending seq order, so this means “this row was consumed from
   * the import.” Both paths check immediately after deciding: a fresh ask after a hit in {@link take},
   * and a resumed revised run after {@link reconcileRecorded}. The settle-order gate may defer an event
   * until a later row from the same actor has already marked divergence; checking then would wrongly
   * report an imported row as work performed by this run.
   */
  sourceSessionAt(seq: number): string | undefined {
    return !this.diverged && seq < this.consumed
      ? this.candidate.transcriptSourceSessionId
      : undefined;
  }

  /** Whether the ask at this seq continued the predecessor's in-flight ask (the scheduler uses this to decide whether stats include worldToolCalls). */
  carriedAt(seq: number): boolean {
    return this.carriedSeq === seq;
  }

  /**
   * Recompute divergence state from a **recorded** ask row (used when resuming an amended run after a crash).
   *
   * Divergence state is not persisted, and resume of an amended run rebuilds the entire import
   * cache. Without recomputing the divergence point from journal rows, a fresh ask at seq k+n for an
   * actor that diverged at seq k during the original execution might coincidentally match an
   * imported-entry hash and be **incorrectly imported**, reviving history unrelated to this run's
   * actual transcript. Comparing each recorded row's inputHash with the import entry exactly
   * reconstructs the original decision (admission is in ascending seq order, enforced by the hold
   * rule), so this is exact rather than a conservative approximation. `wasLive` covers the live
   * case hashes cannot reveal (an ask with tools after cache closure; see tryImportedSettle in the
   * scheduler).
   *
   * `queuedBeforeClose` is half of the continuation decision: continuation and this ask's
   * `node-queued` occur in the same synchronous admission slice, so “cache was open then” is
   * equivalent to “this node-queued precedes the first import-cache-closed” (see recoverImportClosure
   * in engine-world.ts). This must be exact—a false continuation would make seedActorTranscript
   * copy extra predecessor messages into an **already-diverged** session (the driver's idempotency
   * check only tests whether the target is long enough).
   */
  reconcileRecorded(
    seq: number,
    recordedHash: string,
    wasLive: boolean,
    queuedBeforeClose: boolean,
  ): void {
    if (this.diverged) return;
    // After cache closure, an ask for an actor with tools runs live even if its hash matches an
    // import entry. Counting it as consumed by hash would take the seed boundary from the
    // predecessor entry, even though the current session's transcript does not contain those
    // messages at that point. Whether it ran live is an event fact (node-queued), not something
    // inferred from a hash.
    if (wasLive) {
      this.diverge(seq, recordedHash, queuedBeforeClose);
      return;
    }
    const entry = this.candidate.entries[seq];
    if (entry === undefined || entry.inputHash !== recordedHash) {
      // A row that never ran live cannot be a continuation (a continued ask must have been dispatched and have node-queued).
      this.diverged = true;
      return;
    }
    this.consumed = Math.max(this.consumed, seq + 1);
  }

  /**
   * Session seed for a diverged actor: source session + number of messages to copy + inherited model pin.
   *
   * Take the boundary from the recorded value of the **last consumed** import entry: divergence at
   * seq k means exchanges 0..k-1 settled from cache, so the new session continues after those k
   * complete exchanges (including their repair / nudge rounds).
   * If nothing was consumed, there is no seed—a new session and fresh model resolution, without a
   * pin. The pin exists to prevent silently changing models while continuing a transcript; without
   * continuation, it has no use.
   *
   * **Continuation is the exception**: use `inFlight.messageBoundary` (the entire predecessor
   * session) as the boundary, so there is a seed even when nothing was consumed—the case where an
   * amended run begins while the first fan-out round is in flight.
   */
  seed(): ActorSessionSeed | undefined {
    const inFlight = this.candidate.inFlight;
    if (this.carriedSeq !== undefined && inFlight !== undefined) {
      return this.seedAt(inFlight.messageBoundary);
    }
    if (this.consumed === 0) return undefined;
    const last = this.candidate.entries[this.consumed - 1];
    if (last === undefined) return undefined;
    return this.seedAt(last.messageBoundary);
  }

  /**
   * Mark divergence and also determine whether this miss is a **continuation of the predecessor's in-flight ask**.
   *
   * All four continuation conditions are required: no prior divergence (otherwise this actor's
   * transcript already differs from the predecessor), `seq` is exactly after the prefix (the
   * in-flight ask position), the entire prefix was consumed, and the instruction hash matches the
   * in-flight ask. `cacheOpen` is a fifth condition: after closure, that partial transcript only
   * contains observations of the old workspace and is no more trustworthy than a cached world read.
   */
  private diverge(seq: number, hash: string, cacheOpen: boolean): void {
    const inFlight = this.candidate.inFlight;
    if (
      cacheOpen &&
      inFlight !== undefined &&
      seq === this.candidate.entries.length &&
      this.consumed === seq &&
      inFlight.inputHash === hash
    ) {
      this.carriedSeq = seq;
    }
    this.diverged = true;
  }

  private seedAt(messageCount: number): ActorSessionSeed {
    const seed: ActorSessionSeed = {
      sourceSessionId: this.candidate.transcriptSourceSessionId,
      messageCount,
    };
    if (this.candidate.resolvedModel !== undefined) seed.resolvedModel = this.candidate.resolvedModel;
    return seed;
  }
}

/**
 * Import-queue consumption state for world nodes: one cursor per content hash (the nth occurrence
 * maps to the nth record). As with {@link ImportedActorState}, cursors belong to the engine and the
 * injected queues remain read-only.
 */
export class ImportedWorldQueue {
  private readonly cursors = new Map<string, number>();

  constructor(private readonly world: ReadonlyMap<string, ImportedWorldEntry[]>) {}

  /** Take the next record for this content hash; undefined if exhausted or never recorded (caller runs live). */
  take(hash: string): ImportedWorldEntry | undefined {
    const queue = this.world.get(hash);
    if (queue === undefined) return undefined;
    const cursor = this.cursors.get(hash) ?? 0;
    const entry = queue[cursor];
    if (entry === undefined) return undefined;
    this.cursors.set(hash, cursor + 1);
    return entry;
  }
}

/**
 * Find an import candidate for a newly created actor: look up by **effective name** and accept it
 * only if the normalized persona matches.
 *
 * Compare personas with `canonicalJson`: it omits undefined members and sorts object keys, which is
 * exactly the needed normalization (`{name:"a"}` equals `{name:"a", system: undefined}`). A
 * mismatch **rejects the entire candidate**, so the actor runs from scratch. This is doubly correct
 * with full-fidelity transcripts: using a transcript produced by an old system prompt with a new
 * persona is an identity mismatch, and “I fixed the persona” implies the intent to rerun.
 *
 * Anonymous actors are never attached: name is the cache identity key, and without one there is no
 * coordinate to compare (this tradeoff has been decided). Compare at **runtime** instead of
 * statically comparing the two scripts at submission because names and personas are runtime values
 * (`agent()` arguments can be dynamic expressions); static comparison would create a second source
 * of truth, which this package consistently avoids.
 */
export function matchImportedActor(
  cache: ImportedRunCache | undefined,
  spec: PersonaSpec,
): ImportedActorState | undefined {
  if (cache === undefined) return undefined;
  const name = spec.name;
  if (name === undefined || name === "") return undefined;
  const candidate = cache.actors.get(name);
  if (candidate === undefined) return undefined;
  if (canonicalJson(personaIdentity(spec)) !== canonicalJson(personaIdentity(candidate.persona))) {
    return undefined;
  }
  return new ImportedActorState(candidate);
}

/**
 * The **real** dwf_node row written for one ask cache hit (new siteId, copied result / stats / boundary).
 *
 * Copy the boundary value too, or **this** run cannot itself be amended—the chained-amendment
 * behavior depends on preserving the count offset across prefix copies.
 */
export function importedAskRecord(
  runId: string,
  instance: InstanceRef,
  actor: ActorRef,
  seq: number,
  hash: string,
  entry: ImportedAskEntry,
): NodeRecord {
  const record: NodeRecord = {
    runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind: "ask",
    actorSiteId: actor.siteId,
    actorOrdinal: actor.ordinal,
    actorSeq: seq,
    inputHash: hash,
    status: "completed",
    result: entry.result,
    messageBoundary: entry.messageBoundary,
  };
  if (entry.stats !== undefined) record.stats = entry.stats;
  return record;
}
