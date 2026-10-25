import { useEffect, useRef } from "react";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";
import {
  collectPullRequestTurnEndTargets,
  forceTaskIdsForRequestedKeys,
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

/**
 * Git-mutation refresh shared by both pull request drivers. Callers must memoize `targets`: this
 * effect is also the mount, targets-change and reconnect re-request (no force, the TTL applies).
 * A git mutation (`refreshVersion`, commit/push) forces every worktree task in view. The version
 * is consumed only while there are targets, so a mutation that lands with nothing in view (or
 * while inactive) forces the next probe that has targets instead of being lost.
 *
 * Effect order matters: the prober keeps only the newest response per workspace, so callers
 * keep their relative order with the turn-end hook and call usePullRequestExplicitRefresh last.
 */
export function usePullRequestGitMutationRefresh(
  prober: PullRequestStatusProber,
  targets: readonly PullRequestStatusTarget[],
  active: boolean,
): void {
  const refreshVersion = usePullRequestStatusStore((state) => state.refreshVersion);
  const handledRefreshVersionRef = useRef(refreshVersion);
  useEffect(() => {
    if (!active || targets.length === 0) {
      // Left unhandled so the mutation is re-probed once targets are in view and active.
      return;
    }
    const gitMutated = handledRefreshVersionRef.current !== refreshVersion;
    handledRefreshVersionRef.current = refreshVersion;
    void prober.probe(targets, gitMutated ? { force: true } : undefined);
  }, [prober, targets, active, refreshVersion]);
}

/**
 * Explicit refresh (`forceRefresh`) shared by both pull request drivers: only the requested tasks
 * bypass the TTL, once per version; a targets change re-runs the effect but must not replay the
 * request. Task ids come from the targets, not from parsing the composite task key. Call it after
 * the other probing hooks: its probe carries every task in view, so it must be the newest one.
 */
export function usePullRequestExplicitRefresh(
  prober: PullRequestStatusProber,
  targets: readonly PullRequestStatusTarget[],
  active: boolean,
): void {
  const forceRefresh = usePullRequestStatusStore((state) => state.forceRefresh);
  const handledForceVersionRef = useRef(forceRefresh.version);
  useEffect(() => {
    if (!active || forceRefresh.version === handledForceVersionRef.current) {
      return;
    }
    handledForceVersionRef.current = forceRefresh.version;
    const forceTaskIdsByWorkspace = forceTaskIdsForRequestedKeys(targets, forceRefresh.taskKeys);
    if (forceTaskIdsByWorkspace.size === 0) {
      return;
    }
    void prober.probe(targets, { forceTaskIdsByWorkspace });
  }, [prober, targets, active, forceRefresh]);
}
