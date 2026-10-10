/**
 * engine.ts reached oxlint's max-lines limit (400), so the explicit seam for private engine state
 * was moved to this file; the public surface is still exported from engine.ts.
 *
 * Several WorkflowEngine method groups (user-facing artifacts, reports, world nodes and imported
 * cache, run settlement) were split into free functions in sibling modules (engine-artifacts.ts /
 * engine-report.ts / engine-world.ts / engine-settlement.ts). They do not own state; they read and
 * write the engine's private fields through this seam. The engine assembles the seam with arrow
 * closures in its constructor, and the fields remain private, so the public engine surface does
 * not change; the class retains only thin delegate methods.
 *
 * Mutable scalars (report count, import gate) are exposed through a “read method + one-way write
 * method” rather than getter/setter pairs. Each has only one allowed write direction (count only
 * increases; gate only closes), which the seam makes explicit.
 */

import type { ImportedWorldQueue } from "./imported-cache.js";
import type { ArtifactOp } from "../facade/registry.js";
import type {
  ImportedRunCache,
  InstanceRef,
  JournalStorePort,
  RunEvent,
  RunStopReason,
  WorkflowDriver,
  WorkflowError,
} from "./types.js";

/**
 * Final settlement for a run: `completed` (script return), `errored` (script error, not resumable),
 * or `stopped` (stopped and always resumable; `error` is present only for `provider` /
 * `interrupted`).
 */
export type RunSettlement =
  | { status: "completed"; artifact: unknown }
  | { status: "errored"; error: WorkflowError }
  | { status: "stopped"; reason: RunStopReason; supersededBy?: string; error?: WorkflowError };

/**
 * State of one user-facing artifact ID within this run: its member kind, number of successful
 * versions, and (for presets only) its normalized spec. All three are derived from journal rows, so
 * resume reconstruction and live bookkeeping produce the same table.
 */
export interface ArtifactIdState {
  kind: ArtifactOp;
  /** Number of successful versions (content members increment on each success; preset declarations are always 1). */
  versions: number;
  /** canonicalJson for a preset spec, used to determine whether a duplicate declaration is idempotent. Absent for content members. */
  spec?: string;
  /** Whether this ID is the run's primary artifact. At most one ID per run has this marker; reconstructed from the completed row. */
  primary?: true;
}

/** Seam for private engine state: sibling-module free functions use it to read/write WorkflowEngine's private fields. */
export interface EngineState {
  readonly runId: string;
  readonly driver: WorkflowDriver;
  readonly journal: JournalStorePort;
  /**
   * State of each **user-facing artifact** ID in this run. Reconstructed on resume from journal
   * rows with `kind: "artifact"`, then maintained in memory; caps and version numbers are run-level
   * facts that continue across resume.
   *
   * ⚠ Terminology: artifact means a user-facing output, not `RunSettlement.artifact` (the top-level return value).
   */
  readonly artifacts: Map<string, ArtifactIdState>;
  /** Imported cache for amend-resume (plain data; absent means this is not an amended resume). */
  readonly importedCache: ImportedRunCache | undefined;
  /** Consumption cursor for the world-import queue (the nth occurrence maps to the nth entry). */
  readonly importedWorld: ImportedWorldQueue;

  isRunSettled(): boolean;
  /** Error used to reject/throw after the run is settled. */
  runError(): WorkflowError;
  /** Run-level failure (first-wins; see settleFailed in engine-settlement.ts). */
  failRun(error: WorkflowError): void;
  /** Persist and fan out events (Boundary C); the engine's funnel adds their creation phase. */
  record(event: RunEvent): void;
  /** Sole allocator for site ordinals. */
  nextOrdinal(siteId: string): number;
  /**
   * Release a hit subject to replay settlement order.
   * Immediately execute `release` when this is not a resume or the order table has no entry for this instance.
   */
  holdForReplay(instance: InstanceRef, release: () => void): void;

  /** Number of reports published in this run (counter for REPORT_CAPS.maxItemsPerRun, continuous across resume). */
  reportCount(): number;
  /** Increment the counter when a report passes the cap check and is about to be stored. */
  countReport(): void;

  /** Whether the imported cache is closed. */
  importClosed(): boolean;
  /** Close the gate (never reopen). */
  closeImport(): void;

  /** Mark the run as settled; when failure is present, also record the run-level reason for reuse by runError. */
  markSettled(failure?: WorkflowError): void;
  /** Abort all in-flight asks (delegated to the scheduler). */
  abortInFlight(error: WorkflowError, emitCancelled: boolean): void;
  /** Resolve `engine.settled`. */
  resolveSettled(settlement: RunSettlement): void;
}
