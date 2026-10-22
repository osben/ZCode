/**
 * Process-tree teardown for one owned agent process (spec: stdin EOF →
 * `stopGraceMs` → SIGTERM / `taskkill /T` → `killGraceMs` → SIGKILL /
 * `taskkill /T /F`). State transitions stay with `AcpSessionRuntime`.
 */
import { captureProcessTreeSnapshotAsync, terminateProcessTreeAndWait } from "@zcode/shared/node";
import { raceTimeout } from "./runtime-helpers.js";
import type { SpawnedAcpProcess } from "./transport.js";

export interface AcpTeardownTimeouts {
  readonly stopGraceMs: number;
  readonly killGraceMs: number;
}

export interface AcpTeardownPlan {
  readonly ownership: NonNullable<Parameters<typeof captureProcessTreeSnapshotAsync>[1]>;
  readonly snapshot: Awaited<ReturnType<typeof captureProcessTreeSnapshotAsync>> | undefined;
}

/** Captures ownership and the tree snapshot; call before closing the connection. */
export async function planAcpProcessTeardown(
  proc: SpawnedAcpProcess,
  timeouts: AcpTeardownTimeouts,
): Promise<AcpTeardownPlan> {
  const deadline = Date.now() + timeouts.stopGraceMs + timeouts.killGraceMs + 2500;
  const ownership: AcpTeardownPlan["ownership"] = {
    ...(process.platform === "win32" ? {} : { ownedProcessGroupId: proc.child.pid }),
    ownedProcessStartedAtMs: proc.ownedProcessStartedAtMs,
    resolveOwnedProcessExitedAtMs: proc.resolveOwnedProcessExitedAtMs,
    windowsCleanupDeadlineAtMs: deadline,
  };
  // After Node reaps the root, its PID may already belong to an unrelated process. The POSIX
  // snapshot looks the root up by bare PID, so only capture it while the child is unreaped;
  // the terminator then falls back to the owned process group. Windows filters by lifetime.
  const rootReaped = proc.child.exitCode !== null || proc.child.signalCode !== null;
  const snapshot =
    process.platform === "win32" || !rootReaped
      ? await captureProcessTreeSnapshotAsync(proc.child, ownership)
      : undefined;
  return { ownership, snapshot };
}

/** Sends stdin EOF, waits the grace period, then terminates the tree; returns surviving PIDs. */
export async function runAcpProcessTeardown(
  proc: SpawnedAcpProcess,
  plan: AcpTeardownPlan,
  timeouts: AcpTeardownTimeouts,
): Promise<readonly number[]> {
  try {
    proc.child.stdin?.end();
  } catch {
    // stdin may already be closed.
  }
  await raceTimeout(proc.exited, timeouts.stopGraceMs);
  const result = await terminateProcessTreeAndWait(proc.child, {
    ...plan.ownership,
    ...(plan.snapshot ? { snapshot: plan.snapshot } : {}),
    forceAfterMs: timeouts.killGraceMs,
    waitAfterForceMs: 500,
    windowsTaskkillTimeoutMs: 2000,
  });
  return result.remainingPids;
}
