import { useEffect, useMemo, useRef } from "react";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import {
  createPullRequestStatusProber,
  forceTaskIdsForRequestedKeys,
  type PullRequestStatusTarget,
  type PullRequestStatusTargetTask,
} from "@/lib/pullRequestStatusProbeRunner.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { usePullRequestStatusStore } from "@/store/pullRequestStatusStore.js";
import { usePullRequestStatusPolling } from "@/hooks/usePullRequestStatusPolling.js";
import { usePullRequestTurnEndInvalidation } from "@/hooks/usePullRequestTurnEndInvalidation.js";
import type { SessionManagerRow } from "./sessionManagerModel.js";

/**
 * Probes pull request status for the Session manager's visible worktree rows
 * (specs/sidebar-pr-status.md, surface 6): one request per distinct workspace
 * of the on-screen rows, written into the shared per-task store. Rows of
 * workspaces whose services cannot be resolved (closed or unreachable) keep
 * no entry and show "—". Callers must pass a memoized task list so scrolling
 * re-renders do not re-fire probes; the service TTL absorbs the rest.
 */
export function useSessionManagerPullRequests(
  visibleRows: ReadonlyArray<SessionManagerRow>,
  options?: { active?: boolean },
): void {
  const active = options?.active ?? true;
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
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

  const targets = useMemo<PullRequestStatusTarget[]>(() => {
    const inputsByWorkspace = new Map<
      string,
      {
        workspacePath: string;
        workspaceIdentity?: string;
        taskInputs: PullRequestStatusTargetTask[];
      }
    >();
    for (const row of visibleRows) {
      const task = row.task;
      const worktree = task.executionWorktree;
      if (!worktree) {
        continue;
      }
      const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
      const entry = inputsByWorkspace.get(workspaceKey) ?? {
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        taskInputs: [],
      };
      entry.taskInputs.push({
        input: {
          taskId: task.taskId,
          branchName: worktree.branchName ?? null,
          worktreePath: worktree.path ?? null,
        },
        // The row's live running flag (liveStatus running or waiting) drives the turn-end diff.
        running: row.running,
      });
      inputsByWorkspace.set(workspaceKey, entry);
    }
    if (inputsByWorkspace.size === 0) {
      return [];
    }
    const lookup = buildWorkspaceServiceLookup(
      [...inputsByWorkspace.values()].map((entry) => ({
        workspacePath: entry.workspacePath,
        ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
      })),
      baseServices,
      { sessionsById, sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath },
    );
    const resolved: PullRequestStatusTarget[] = [];
    for (const [workspaceKey, entry] of inputsByWorkspace) {
      const services = lookup.get(workspaceKey);
      if (!services) {
        continue;
      }
      resolved.push({
        workspaceKey,
        workspacePath: entry.workspacePath,
        ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
        gitService: services.services.gitService,
        tasks: entry.taskInputs,
      });
    }
    return resolved;
  }, [
    visibleRows,
    baseServices,
    sessionsById,
    sessionIdByWorkspaceIdentity,
    sessionIdByWorkspacePath,
  ]);
  usePullRequestStatusPolling(
    () => {
      void prober.probe(targets);
    },
    active && targets.length > 0,
  );

  // Same invalidation contract as the sidebar driver (usePullRequestStatuses): a turn end, a git
  // mutation (commit/push) or an explicit refresh force the affected rows. The turn-end diff is the
  // shared hook; the version signals are not replayed by a targets change.
  usePullRequestTurnEndInvalidation(prober, targets, active);

  const handledRefreshVersionRef = useRef(refreshVersion);
  useEffect(() => {
    if (!active || targets.length === 0) {
      return;
    }
    const gitMutated = handledRefreshVersionRef.current !== refreshVersion;
    handledRefreshVersionRef.current = refreshVersion;
    void prober.probe(targets, gitMutated ? { force: true } : undefined);
  }, [prober, targets, active, refreshVersion]);

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
