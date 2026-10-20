import { useEffect, useRef } from "react";
import {
  collectPullRequestTurnEndTargets,
  runningPullRequestTaskKeys,
  type PullRequestStatusProber,
  type PullRequestStatusTarget,
} from "@/lib/pullRequestStatusProbeRunner.js";

/**
 * Turn-end invalidation shared by both pull request drivers (the sidebar and the Session manager).
 * A worktree task that transitions from running to completed/idle forces one refresh that bypasses
 * the service TTL, because the agent may have just pushed or opened a PR.
 *
 * The diff is frozen while inactive, so a transition that happens in the background is caught on
 * the next activation. Callers must memoize `targets`.
 */
export function usePullRequestTurnEndInvalidation(
  prober: PullRequestStatusProber,
  targets: readonly PullRequestStatusTarget[],
  active: boolean,
): void {
  const previousRunningRef = useRef<Set<string> | null>(null);
  // Effect dependency: re-runs only when the running set changes, not on every targets identity change.
  const runningSignature = [...runningPullRequestTaskKeys(targets)].sort().join("\u0000");

  useEffect(() => {
    if (!active) {
      return;
    }
    const { runningKeys, finishedTargets } = collectPullRequestTurnEndTargets(
      targets,
      previousRunningRef.current ?? new Set<string>(),
    );
    previousRunningRef.current = runningKeys;
    if (finishedTargets.length > 0) {
      void prober.probe(finishedTargets, { force: true });
    }
  }, [prober, targets, active, runningSignature]);
}
