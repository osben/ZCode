import { useEffect, useMemo } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import {
  createPullRequestStatusProber,
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

  const prober = useMemo(
    () => createPullRequestStatusProber({ setWorkspacePullRequestStatuses, dropWorkspaceTasks }),
    [setWorkspacePullRequestStatuses, dropWorkspaceTasks],
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

  useEffect(() => {
    if (!active || targets.length === 0) {
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
  }, [prober, targets, active]);
}
