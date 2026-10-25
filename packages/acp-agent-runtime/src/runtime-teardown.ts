/**
 * Process-tree teardown for one owned agent process (spec: stdin EOF →
 * `stopGraceMs` → SIGTERM / `taskkill /T` → `killGraceMs` → SIGKILL /
 * `taskkill /T /F`). State transitions stay with `AcpSessionRuntime`.
 */
import { captureProcessTreeSnapshotAsync, terminateProcessTreeAndWait } from "@zcode/shared/node";
import { AcpAgentDiedError, AcpCancelledError, AcpRuntimeError } from "./errors.js";
import {
  DEATH_GRACE_MS,
  classifyTransportFailure,
  fulfillsWithin,
  raceTimeout,
  waitUntil,
} from "./runtime-helpers.js";
import type { SpawnedAcpProcess } from "./transport.js";
import type { AcpRuntimeState } from "./types.js";

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

export interface AcpCancelSteps {
  readonly notify: () => Promise<unknown>;
  readonly graceMs: number;
  /** False once the cancelled prompt settled or was replaced, or the runtime restarted. */
  readonly isSameTurn: () => boolean;
  readonly isSettled: () => boolean;
  readonly terminate: (reason: Error) => Promise<void>;
}

/** Bounded `session/cancel`: escalates to `terminate` when the notify or the settle misses the grace. */
export async function runAcpCancel(steps: AcpCancelSteps): Promise<void> {
  // One deadline bounds the whole cancel: a notify write can stay pending
  // forever when a live child stops reading stdin (backpressured pipe), and
  // a closed connection rejects. Escalate on either instead of hanging.
  const deadline = Date.now() + steps.graceMs;
  const notified = await fulfillsWithin(steps.notify(), steps.graceMs);
  // The cancelled prompt settled (or was replaced) while the notify raced;
  // never escalate against a newer prompt or a restarted runtime.
  if (!steps.isSameTurn()) return;
  if (!notified) {
    await steps.terminate(new AcpCancelledError("Cancel notification failed or did not flush"));
    return;
  }
  const settled = await waitUntil(steps.isSettled, deadline - Date.now(), 50);
  if (!settled) {
    await steps.terminate(new AcpCancelledError("Prompt did not settle after cancel"));
  }
}

export interface AcpPromptFailureHooks {
  readonly state: () => AcpRuntimeState;
  readonly connectionAborted: () => boolean;
  /** Tears the process down; cleanup failures are reported by the caller, never thrown. */
  readonly teardown: (reason: Error) => Promise<void>;
}

/**
 * Normalizes "connection closed" rejections into `AcpAgentDiedError` when
 * the process actually died; intentional stops keep the original error.
 * Fatal transport failures (`MessageTooLargeError`, a closed connection
 * whose child survives) tear the process down before returning, so
 * `prompt()`'s `finally` cannot restore "ready" on a dead connection.
 */
export async function normalizeAcpPromptError(
  error: unknown,
  hooks: AcpPromptFailureHooks,
): Promise<unknown> {
  if (error instanceof AcpRuntimeError) return error;
  if (hooks.state() === "stopped") return error;
  const failure = classifyTransportFailure(error);
  if (failure === "closed") {
    if (await waitUntil(() => hooks.state() === "failed", DEATH_GRACE_MS)) {
      return new AcpAgentDiedError("Agent process died during the prompt", { cause: error });
    }
  }
  if (hooks.state() === "prompting" && (failure !== null || hooks.connectionAborted())) {
    // The SDK connection is unusable while the child may still be alive:
    // mark the runtime failed and kill the process so the next prompt
    // restarts instead of reusing the dead connection.
    await hooks.teardown(
      error instanceof Error ? error : new Error(`ACP transport failure: ${String(error)}`),
    );
  }
  return error;
}
