import type { ChildProcess } from "node:child_process";
import type {
  ProcessIdentity,
  ProcessTreeOwnershipResolution,
  ProcessTreeTerminationResult,
  ProcessTreeTerminatorOptions,
  ProcessTreeTerminatorWaitOptions,
} from "./processTreeTypes.js";

const DEFAULT_FORCE_AFTER_MS = 2_000;
const DEFAULT_WAIT_AFTER_FORCE_MS = 250;
const DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS = 2_000;
const WINDOWS_LATE_EXIT_OBSERVATION_MS = 750;

interface WaitInternalOptions extends ProcessTreeTerminatorWaitOptions {
  knownIdentities?: readonly ProcessIdentity[];
  onForceCleanup?: (result: ForceCleanupResult) => void;
  onForceTimerScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
  onGracefulCleanupScheduled?: (flight: Promise<void>) => void;
  resolvedOwnership?: ProcessTreeOwnershipResolution;
}

interface ForceCleanupResult {
  identities: ProcessIdentity[];
  unverifiedRootPid?: number;
}

type TerminateProcessTree = (child: ChildProcess, options: ProcessTreeTerminatorOptions) => void;

function warn(options: ProcessTreeTerminatorWaitOptions, message: string): void {
  options.log?.warn(options.traceId, message);
}

