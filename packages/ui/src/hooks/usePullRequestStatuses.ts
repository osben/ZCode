import { useEffect, useMemo, useRef } from "react";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";
import { buildPullRequestTaskKey } from "@/store/pullRequestStatusStore.js";
import {
  createPullRequestStatusProber,
  type PullRequestStatusTarget,
} from "@/lib/pullRequestStatusProbeRunner.js";

export type { PullRequestStatusTarget };

/**
 * Probes task-level pull request status for the sidebar's workspaces on mount
 * (sidebar open), on window focus, and after in-app git mutations
 * (refreshVersion). The runtime git service owns the observation cadence (TTL
 * cache); this hook only mirrors results into the store — a failed probe drops
 * the workspace's entries so indicators degrade to hidden instead of freezing.
 *
 * Invalidating trigger: a worktree task transitions from running to
 * completed/idle (the agent may have just pushed or opened a PR). The
 * transition is detected by diffing the live running flags and fires one
 * forced probe (forceTaskIds) per finished task; while inactive the diff is
 * frozen, so transitions that happen in the background are caught on the next
 * activation.
 *
 * Callers must memoize `targets`: the effect re-runs when a remote reconnect
 * rebuilds the service lookup, which is also the reconnect re-request.
 */
export function usePullRequestStatuses(
  targets: readonly PullRequestStatusTarget[],
  options?: { active?: boolean },
): void {
  const active = options?.active ?? true;
  const setWorkspacePullRequestStatuses = usePullRequestStatusStore(
    (state) => state.setWorkspacePullRequestStatuses,
  );
  const dropWorkspaceTasks = usePullRequestStatusStore((state) => state.dropWorkspaceTasks);
  const refreshVersion = usePullRequestStatusStore((state) => state.refreshVersion);
  const forceRefresh = usePullRequestStatusStore((state) => state.forceRefresh);

  const prober = useMemo(
    () => createPullRequestStatusProber({ setWorkspacePullRequestStatuses, dropWorkspaceTasks }),
    [setWorkspacePullRequestStatuses, dropWorkspaceTasks],
  );

  const targetKeys = targets.map((target) => target.workspaceKey).join("\u0000");
  const previousKeysRef = useRef<string[] | null>(null);

  const runningTaskKeys = targets
    .flatMap((target) =>
      target.tasks
        .filter((task) => task.running)
        .map((task) => buildPullRequestTaskKey(target.workspaceKey, task.input.taskId)),
    )
    .sort();
  const runningTaskKeysSignature = runningTaskKeys.join("\u0000");

  useEffect(() => {
    if (!active) {
      return;
    }
    void prober.probe(targets);

    const onFocus = () => {
      void prober.probe(targets);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [prober, targets, active, refreshVersion]);

  // Turn-end invalidation: running → completed/idle of a worktree task forces
  // a refresh that bypasses the service TTL.
  const previousRunningRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!active) {
      // Freeze the diff while no surface is visible; the transition is
      // detected on the next activation instead of being silently consumed.
      return;
    }
    const currentRunning = new Set(runningTaskKeys);
    const previousRunning = previousRunningRef.current ?? new Set<string>();
    previousRunningRef.current = currentRunning;

    const finishedTaskKeys = [...previousRunning].filter((key) => !currentRunning.has(key));
    if (finishedTaskKeys.length === 0) {
      return;
    }
    const finished = new Set(finishedTaskKeys);
    const forcedTargets = targets
      .map((target) => ({
        ...target,
        tasks: target.tasks.filter((task) =>
          finished.has(buildPullRequestTaskKey(target.workspaceKey, task.input.taskId)),
        ),
      }))
      .filter((target) => target.tasks.length > 0);
    if (forcedTargets.length > 0) {
      void prober.probe(forcedTargets, { force: true });
    }
  }, [prober, targets, active, runningTaskKeysSignature]);

  // Explicit refresh: only the requested task keys bypass the service TTL.
  const forceTaskIdList = useMemo(() => {
    const separator = "::";
    return forceRefresh.taskKeys
      .map((taskKey) => taskKey.slice(taskKey.indexOf(separator) + separator.length))
      .filter((taskId) => taskId.length > 0);
  }, [forceRefresh]);
  useEffect(() => {
    if (!active || forceTaskIdList.length === 0) {
      return;
    }
    void prober.probe(targets, { forceTaskIds: forceTaskIdList });
  }, [prober, targets, active, forceTaskIdList]);

  // Drop store entries for workspaces that left the sidebar.
  useEffect(() => {
    const targetKeyList = targetKeys ? targetKeys.split("\u0000") : [];
    const previousKeys = previousKeysRef.current;
    if (previousKeys) {
      for (const key of previousKeys) {
        if (!targetKeyList.includes(key)) {
          dropWorkspaceTasks(key);
          prober.forget(key);
        }
      }
    }
    previousKeysRef.current = targetKeyList;
  }, [targetKeys, dropWorkspaceTasks, prober]);
}
