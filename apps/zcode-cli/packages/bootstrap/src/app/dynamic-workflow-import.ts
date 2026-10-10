// ============================================================
// Import construction for amend-resume: read predecessor journal → ImportedRunCache
// ============================================================
//
// This is the only place amend-resume **reads predecessors**; three call sites share it:
//   1. **Preflight** for `port.amend` ({@link preflightAmendImport}): check `run_not_found` /
//      `missing_boundaries` before stopping an active predecessor. A refusal leaves it running and
//      creates no rows.
//   2. `port.amend` builds the cache after the predecessor settles ({@link buildImportedCache}).
//   3. `port.resume` sees `record.resumedFrom` and rebuilds the same table after a crash.
//
// Both paths share one construction rule: an amended run's journal contains only the consumed
// execution prefix, so unconsumed imports must be rebuilt. Completed entries come only from the
// journal, in insertion order; unfinished ask boundaries also depend on the source transcript.
//
// One exception needs to be explicit: it is the table's **first value that is not a pure function
// of the journal**. The continuation boundary for an in-flight ask (`inFlight`) comes from the
// predecessor session's current message count, not a journal column.
//
// It stays mostly stable between the two builds because the predecessor is settled and nobody is
// writing its sessions:
//   - At submission, {@link AmendImportOptions.quietSessions} guarantees this (the predecessor was
//     just aborted, and the driver waits for its turn to persist; sessions not yet settled are not continued).
//   - During reconstruction, the predecessor is already terminal and has no driver in this process,
//     so nothing is writing its sessions. The set is omitted (omission = all quiet).
//
// "Mostly" is not "always," and stability is unnecessary. Either path can reconstruct a larger M:
// the predecessor may be resumed and write more turns (a superseded predecessor cannot resume, so
// this requires amending an already stopped run and then resuming it), or a late background
// notification may be added to its session. Both only increase M, and correctness does not depend
// on its stability:
//   - The receiving side has a closed gate: `seedActorTranscript` writes only to an empty target or
//     one containing only this session's seed messages (property 2 in workflow-actor-transcript.ts).
//     Once the successor has its own messages, a larger M cannot write a single byte, so predecessor
//     messages are never silently appended after this session's history.
//   - Before the successor has its own messages, a larger M copies a **later snapshot of the same
//     ask**. Ordering still follows indices (seed IDs are deterministic by (session, index), and a
//     repeated copy is an upsert), so it adds context without changing correctness.
// This also protects every **future** non-journal fact: no need to prove each one cannot grow; the
// copy boundary closes the risk once.
//
// The only I/O is reading the journal and transcript message counts (both injected through narrow
// ports); this module does not access the session-store implementation.

import type { Logger, SessionId } from "@zcode/contracts";
import type {
  ActorRecord,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedInFlightAsk,
  ImportedRunCache,
  ImportedWorldEntry,
  NodeRecord,
  RunRecord,
} from "@zcode/dynamic-workflow";
import { TERMINAL_RUN_STATUSES } from "./dynamic-workflow-run-observation.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";

/**
 * Journal read surface needed to build an import cache: three read methods, all keyed by runId.
 *
 * Structurally a true subset of the engine's `JournalStorePort` (production passes the journal
 * directly). Narrow it for the same reason as {@link ActorTranscriptStore}: the builder reads only
 * these three methods. Declaring the full port would claim "import construction depends on every
 * journal capability, including writes," though it writes no bytes. **Predecessors are read-only**
 * is an invariant; express it in the type.
 */
interface ImportedCacheJournalReader {
  getRun(runId: string): RunRecord | undefined;
  listActors(runId: string): ActorRecord[];
  listNodes(runId: string): NodeRecord[];
}

