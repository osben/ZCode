import { useEffect, useMemo, useRef } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
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

/**
 * Probes pull request status for the Session manager's visible worktree rows
 * (specs/sidebar-pr-status.md, surface 6): one request per distinct workspace
 * of the on-screen rows, written into the shared per-task store. Rows of
 * workspaces whose services cannot be resolved (closed or unreachable) keep
 * no entry and show "—". Callers must pass a memoized task list so scrolling
 * re-renders do not re-fire probes; the service TTL absorbs the rest.
 */
export function useSessionManagerPullRequests(
  visibleTasks: ReadonlyArray<
    Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity" | "executionWorktree">
  >,
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
    for (const task of visibleTasks) {
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
        running: false,
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
    visibleTasks,
    baseServices,
    sessionsById,
    sessionIdByWorkspaceIdentity,
    sessionIdByWorkspacePath,
  ]);

  // Same invalidation contract as the sidebar driver (usePullRequestStatuses): a git mutation
  // (commit/push) forces the visible rows, and an explicit refresh forces only the requested rows.
  // Both are version signals, so a targets change never replays them.
  const handledRefreshVersionRef = useRef(refreshVersion);
  useEffect(() => {
    if (!active || targets.length === 0) {
      return;
    }
    const gitMutated = handledRefreshVersionRef.current !== refreshVersion;
    handledRefreshVersionRef.current = refreshVersion;
    void prober.probe(targets, gitMutated ? { force: true } : undefined);
    const onFocus = () => {
      void prober.probe(targets);
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [prober, targets, active, refreshVersion]);

  const handledForceVersionRef = useRef(forceRefresh.version);
  useEffect(() => {
    if (!active || forceRefresh.version === handledForceVersionRef.current) {
      return;
    }
    handledForceVersionRef.current = forceRefresh.version;
    const forceTaskIds = forceTaskIdsForRequestedKeys(targets, forceRefresh.taskKeys);
    if (forceTaskIds.length === 0) {
      return;
    }
    void prober.probe(targets, { forceTaskIds });
  }, [prober, targets, active, forceRefresh]);
}
