import { useEffect, useMemo, useRef } from "react";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";
import { usePullRequestStatusPolling } from "@/hooks/usePullRequestStatusPolling.js";
import {
  usePullRequestRefreshSignals,
  usePullRequestTurnEndInvalidation,
} from "@/hooks/usePullRequestTurnEndInvalidation.js";
import {
  createPullRequestStatusProber,
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

  // Refresh signals run before the turn-end diff, as before the shared hook: when both probe the
  // same workspace in one commit, the later (forced) turn-end write wins.
  usePullRequestRefreshSignals(prober, targets, active);
  usePullRequestTurnEndInvalidation(prober, targets, active);

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
