import { useEffect, useMemo, useRef } from "react";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";
import { usePullRequestStatusPolling } from "@/hooks/usePullRequestStatusPolling.js";
import { usePullRequestTurnEndInvalidation } from "@/hooks/usePullRequestTurnEndInvalidation.js";
import {
  createPullRequestStatusProber,
  forceTaskIdsForRequestedKeys,
  type PullRequestStatusTarget,
} from "@/lib/pullRequestStatusProbeRunner.js";

export type { PullRequestStatusTarget };

/**
 * Probes task-level pull request status for the sidebar's workspaces on mount
 * (while `active`, default true), on window focus, and after in-app git mutations
 * (refreshVersion). The runtime git service owns the observation cadence (TTL
 * cache); this hook only mirrors results into the store — a failed probe marks
 * the entries it owns stale (see createPullRequestStatusProber).
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
  const markWorkspaceTasksStale = usePullRequestStatusStore(
    (state) => state.markWorkspaceTasksStale,
  );
  const refreshVersion = usePullRequestStatusStore((state) => state.refreshVersion);
  const forceRefresh = usePullRequestStatusStore((state) => state.forceRefresh);

  const prober = useMemo(
    () =>
      createPullRequestStatusProber({
        setWorkspacePullRequestStatuses,
        dropWorkspaceTasks,
        markWorkspaceTasksStale,
      }),
    [setWorkspacePullRequestStatuses, dropWorkspaceTasks, markWorkspaceTasksStale],
  );

  const targetKeys = targets.map((target) => target.workspaceKey).join("\u0000");
  const previousKeysRef = useRef<string[] | null>(null);

  usePullRequestStatusPolling(() => {
    void prober.probe(targets);
  }, active);

  // A git mutation (commit/push) may have opened or updated a PR, so its refresh signal bypasses
  // the service TTL for every worktree task in view. A plain targets change keeps the TTL.
  const handledRefreshVersionRef = useRef(refreshVersion);
  useEffect(() => {
    if (!active) {
      // Left unhandled so the mutation is re-probed on the next activation.
      return;
    }
    const gitMutated = handledRefreshVersionRef.current !== refreshVersion;
    handledRefreshVersionRef.current = refreshVersion;
    void prober.probe(targets, gitMutated ? { force: true } : undefined);
  }, [prober, targets, active, refreshVersion]);

  usePullRequestTurnEndInvalidation(prober, targets, active);

  // Explicit refresh: only the requested tasks bypass the service TTL, once per request. The
  // version is the signal; a targets change re-runs this effect but must not replay the request.
  // Task ids come from the targets, not from parsing the composite task key.
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

  // Drop store entries for workspaces that left the sidebar. PullRequestStatusProbes keeps every
  // open resolved workspace in targets (even with no visible worktree tasks), so this fires only
  // when the workspace itself closes; the Session manager's rows for it then show "—".
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