/**
 * Three reasons import construction can be refused. **Discriminants, not messages**: the model
 * chooses its next action from them (choose another run / wait for settlement / abandon amendment
 * and start a fresh run), so the reasons must be distinguishable. Actionable wording belongs to the tool layer.
 *
 * Must have the **same literal union** as the port's `DynamicWorkflowRunSubmitRefusalReason`
 * (contracts): the service passes this reason through unchanged, so drift between the two becomes a
 * compile error instead of a discriminant silently turning into `undefined`. Intentionally do not
 * import contracts: the port vocabulary should depend on this domain builder, not the reverse.
 */
type ImportedCacheRefusalReason =
  /** The predecessor run is absent from the journal. */
  | "run_not_found"
  /** The predecessor is still active (nonterminal). Amending **any terminal** run is valid, including completed. */
  | "not_amendable"
  /** The predecessor has completed asks without message boundaries: reject the whole predecessor without fallback. */
  | "missing_boundaries";

/** Build result: success carries the table and lineage pointer; failure carries only a discriminant. */
type BuildImportedCacheResult =
  | { ok: true; cache: ImportedRunCache; resumedFrom: string }
  | { ok: false; reason: ImportedCacheRefusalReason };

/**
 * Two refusal reasons for amend preflight, with the same literal union as the port's
 * `DynamicWorkflowRunAmendRefusalReason`. There is no `not_amendable`: amend stops an active predecessor rather than refusing it.
 */
type AmendPreflightRefusalReason = Exclude<ImportedCacheRefusalReason, "not_amendable">;

type AmendPreflightResult =
  | { ok: true; run: RunRecord }
  | { ok: false; reason: AmendPreflightRefusalReason };

/**
 * **Preflight** for amend: the predecessor exists and every completed ask has a message boundary.
 * **Does not check status**: both conditions are properties of the predecessor journal and cannot
 * change when it is stopped, so they can be decided before stopping it. Stopping only after
 * preflight passes ensures a refused amend never leaves a run stopped for nothing. Completed asks
 * of an active run already have their boundaries in the journal, so preflight is equally decisive
 * for active and settled predecessors.
 */
export function preflightAmendImport(
  journal: Pick<ImportedCacheJournalReader, "getRun" | "listNodes">,
  predecessorRunId: string,
): AmendPreflightResult {
  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  if (!completedAsksHaveBoundaries(journal.listNodes(predecessorRunId))) {
    return { ok: false, reason: "missing_boundaries" };
  }
  return { ok: true, run };
}

/**
 * Predicate for gate 3, shared by preflight and build. A missing marker has only two causes: a
 * journal written before the marker column was introduced, or driver-side accounting failure.
 * Both mean this run's boundary accounting is untrustworthy, so check the entire table rather than
 * only imported rows. Incomplete asks normally have no boundary (they never enter the import
 * prefix), so inspect only completed rows.
 */
function completedAsksHaveBoundaries(nodes: readonly NodeRecord[]): boolean {
  for (const node of nodes) {
    if (node.kind !== "ask" || node.status !== "completed") continue;
    if (node.messageBoundary === undefined) return false;
  }
  return true;
}

/**
 * Three dependencies needed to build the import cache. Field names exactly match the structural
 * subset of `DynamicWorkflowRunServiceDeps`, so both run-service call sites pass `deps` through
 * unchanged. Another layer of name mapping would add another place for wiring drift, whose symptom
 * could be a silent fallback where the transcript surface is present but honesty checks are skipped.
 */