function debug(
  options: ProcessTreeTerminatorWaitOptions,
  message: string,
  context?: Record<string, unknown>,
): void {
  options.log?.debug?.(options.traceId, message, context);
}

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessTreeTermination(
  child: ChildProcess,
  options: ProcessTreeTerminatorWaitOptions,
  initialOwnership: ProcessTreeOwnershipResolution,
  hasWindowsTaskkillTargets: boolean,
  terminateProcessTree: TerminateProcessTree,
): Promise<ProcessTreeTerminationResult> {
  if (child.pid == null) {
    return { remainingPids: [] };
  }

  const waiterStartedAtMs = Date.now();
  const forceAfterMs = Math.max(options.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS, 0);
  const waitAfterForceMs = Math.max(options.waitAfterForceMs ?? DEFAULT_WAIT_AFTER_FORCE_MS, 0);
  const isWindows = process.platform === "win32";
  const windowsTaskkillBudgetMs = hasWindowsTaskkillTargets
    ? Math.max(options.windowsTaskkillTimeoutMs ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS, 1)
    : 0;
  // Windows graceful taskkill and the force timer run concurrently; when a verified signal target exists, conservatively
  // reserve a final taskkill time limit. If identity is unavailable and the target set is empty, both taskkill flights must
  // be empty, so reserving command timeout would only make the Host wait without being able to take action.
  const windowsRelativeDeadlineMs = forceAfterMs + windowsTaskkillBudgetMs + waitAfterForceMs;
  const windowsTransportDeadlineRemainingMs =
    options.windowsCleanupDeadlineAtMs === undefined
      ? windowsRelativeDeadlineMs
      : Math.max(options.windowsCleanupDeadlineAtMs - waiterStartedAtMs, 0);
  // If transport deducts only forceAfterMs, slow CIM can consume the entire 2s force window and the waiter
  // may then add the full taskkill + exit grace again, pushing total cleanup past the Host's 3.5s phase. Keep the waiter's
  // relative boundary within the absolute boundary fixed by transport from the cleanup start; deduct only known
  // wall-clock time, not transient Promise settlement state.
  // If the final retry cannot obtain a verifiable identity, there is no taskkill target. Do not compress the transport's
  // remaining observation budget into waitAfterForceMs (250 ms in production), which could misreport a subsequent code=0 exit
  // as a persistent process. This path sends no signal to a bare PID and only observes until the existing absolute deadline;
  // the 750 ms cap also keeps this added observation path within the 4 s force-kill boundary when combined with the initial 3.25 s cleanup.
  const windowsObservationDeadlineMs = Math.max(
    windowsRelativeDeadlineMs,
    WINDOWS_LATE_EXIT_OBSERVATION_MS,
  );
  const windowsCleanupDeadlineMs =
    !hasWindowsTaskkillTargets && options.windowsCleanupDeadlineAtMs !== undefined
      ? Math.min(windowsObservationDeadlineMs, windowsTransportDeadlineRemainingMs)
      : Math.min(windowsRelativeDeadlineMs, windowsTransportDeadlineRemainingMs);
  const knownIdentities = initialOwnership.knownIdentities;

  // The root child exiting does not mean detached MCP processes have exited; the wait boundary uses only the live-process snapshot.
  // The force-kill callback replaces the tracked set with identities it has revalidated; do not wait on or reclaim bare PIDs.
  return await new Promise<ProcessTreeTerminationResult>((resolve) => {
    let settled = false;
    let trackedIdentities = initialOwnership.currentIdentities;
    let unverifiedRootPid =
      initialOwnership.childStillOwned &&
      !trackedIdentities.some((identity) => identity.pid === child.pid)
        ? child.pid
        : undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let forceWaitTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let treePollTimer: ReturnType<typeof setInterval> | undefined;

    const cleanup = () => {
      child.off?.("exit", onExit);
      if (forceTimer) clearTimeout(forceTimer);
      if (forceWaitTimer) clearTimeout(forceWaitTimer);
      if (cleanupDeadlineTimer) clearTimeout(cleanupDeadlineTimer);
      if (treePollTimer) clearInterval(treePollTimer);
      forceTimer = undefined;
      forceWaitTimer = undefined;
      cleanupDeadlineTimer = undefined;
      treePollTimer = undefined;
    };
    const settle = (remainingPids: number[] = []) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ remainingPids });
    };
    const settleIfTreeExited = () => {
      const hasRunningVerifiedProcess = trackedIdentities.some((identity) =>
        isPidAlive(identity.pid),
      );
      const hasRunningUnverifiedRoot =
        unverifiedRootPid !== undefined && !hasChildExited(child) && isPidAlive(unverifiedRootPid);
      if (!hasRunningVerifiedProcess && !hasRunningUnverifiedRoot) {
        // On Windows, the taskkill callback may arrive before the Node ChildProcess exit event.
        // If the OS no longer has the PID, wait for one more exit notification so transport/lifecycle do not see stale state
        // after the cleanup Promise returns; if the event is lost, the absolute deadline still settles using OS state.
        if (isWindows && !hasChildExited(child)) return;
        settle();
      }
    };
    const startTreePolling = () => {
      if (!treePollTimer && !settled) {
        treePollTimer = setInterval(settleIfTreeExited, 25);
      }
    };
    const collectRemainingPids = (): number[] => {
      const remainingPids = trackedIdentities
        .filter((identity) => isPidAlive(identity.pid))
        .map((identity) => identity.pid);
      if (
        unverifiedRootPid !== undefined &&
        !hasChildExited(child) &&
        isPidAlive(unverifiedRootPid)
      ) {
        remainingPids.push(unverifiedRootPid);
      }
      return remainingPids;
    };
    const onExit = () => {
      unverifiedRootPid = undefined;
      // Synchronously refreshing the CIM process list in the Windows exit callback would block the Host deadline again.
      // Here, only check whether PIDs with fixed identities are still alive; revalidate creation identity before sending force-kill.
      settleIfTreeExited();
      if (!settled) startTreePolling();
    };
    const scheduleForceWait = () => {
      if (forceWaitTimer || settled) return;
      if (waitAfterForceMs === 0) {
        settle(collectRemainingPids());
        return;
      }
      forceWaitTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(options, `runtime 进程树强制回收后仍有残留 pid=${remainingPids.join(",")}`);
        }
        settle(remainingPids);
      }, waitAfterForceMs);
    };
    const scheduleWindowsCleanupDeadline = () => {
      if (!isWindows || cleanupDeadlineTimer || settled) return;
      debug(options, "Windows runtime 进程树 cleanup deadline scheduled", {
        forceAfterMs,
        hasWindowsTaskkillTargets,
        waitAfterForceMs,
        windowsRelativeDeadlineMs,
        windowsTaskkillBudgetMs,
        windowsCleanupDeadlineMs,
        windowsCleanupDeadlineAtMs: options.windowsCleanupDeadlineAtMs,
      });
      cleanupDeadlineTimer = setTimeout(() => {
        const remainingPids = collectRemainingPids();
        if (remainingPids.length > 0) {
          warn(options, `runtime 进程树绝对 deadline 后仍有残留 pid=${remainingPids.join(",")}`);
        }
        settle(remainingPids);
      }, windowsCleanupDeadlineMs);
    };
    const onForceCleanup = (result: ForceCleanupResult) => {
      debug(options, "Windows runtime 进程树 force cleanup completed", {
        trackedPids: result.identities.map((identity) => identity.pid),
        unverifiedRootPid: result.unverifiedRootPid,
      });
      // Replace the set instead of merging: identities from the old snapshot may have expired, and keeping them could mistake new processes
      // for leftovers and invalidate process ownership semantics for subsequent waits/logs.
      trackedIdentities = result.identities;
      unverifiedRootPid = result.unverifiedRootPid;
      settleIfTreeExited();
      if (!settled) {
        startTreePolling();
        if (!isWindows) scheduleForceWait();
      }
    };

    child.once("exit", onExit);
    const waitOptions: WaitInternalOptions = {
      ...options,
      forceAfterMs,
      keepForceTimerRef: true,
      knownIdentities,
      resolvedOwnership: initialOwnership,
      onForceCleanup,
      onForceTimerScheduled: (timer) => {
        forceTimer = timer;
      },
      onGracefulCleanupScheduled: (flight) => {
        // The runner has its own timeout and runWindowsTaskkill normalizes rejections. Regardless of the command result,
        // observe OS/ChildProcess state again after the flight settles; the absolute deadline determines final failure.
        void flight.then(() => {
          debug(options, "Windows runtime 进程树 graceful cleanup flight settled");
          settleIfTreeExited();
          if (!settled) startTreePolling();
        });
      },
    };
    scheduleWindowsCleanupDeadline();
    terminateProcessTree(child, waitOptions);

    settleIfTreeExited();
    if (!settled && hasChildExited(child)) {
      startTreePolling();
    }
  });
}
