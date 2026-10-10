/**
 * scheduler.ts reached oxlint's max-lines limit (400), so the scheduler's internal types (Deferred /
 * AskNode / Actor) and the dependency surface injected by the engine, SchedulerHost, were moved to
 * this file. The public surface is still exported from scheduler.ts (which re-exports SchedulerHost
 * in place, keeping engine.ts import paths unchanged).
 *
 * The reason for a separate file is not only line count: free functions in scheduler-submit.ts also
 * need AskNode / SchedulerHost. Importing them from here means neither side must reverse-import the
 * scheduler itself.
 */

import { INSTRUCTIONS_HEAD_MAX_CHARS, refToString, WorkflowError } from "./types.js";
import type { ImportedActorState } from "./imported-cache.js";
import type {
  ActorId,
  ActorRef,
  AskSpec,
  AskStats,
  Caps,
  InstanceRef,
  PersonaSpec,
  RunEvent,
  SessionRef,
  ValidateFn,
  WorkflowDriver,
} from "./types.js";

/** A promise that can be settled externally. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Dependency surface injected by the engine into the scheduler. */
export interface SchedulerHost {
  readonly runId: string;
  /**
   * Concurrency ceiling for this run. **Read it before every dispatch**, rather than copying it at
   * construction: `setMaxConcurrency` replaces the caps held by the engine, and the scheduler's
   * dispatch decision must see the new value. The engine therefore implements this property as a
   * getter.
   */
  readonly caps: Caps;
  readonly driver: WorkflowDriver;
  readonly validate: ValidateFn;
  /** Allocate the next execution ordinal for a site (shared counter with world-read/actor). */
  nextOrdinal(siteId: string): number;
  /**
   * Release a hit subject to replay settlement order.
   * Immediately run `release` when this is not a resume or the order table has no entry for this instance.
   */
  holdForReplay(instance: InstanceRef, release: () => void): void;
  /** Persist and fan out the event (Boundary C). */
  record(event: RunEvent): void;
  isRunSettled(): boolean;
  /** Error used to reject after the run has settled. */
  runError(): WorkflowError;
  /** Fail the run. */
  failRun(error: WorkflowError): void;
  /**
   * Whether the imported cache is closed (amend-resume). The engine closes it itself (when the
   * driver reports askMutating or for a live world-run); the scheduler only reads this flag. An ask
   * becoming live does **not** close the cache by itself because it has not changed anything yet.
   */
  importCacheClosed(): boolean;
  /** Whether this record row ran live before the crash (the engine restores this from events on resume; always false otherwise). */
  wasLiveBeforeResume(instance: InstanceRef): boolean;
  /**
   * Whether admission of this record row happened **before** the imported cache closed (restored
   * by event order; see recoverImportClosure in engine-world.ts). This is needed to precisely
   * restore the decision for an in-flight ask from the preceding run; always false otherwise.
   */
  wasQueuedBeforeImportClose(instance: InstanceRef): boolean;
}

/** A live ask node that must actually be dispatched for execution. */
export interface AskNode {
  instance: InstanceRef;
  actor: Actor;
  actorSeq: number;
  instructions: string;
  hash: string;
  spec: AskSpec;
  deferred: Deferred<unknown>;
  repairsRemaining: number;
  nudgesRemaining: number;
  settled: boolean;
  dispatched: boolean;
  lastStats?: AskStats;
  /**
   * Instruction prefix computed at admission (the first N characters of {@link AskNode.instructions}).
   * Store it on the node rather than computing it separately in two places: `node-queued` and
   * `node-dispatched` must carry the **same** string (dispatch repeats the creation fact; see
   * `node-dispatched` in types.ts). Storing it guarantees this during construction instead of relying
   * on two call sites to stay synchronized.
   */
  instructionsHead?: string;
}

/** Actor runtime state maintained by the scheduler. */
export interface Actor {
  ref: ActorRef;
  id: ActorId;
  persona: PersonaSpec;
  name?: string;
  /** Number of ask nodes already recorded for this actor in the journal; during replay, live nodes wait until all have been admitted. */
  recordedCount: number;
  /** Next actorSeq awaiting admission. */
  nextAdmitSeq: number;
  /** Release actions for recorded nodes that arrived but are not yet admitted, held by actorSeq. */
  pendingRecorded: Map<number, () => void>;
  /** Release actions for live nodes that arrived but are waiting for recorded nodes to drain, in arrival order. */
  pendingLive: Array<() => void>;
  /** Admitted live nodes awaiting dispatch (FIFO = admission order). */
  liveQueue: AskNode[];
  /** Live node currently executing (serial per actor, at most one). */
  current?: AskNode;
  /** Lazily created session, caching its promise (once per actor). */
  sessionPromise?: Promise<SessionRef>;
  session?: SessionRef;
  /**
   * Imported-consumption state for amend-resume (attached by the engine in createActor after
   * matching by name + persona; see `matchImportedActor` in imported-cache.ts). If absent, this
   * actor runs again from scratch.
   */
  imported?: ImportedActorState;
}

// After merge, the current formatter would expand this past the scheduler's 400-line limit; keep
// these pure helpers here with the existing defer, without changing behavior.
/** Replay found a match but inputHash differs: the purity contract was violated, so fail the run loudly. */
export function hashMismatch(instance: InstanceRef, expected: string, got: string): WorkflowError {
  return new WorkflowError(
    "InputHashMismatch",
    `Replay hit at ${refToString(instance)} but inputHash differs (expected ${expected}, got ` +
      `${got}): the script is not deterministic, so the journal cannot be replayed.`,
    // Align the structured mismatch with ScriptHashMismatch: both hash-mismatch errors share this
    // field, so readers do not need to extract hashes from message text.
    { mismatch: { expected, got } },
  );
}

/** Convert a cause to one bounded line of text (Error uses message, others use String(); empty values get a placeholder). */
export function describeCause(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const trimmed = text.trim();
  if (trimmed.length === 0) return "unknown error";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/**
 * Prefix of the author's instructions (first {@link INSTRUCTIONS_HEAD_MAX_CHARS} characters,
 * trimmed, **without an ellipsis**).
 * Empty instructions return undefined: an absent key is more honest than an empty string, letting
 * readers fall back to “unknown instructions.”
 */
export function headOfInstructions(instructions: string): string | undefined {
  const trimmed = instructions.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= INSTRUCTIONS_HEAD_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, INSTRUCTIONS_HEAD_MAX_CHARS);
}

/** Drain the actor queue in its existing admission order; dispatch remains the scheduler's sole responsibility. */
export function drainActorAdmission(actor: Actor): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const release = actor.pendingRecorded.get(actor.nextAdmitSeq);
    if (release !== undefined) {
      actor.pendingRecorded.delete(actor.nextAdmitSeq);
      actor.nextAdmitSeq++;
      release();
      progressed = true;
      continue;
    }
    if (actor.nextAdmitSeq >= actor.recordedCount && actor.pendingLive.length > 0) {
      const admit = actor.pendingLive.shift()!;
      admit();
      progressed = true;
    }
  }
}