interface AmendImportDeps {
  journal: ImportedCacheJournalReader;
  /**
   * Session-transcript read surface. When present, perform an additional **source-integrity check**
   * (see {@link honorsBoundary}); when absent, keep candidates. The driver's seed operation still
   * fails clearly as a corruption-level safeguard.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  logger?: Logger;
}

/**
 * **Runtime evidence** available during construction, separate from journal facts. Currently only
 * one value: which predecessor sessions have finished writing.
 *
 * Intentionally excluded from {@link AmendImportDeps}: deps are assembly (journal, transcript
 * surface, logger) and stay the same throughout a process; this object is an observation for **one
 * build** and can differ between builds. Putting it in deps would change the meaning of "the same
 * deps always produce the same table."
 */
export interface AmendImportOptions {
  /**
   * Predecessor session IDs that are **quiet** (no longer have a turn writing). Affects only
   * continuation of in-flight asks; completed-prefix boundaries are journal facts and do not
   * depend on current session length.
   *
   * **Omission = all quiet**, not "none quiet." The two call sites handle opposite cases: amend has
   * just aborted an active predecessor, whose turn may still be writing its final messages, so it
   * supplies the set computed by the driver. Resume reconstruction ({@link rebuildImportedCacheForResume})
   * sees a settled predecessor with no driver in this process and nothing writing its sessions, so
   * omission is correct. Reversing this rule would make the rebuilt table lose an `inFlight` entry
   * compared with the submitted table, though both sides must match (see file header).
   */
  quietSessions?: ReadonlySet<string>;
}

/**
 * Read predecessor journal and transcript state to build {@link ImportedRunCache}.
 * The journal determines the completed prefix; continuing an unfinished ask also depends on source-session message count and quiescence.
 *
 * Three gates, in order (gates before construction: if a gate fails, no rows need to be read):
 *   1. Predecessor missing → `run_not_found`.
 *   2. Predecessor nonterminal → `not_amendable`.
 *   3. Predecessor has a completed ask without `messageBoundary` → `missing_boundaries`.
 *
 * Gate 3 is **strict across the whole table**, not just rows that would be imported: a missing
 * marker can only come from a journal written before the marker column or driver-side accounting
 * failure. Both mean the run's boundary accounting cannot be trusted, not that one row happened to
 * miss it. Allowing rows individually would let a partially corrupted predecessor produce a
 * seemingly complete table and truncate a divergent transcript at the wrong point (silently
 * misaligning context seen by the model and boundaries recorded in the journal).
 * Reject a journal with any completed ask missing its boundary; do not synthesize a potentially
 * incorrect transcript boundary. Incomplete asks normally have no boundary (they never enter the
 * import prefix), so the gate checks only completed rows.
 */
export async function buildImportedCache(
  deps: AmendImportDeps,
  predecessorRunId: string,
  options?: AmendImportOptions,
): Promise<BuildImportedCacheResult> {
  const { actorTranscriptStore: transcripts, journal, logger } = deps;

  const run = journal.getRun(predecessorRunId);
  if (run === undefined) return { ok: false, reason: "run_not_found" };
  // Amendable set = any terminal state. **Intentionally do not reuse** isResumableRecord for plain
  // resume: that predicate gates byte-identical resume (stopped), while amendments are most useful
  // for the two states it excludes—script failure (fix the bug, keep the cache) and completed
  // (warm-start an extended analysis). The two sets serve different purposes.
  if (!TERMINAL_RUN_STATUSES.has(run.status)) return { ok: false, reason: "not_amendable" };

  const nodes = journal.listNodes(predecessorRunId);
  if (!completedAsksHaveBoundaries(nodes)) return { ok: false, reason: "missing_boundaries" };

  const actors = new Map<string, ImportedActorCandidate>();
  for (const record of namedUniqueActors(journal.listActors(predecessorRunId), logger)) {
    const name = record.name!;
    const candidate = await buildActorCandidate({
      actor: record,
      journal,
      ...(logger === undefined ? {} : { logger }),
      nodes,
      predecessorRunId,
      ...(options?.quietSessions === undefined ? {} : { quietSessions: options.quietSessions }),
      ...(transcripts === undefined ? {} : { transcripts }),
    });
    if (candidate !== undefined) actors.set(name, candidate);
  }

  return {
    ok: true,
    cache: { actors, world: buildWorldQueues(nodes) },
    resumedFrom: predecessorRunId,
  };
}

/**
 * Actor rows in the predecessor that are **eligible candidates**: nonempty name and unique within the run.
 *
 * Do not accept anonymous actors (name is the cache identity key, and without it there is no
 * coordinate to compare). For duplicate names, **accept neither**: the engine's `DuplicateActorName`
 * runtime invariant was added later, so earlier journals may contain duplicates. Selecting by name
 * from such a predecessor would be a dice roll. Better to select neither: both actors rerun from
 * scratch, rather than attaching another actor's session prefix as this actor's context.
 */
function namedUniqueActors(records: ActorRecord[], logger?: Logger): ActorRecord[] {
  const byName = new Map<string, ActorRecord[]>();
  for (const record of records) {
    const name = record.name;
    if (name === undefined || name === "") continue;
    const bucket = byName.get(name);
    if (bucket === undefined) byName.set(name, [record]);
    else bucket.push(record);
  }
  const unique: ActorRecord[] = [];
  for (const [name, bucket] of byName) {
    if (bucket.length === 1) {
      unique.push(bucket[0]!);
      continue;
    }
    logger?.warn?.("Dynamic workflow amend: duplicate actor name in predecessor, skipped", {
      actorName: name,
      count: bucket.length,
      event: "dynamic_workflow.amend.duplicate_actor_name",
      module: "bootstrap.app",
    });
  }
  return unique;
}

/**
 * Importable prefix and transcript source for one actor candidate. If any part is missing, return
 * `undefined` and rerun that actor from scratch.
 *
 * The general rule here is **degrade rather than fail** (opposite the gates' whole-run rejection):
 * a missing prefix or persona, no session in the lineage, or a cleaned-up source session all mean
 * "this actor has no cache." No cache row in the journal means no cache; do not invent one. The only
 * whole-run refusal is untrustworthy boundary accounting, because it would truncate an
 * **otherwise accepted** candidate at the wrong position.
 */
async function buildActorCandidate(input: {
  actor: ActorRecord;
  journal: ImportedCacheJournalReader;
  logger?: Logger;
  nodes: NodeRecord[];
  predecessorRunId: string;
  quietSessions?: ReadonlySet<string>;
  transcripts?: ActorTranscriptStore;
}): Promise<ImportedActorCandidate | undefined> {
  const { actor, journal, logger, nodes, predecessorRunId, quietSessions, transcripts } = input;
  const name = actor.name!;

  // The engine synchronously persists persona as frozen identity during createActor, so it should
  // normally exist. If absent, the row was externally modified. Without it, runtime matching
  // cannot verify persona consistency; discard the candidate instead of substituting `{}`.
  if (actor.persona === undefined) return undefined;

  const { entries, next } = completedAskPrefix(nodes, actor);
  // There is neither a completed prefix nor an in-flight ask after it, so this actor has nothing to
  // import. Return early to avoid walking the lineage and reading the transcript.
  if (entries.length === 0 && next?.status !== "running") return undefined;

  const source = resolveTranscriptSource({
    actorName: name,
    journal,
    startRunId: predecessorRunId,
  });
  if (source === undefined) {
    // No ancestor in the lineage has this actor's session (it was never created or has been cleaned
    // up). This feature requires a full-fidelity transcript; without one there is no context to
    // continue, so start a fresh actor.
    logger?.info?.("Dynamic workflow amend: no transcript source for actor, import dropped", {
      actorName: name,
      event: "dynamic_workflow.amend.transcript_source_missing",
      module: "bootstrap.app",
      runId: predecessorRunId,
    });
    return undefined;
  }

  // Empty-prefix boundary is 0 (there are no completed exchanges, so continuation starts at 0).
  const boundary = entries.length === 0 ? 0 : entries[entries.length - 1]!.messageBoundary;
  // Read the transcript message count **once**: source-integrity check and in-flight ask continuation
  // must use the same value. Reading twice would create two observation windows for one fact, and
  // their values could differ.
  const messageCount =
    transcripts === undefined ? undefined : await countSource(transcripts, source.sessionId);
  if (transcripts !== undefined && (messageCount === undefined || messageCount < boundary)) {
    logger?.warn?.(
      "Dynamic workflow amend: transcript source shorter than boundary, import dropped",
      {
        actorName: name,
        event: "dynamic_workflow.amend.transcript_source_short",
        messageBoundary: boundary,
        module: "bootstrap.app",
        sessionId: source.sessionId,
      },
    );
    return undefined;
  }

  const inFlight = resolveInFlightAsk({
    actor,
    boundary,
    ...(logger === undefined ? {} : { logger }),
    ...(messageCount === undefined ? {} : { messageCount }),
    ...(next === undefined ? {} : { next }),
    predecessorRunId,
    ...(quietSessions === undefined ? {} : { quietSessions }),
    sourceSessionId: source.sessionId,
  });
  // The prefix is empty and continuation was not recovered; this candidate carries no bytes, so
  // accepting it would make the engine create a session for an empty table.
  if (entries.length === 0 && inFlight === undefined) return undefined;

  return {
    persona: actor.persona,
    entries,
    ...(inFlight === undefined ? {} : { inFlight }),
    transcriptSourceSessionId: source.sessionId,
    ...(source.resolvedModel === undefined ? {} : { resolvedModel: source.resolvedModel }),
  };
}

/**
 * Ask that was **still in flight** when the predecessor stopped. All five conditions are required:
 *
 *   1. A row exists immediately after the prefix, and it is `running`. A cancelled ask retains a
 *      running row, so a stopped run can qualify; `failed` and ordinal gaps are not in-flight, but
 *      other reasons the prefix ended.
 *   2. The transcript source is the predecessor's **own** session row: the unfinished half-turn
 *      exists only there. A source resolved from an earlier ancestor carries only the complete
 *      prefix (each chain hop guarantees prefix equivalence only).
 *   3. The session count can be read (transcript surface exists and is accessible); without a count
 *      there is no continuation position for the driver to truncate to.
 *   4. The session is **quiet**; see {@link AmendImportOptions.quietSessions}.
 *   5. Count is **strictly greater** than the prefix boundary. A queued but never dispatched ask has
 *      no additional transcript to carry. A messageCount equal to the boundary (or 0) would seed a
 *      prefix-only or empty transcript while marking the actor as continued, mismatching divergence
 *      detection and transcript content.
 *
 * If any condition fails, simply **do not continue** the ask (the completed prefix is still imported),
 * matching this module's general "degrade, do not fail" rule.
 */
function resolveInFlightAsk(input: {
  actor: ActorRecord;
  boundary: number;
  logger?: Logger;
  messageCount?: number;
  next?: NodeRecord;
  predecessorRunId: string;
  quietSessions?: ReadonlySet<string>;
  sourceSessionId: string;
}): ImportedInFlightAsk | undefined {
  const { actor, boundary, logger, messageCount, next, quietSessions, sourceSessionId } = input;
  if (next === undefined || next.status !== "running") return undefined;

  const drop = (reason: string): undefined => {
    logger?.info?.("Dynamic workflow amend: in-flight ask not carried", {
      actorName: actor.name,
      event: "dynamic_workflow.amend.in_flight_dropped",
      module: "bootstrap.app",
      reason,
      runId: input.predecessorRunId,
      sessionId: sourceSessionId,
    });
    return undefined;
  };

  if (actor.sessionId === undefined || actor.sessionId !== sourceSessionId) {
    return drop("transcript_source_is_ancestor");
  }
  if (messageCount === undefined) return drop("no_transcript_count");
  // Omission = all quiet (see {@link AmendImportOptions.quietSessions}).
  if (quietSessions !== undefined && !quietSessions.has(sourceSessionId)) {
    return drop("session_not_quiescent");
  }
  if (messageCount <= boundary) return drop("no_transcript_beyond_prefix");

  return { inputHash: next.inputHash, messageBoundary: messageCount };
}

/**
 * This actor's **longest all-completed ask prefix** (contiguous actorSeq 0..k), plus the **next row** after it.
 *
 * Stop the prefix at the first non-completed row, treating failure, crash-in-progress (`running`),
 * and ordinal gap alike. A failed ask is **not binding** for the new run (models are stochastic, and
 * amendments often aim to get past a failure), so do not import it. But skipping it and importing
 * later rows would smuggle context: the skipped turn remains in the source transcript while the
 * cache claims it never happened. Stopping at the first non-completed row is the only consistent reading.
 *
 * `next` is the row **that stopped the prefix** (omitted for an ordinal gap). It travels with the
 * prefix because by definition "the in-flight ask" is exactly this row. A separate traversal to
 * find `actorSeq === entries.length` would compute the "immediately after the prefix" coordinate twice.
 */
function completedAskPrefix(
  nodes: NodeRecord[],
  actor: ActorRecord,
): { entries: ImportedAskEntry[]; next?: NodeRecord } {
  const bySeq = new Map<number, NodeRecord>();
  for (const node of nodes) {
    if (node.kind !== "ask") continue;
    if (node.actorSiteId !== actor.siteId || node.actorOrdinal !== actor.ordinal) continue;
    if (node.actorSeq === undefined) continue;
    bySeq.set(node.actorSeq, node);
  }

  const entries: ImportedAskEntry[] = [];
  for (let seq = 0; ; seq++) {
    const node = bySeq.get(seq);
    if (node === undefined || node.status !== "completed") {
      return { entries, ...(node === undefined ? {} : { next: node }) };
    }
    // Boundary must be present: gate 3 checked the entire predecessor, so this fulfills an invariant rather than optimistically reading.
    const entry: ImportedAskEntry = {
      inputHash: node.inputHash,
      result: node.result,
      messageBoundary: node.messageBoundary!,
    };
    if (node.stats !== undefined) entry.stats = node.stats;
    entries.push(entry);
  }
}

/**
 * Walk the `resumed_from` chain to find the **nearest** ancestor run that has this named actor's session.
 *
 * Why walk the chain: if an actor in run B hits cache throughout, B never creates its session
 * (lazy creation). When amending B → C and continuing that actor, its transcript exists only in A.
 * The count boundary remains unchanged when copying a prefix, so B's copied boundary is valid at any
 * session-bearing ancestor in the chain; this is the basis for chained amendments.
 *
 * Read `resolvedModel` and session from the **same row**: the pin means "do not switch models while
 * continuing this transcript," and reading it from another row would bind a transcript that is not its own.
 *
 * Cycle protection (`seen`) is defensive: supersede can only point to an earlier terminal run, so
 * cycles cannot be constructed. But corrupt data would make this while loop infinite, and the
 * defense costs only a Set.
 */
function resolveTranscriptSource(input: {
  actorName: string;
  journal: ImportedCacheJournalReader;
  startRunId: string;
}): { sessionId: string; resolvedModel?: string } | undefined {
  const { actorName, journal, startRunId } = input;
  const seen = new Set<string>();
  let runId: string | undefined = startRunId;

  while (runId !== undefined && !seen.has(runId)) {
    seen.add(runId);
    const matches = journal.listActors(runId).filter((actor) => actor.name === actorName);
    // 0 = this generation has no such actor (the chain is broken for this name); >1 = duplicate
    // name, so selecting a session by name is arbitrary. Stop here in either case rather than
    // walking further back: an older generation's session is not the source of **this** transcript.
    if (matches.length !== 1) return undefined;
    const actor = matches[0]!;
    if (actor.sessionId !== undefined) {
      return {
        sessionId: actor.sessionId,
        ...(actor.resolvedModel === undefined ? {} : { resolvedModel: actor.resolvedModel }),
      };
    }
    runId = journal.getRun(runId)?.resumedFrom;
  }
  return undefined;
}

/**
 * Current message count for the source session; return `undefined` if reading fails.
 *
 * Both consumers share this read (see {@link buildActorCandidate}):
 * - Check whether the source session reaches the completed-prefix boundary. If the count is too
 *   small or unreadable, the builder discards the candidate so the successor reruns it; the driver
 *   also rejects a source shorter than the boundary when copying, preventing incomplete context.
 * - Compute the continuation position for an unfinished ask (see {@link resolveInFlightAsk}).
 *
 * Count semantics must match driver accounting and core history recovery; all use the same message-store interface.
 */
async function countSource(
  transcripts: ActorTranscriptStore,
  sessionId: string,
): Promise<number | undefined> {
  try {
    return (await transcripts.messages({ sessionID: sessionId as SessionId })).length;
  } catch {
    return undefined;
  }
}

/**
 * Content table for world nodes: `inputHash` → journal-insertion-ordered record queue (nth occurrence matches nth row).
 *
 * Use the predecessor row's **inputHash** directly; do not recompute it. The engine's hash semantics
 * for `{op,args}` (`worldRead` in engine.ts) are already represented in this column. Recomputing
 * would duplicate the hash contract here, and drift would look like a mysterious cache miss.
 *
 * Keep completed rows only: failed world reads are retried (failure is not binding on a new run),
 * and running rows even less so. world-run and world-read share this table. Importing world-run is a
 * **safety feature**, not an optimization: amended resume must never silently replay a journaled
 * effect (for example, running a deployment script twice).
 */
function buildWorldQueues(nodes: NodeRecord[]): ReadonlyMap<string, ImportedWorldEntry[]> {
  const world = new Map<string, ImportedWorldEntry[]>();
  for (const node of nodes) {
    if (node.kind !== "world-read" && node.kind !== "world-run") continue;
    if (node.status !== "completed") continue;
    const queue = world.get(node.inputHash);
    const entry: ImportedWorldEntry = {
      inputHash: node.inputHash,
      kind: node.kind,
      result: node.result,
    };
    if (queue === undefined) world.set(node.inputHash, [entry]);
    else queue.push(entry);
  }
  return world;
}

/**
 * Resume-side entry point: rebuild the amended run's import cache. **Any failure degrades gracefully; it never refuses resume.**
 *
 * Shares {@link buildImportedCache} with submission—not merely for convenience but as a correctness
 * requirement: an amended run's journal is self-contained only for the execution prefix already
 * reached. This rebuild restores unconsumed imports; if the two paths produce different tables,
 * this becomes a new table instead of a reconstruction.
 *
 * Three reasons distinguish "rebuild failed" from "build failed at submission":
 *   - The amended run already exists. Refusing resume would permanently strand a resumable run.
 *   - Consumed cache hits are **real rows** in this run's journal, so replay does not need this table;
 *     the run is self-contained without it.
 *   - Unconsumed imports fall back to live execution. Results remain correct, but use tokens that
 *     could have been saved.
 *
 * Therefore, do not distinguish the three gate reasons here. For resume, `run_not_found` (predecessor
 * was cleaned up) and `missing_boundaries` both mean "no cache is available this time." The
 * predecessor journal is a **continuity dependency for amended runs, but only an acceleration
 * structure**: losing it increases cost, not incorrectness. Log at info level to help explain usage later.
 *
 * **Do not supply {@link AmendImportOptions.quietSessions}**: a predecessor reaching this point is
 * already terminal, with no driver in this process and nothing writing its sessions. Passing an
 * empty set would remove an `inFlight` entry from the rebuilt table compared with the submitted
 * table, but the two must match (see file header).
 */
export async function rebuildImportedCacheForResume(
  deps: AmendImportDeps,
  /** Amended run being resumed and its `resumed_from` (the caller has confirmed the predecessor exists). */
  run: { runId: string; predecessorRunId: string },
): Promise<ImportedRunCache | undefined> {
  const { predecessorRunId, runId } = run;
  const built = await buildImportedCache(deps, predecessorRunId);
  if (built.ok) return built.cache;
  deps.logger?.info?.("Dynamic workflow amend cache rebuild skipped; resuming without it", {
    event: "dynamic_workflow.amend.rebuild_skipped",
    module: "bootstrap.app",
    reason: built.reason,
    resumedFrom: predecessorRunId,
    runId,
  });
  return undefined;
}
