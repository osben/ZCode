import { useMemo } from "react";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { WorkspaceTaskListGroup } from "@/hooks/workspaceTaskListDisplayGroups.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePullRequestStatuses } from "@/hooks/usePullRequestStatuses.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { isTaskListRowRunning } from "@/v4/taskListRowActivity.js";

/**
 * Invisible mount that probes task-level pull request status for every open
 * workspace (specs/sidebar-pr-status.md). Lives once in the sidebar beside
 * BranchMergeStatusProbes so grouped, flat, archived, and hover surfaces share
 * the same store entries. The sidebar panel is hidden with CSS and never
 * unmounts, so reopening is reported through `active`.
 */
export function PullRequestStatusProbes({
  workspaceTabs,
  groups,
  active,
}: {
  workspaceTabs: WorkspaceTabState[];
  groups: WorkspaceTaskListGroup[];
  active: boolean;
}) {
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({ sessionsById, sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const workspaceServiceLookup = useMemo(
    () => buildWorkspaceServiceLookup(workspaceTabs, baseServices, serviceResolverState),
    [baseServices, serviceResolverState, workspaceTabs],
  );

  const targets = useMemo(
    () =>
      workspaceTabs.flatMap((tab) => {
        const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
        const resolved = workspaceServiceLookup.get(workspaceKey);
        const group = groups.find(
          (candidate) =>
            candidate.workspacePath === tab.workspacePath &&
            candidate.workspaceIdentity === tab.workspaceIdentity,
        );
        if (!resolved) {
          return [];
        }
        // Task-level only: ordinary sessions never ride the probe, even when
        // the workspace branch itself has a pull request.
        const tasks = (group?.items ?? [])
          .filter((task) => task.executionWorktree !== undefined)
          .map((task) => ({
            input: {
              taskId: task.taskId,
              branchName: task.executionWorktree?.branchName ?? null,
              worktreePath: task.executionWorktree?.path ?? null,
            },
            running: isTaskListRowRunning(task),
          }));
        // Reason: an open workspace stays a target even with no worktree tasks in view. Dropping it
        // would erase the Session manager's entries for the same workspace. The prober skips
        // empty targets, so this costs no request.
        return [
          {
            workspaceKey,
            workspacePath: tab.workspacePath,
            ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
            gitService: resolved.services.gitService,
            tasks,
          },
        ];
      }),
    [groups, workspaceServiceLookup, workspaceTabs],
  );

  usePullRequestStatuses(targets, { active });
  return null;
}
