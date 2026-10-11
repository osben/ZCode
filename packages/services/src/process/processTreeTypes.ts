import type { TraceId } from "@zcode/shared";

export interface ProcessTreeTerminatorLogger {
  debug?: (traceId: TraceId | undefined, ...args: unknown[]) => void;
  warn: (traceId: TraceId | undefined, ...args: unknown[]) => void;
}

export interface WindowsTaskkillRequest {
  force: boolean;
  pid: number;
  timeoutMs: number;
}

export interface WindowsTaskkillResult {
  error?: unknown;
  stderr?: string;
}

export type WindowsTaskkillRunner = (
  request: WindowsTaskkillRequest,
) => Promise<WindowsTaskkillResult>;

export interface ProcessTreeTerminatorOptions {
  traceId?: TraceId;
  log?: ProcessTreeTerminatorLogger;
  forceAfterMs?: number;
  keepForceTimerRef?: boolean;
  /** Dedicated process group owned by the POSIX Host when spawned with detached=true; used only as a cleanup boundary. */
  ownedProcessGroupId?: number;
  /** Time the Windows Host spawned the process; together with exit time, constrains ownership of descendants after root exit. */
  ownedProcessStartedAtMs?: number;
  /** Time the Windows root was observed exiting; do not claim descendants created afterward by a reused PID. */
  ownedProcessExitedAtMs?: number;
  /** Actual exit event time for the managed ChildProcess, read when the asynchronous query completes. */
  resolveOwnedProcessExitedAtMs?: () => number | undefined;
  /** Injected Windows taskkill dependency; production still uses async execFile by default, but deterministic timing tests may replace it. */
  windowsTaskkillRunner?: WindowsTaskkillRunner;
  /** Per-command Windows taskkill budget; defaults to 2 seconds and can be shortened in tests. */
  windowsTaskkillTimeoutMs?: number;
  /** Absolute deadline for the full Windows cleanup flow (Unix epoch ms), covering snapshot, EOF, taskkill, and exit observation. */
  windowsCleanupDeadlineAtMs?: number;
}

export interface ProcessIdentity {
  parentPid: number;
  pid: number;
  processGroupId?: number;
  startTime: string;
}

export interface ProcessTreeOwnershipResolution {
  childStillOwned: boolean;
  currentIdentities: ProcessIdentity[];
  knownIdentities: ProcessIdentity[];
}

export interface ProcessTreeTerminationResult {
  remainingPids: number[];
}

export interface ProcessTreeSnapshot {
  rootPid: number;
  descendantPids: readonly number[];
  identities: readonly ProcessIdentity[];
  /** When the Windows process table query fails, an empty identities list does not mean the process tree has exited. */
  identityVerification?: "verified" | "unavailable";
}

export interface ProcessTreeTerminatorWaitOptions extends ProcessTreeTerminatorOptions {
  snapshot?: ProcessTreeSnapshot;
  waitAfterForceMs?: number;
}
