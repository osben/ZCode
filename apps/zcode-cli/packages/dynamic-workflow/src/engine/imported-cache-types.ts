// ============================================================
// Import cache for amend-resume
// ============================================================
// Split from engine/types.ts (which reached oxlint's max-lines limit): plain data structures built
// by the run service from the predecessor journal; the engine only looks them up.

import type { AskStats, NodeKind, PersonaSpec } from "./types.js";

/**
 * An importable completed ask: result of the `actorSeq`th exchange by a named actor in the
 * predecessor run. The array index is actorSeq (see {@link ImportedActorCandidate.entries}), so seq
 * is not stored here.
 */
export interface ImportedAskEntry {
  /** inputHash from the predecessor record (for the instruction body). Compared with each current ask at runtime; only a match is a hit. */
  inputHash: string;
  result: unknown;
  stats?: AskStats;
  /**
   * Number of messages in the source session after this ask settled ({@link NodeRecord.messageBoundary}).
   * **Required**: the run service's “reject predecessor without a marker” gate guarantees that
   * every importable entry has a boundary, so the engine needs no absent-value branch; transcript
   * truncation cannot be defined without a boundary.
   */
  messageBoundary: number;
}

/**
 * The ask that was **still in flight** when the predecessor stopped (`actorSeq === entries.length`,
 * the running row immediately after the prefix).
 *
 * It has no result to import; what is imported is **the transcript it already produced**. If the
 * amended run sends the same instruction at the same position (`inputHash` matches), the new
 * session continues from here rather than discarding the partial exchange and starting over.
 */
export interface ImportedInFlightAsk {
  /** inputHash from the predecessor record (for the instruction body); continuation requires a match with the current ask. */
  inputHash: string;
  /**
   * Number of messages in the predecessor's **entire settled session** (not an ask's recorded
   * boundary—an unfinished ask has no boundary). Includes both complete exchanges in the prefix
   * and this partial exchange, which is exactly where continuation should resume.
   */
  messageBoundary: number;
}

/**
 * Importable prefix for a named actor in the predecessor run. Built by the run service from the
 * predecessor journal (deterministic and reconstructible).
 */
export interface ImportedActorCandidate {
  /** Normalized persona from the predecessor record, compared at runtime in createActor (mismatch rejects this candidate). */
  persona: PersonaSpec;
  /**
   * Longest prefix of fully completed asks, indexed by actorSeq 0..n-1. **May be empty**: a
   * candidate with {@link inFlight} often has no completed asks yet (the run was amended while the
   * first fan-out round was in flight).
   */
  entries: ImportedAskEntry[];
  /**
   * Ask that was in flight when the predecessor stopped, if any. Import only when the transcript
   * source is the predecessor itself; the partial exchange exists only in that session, while a
   * source resolved from an earlier ancestor has only the complete prefix.
   */
  inFlight?: ImportedInFlightAsk;
  /**
   * Transcript-source session ID resolved through the `resumed_from` chain. The service guarantees
   * it is present—if no ancestor in the chain has a candidate with that actor session, the service
   * has already discarded the candidate (downgrading to a new actor), so this is not optional.
   */
  transcriptSourceSessionId: string;
  /**
   * Model pin resolved by the predecessor, passed to the driver with the seed. **Applies only when
   * transcript was actually imported**: an actor with no hits gets a fresh resolution without the
   * pin (see ensureSession in the scheduler).
   */
  resolvedModel?: string;
}

/** An importable world node (world-read / world-run), matched by content + occurrence order. */
export interface ImportedWorldEntry {
  inputHash: string;
  kind: NodeKind;
  result: unknown;
}

/**
 * Import cache injected into the engine (an acceleration structure for amend-resume). **Plain
 * data**: the engine performs no I/O; the run service builds this table from the predecessor journal.
 * It is not a source of truth—each hit writes a real dwf_node row, and the cache can be rebuilt from
 * `resumed_from` if lost.
 */
export interface ImportedRunCache {
  /** Key = effective actor name (unique and non-empty in the predecessor). */
  actors: ReadonlyMap<string, ImportedActorCandidate>;
  /**
   * Key = `inputHash({op, args})`; value = queue ordered by insertion order from predecessor
   * listNodes—the nth occurrence of the same `{op,args}` maps to the nth record, and the queue head
   * is the next possible hit.
   */
  world: ReadonlyMap<string, ImportedWorldEntry[]>;
}

/**
 * Session seed passed to {@link WorkflowDriver.createActorSession} at the first live dispatch of a
 * diverged actor, so the new session begins with the source session's **full-fidelity transcript prefix**.
 */
export interface ActorSessionSeed {
  /** Source session for the transcript (the actor's session in the predecessor or an earlier ancestor). */
  sourceSessionId: string;
  /**
   * Number of messages to copy from the source session = {@link NodeRecord.messageBoundary} of the
   * last consumed import ask. Count offset remains stable across prefix copies, so this value can
   * be used directly for any session-holding ancestor in the chain.
   */
  messageCount: number;
  /** Inherited model pin (prevents the identity change of silently switching models while continuing a transcript). */
  resolvedModel?: string;
}
