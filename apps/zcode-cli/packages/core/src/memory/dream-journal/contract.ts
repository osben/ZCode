import type { FileSystemPort, Logger, TraceContext } from "@zcode/contracts";

/** Public types of the Dream run journal. The journal store and runtime adapter depend on this file only. */

export type DreamJournalTrigger = "scheduled" | "manual";
export type DreamJournalOutcome = "running" | "learned" | "nothing" | "skipped" | "failed";
export type DreamJournalAction = "created" | "updated" | "deleted";

export interface DreamJournalSnapshot {
  content: string;
}

export interface DreamJournalItem {
  id: string;
  /** Derived at finalize time from before/after; absent while the run is still running. */
  action?: DreamJournalAction;
  /** Path relative to the memory root. */
  file: string;
  before: DreamJournalSnapshot | null;
  after: DreamJournalSnapshot | null;
}

export interface DreamJournalRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  trigger: DreamJournalTrigger;
  outcome: DreamJournalOutcome;
  reasonCode?: string;
  items: DreamJournalItem[];
}

/** Returns the file body, or null when the file does not exist. */
export type DreamJournalMemoryFileReader = (path: string) => Promise<string | null>;

export interface BeginDreamJournalRunInput {
  memoryRoot: string;
  trigger: DreamJournalTrigger;
  now: Date;
  /**
   * Reads the snapshot bodies. The runtime passes the same file port the Dream tools write
   * through, so the journal records what the tools actually changed; defaults to node:fs.
   */
  readMemoryFile?: DreamJournalMemoryFileReader;
}

export interface FinalizeDreamJournalRunInput {
  status: "succeeded" | "failed";
  reasonCode?: string;
  now: Date;
}

export interface DreamJournalRunHandle {
  readonly id: string;
  /**
   * Records the pre-tool state of one memory file. Idempotent per run and path; the first call
   * is what counts, because it captures the state before any change of this run.
   */
  snapshotBeforeFirstTouch(filePath: string): Promise<void>;
  finalize(input: FinalizeDreamJournalRunInput): Promise<DreamJournalRun>;
}

/** Runtime capabilities the journal adapter needs. A runtime satisfies this structurally. */
export interface DreamJournalHost {
  readonly logger?: Logger;
  readonly fileSystemPort?: Pick<FileSystemPort, "readTextFile">;
  now(): Date;
}

/** Where a journal row belongs: the memory root owning it and the trace that caused it. */
export interface DreamJournalScope {
  memoryRoot: string;
  traceContext: TraceContext;
}

/**
 * Public surface of the journal store. One intent per method; the store and its tests bind to this
 * shape, and the runtime adapter is the only caller that adds best-effort behavior on top.
 */
export interface DreamJournalContract {
  /** Opens a running run and settles any interrupted one first. Snapshots go through the handle. */
  beginRun(input: BeginDreamJournalRunInput): Promise<DreamJournalRunHandle>;
  /** Writes a skipped run row with a reason code; no snapshots, no model work implied. */
  recordSkip(input: {
    memoryRoot: string;
    trigger: DreamJournalTrigger;
    reasonCode: string;
    now: Date;
  }): Promise<DreamJournalRun>;
  /** Newest first; corrupt run files are set aside and never returned. */
  listRuns(input: { memoryRoot: string; limit?: number }): Promise<DreamJournalRun[]>;
  /** Returns one run by id, or undefined for an invalid id, a missing run, or a set-aside file. */
  readRun(input: { memoryRoot: string; runId: string }): Promise<DreamJournalRun | undefined>;
}
