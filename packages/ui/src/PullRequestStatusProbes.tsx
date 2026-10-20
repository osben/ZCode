import { useMemo } from "react";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { usePullRequestStatuses } from "@/hooks/usePullRequestStatuses.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { isTaskListRowRunning } from "@/v4/taskListRowActivity.js";
import { collectPullRequestStatusTaskCandidates } from "@/lib/pullRequestStatusProbeRunner.js";

/**
 * Invisible mount that probes task-level pull request status for every open
 * workspace (specs/sidebar-pr-status.md). It reads unbounded timeline, pinned,
 * and archived task lists so status is not limited to rendered sidebar rows.
 * Always active while mounted: the header chip and Git tools read the same
 * store when the sidebar is collapsed, and the sidebar panel never unmounts.
 */
export function PullRequestStatusProbes({
  workspaceTabs,
  sortBy,
}: {
  workspaceTabs: WorkspaceTabState[];
  sortBy: "created" | "updated";
}) {
  const baseServices = useBaseWorkspaceServices();
  const timelineTasks = useGlobalTaskList({
    kind: "timeline",
    workspaceTabs,
    sortBy,
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });
  const pinnedTasks = useGlobalTaskList({
    kind: "pinned",
    workspaceTabs,
    sortBy,
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });
  const archivedTasks = useGlobalTaskList({
    kind: "archived",
    workspaceTabs,
    sortBy,
    searchQuery: "",
    expanded: true,
    collapsedLimit: 20,
  });
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
  const taskCandidates = useMemo(
    () =>
      collectPullRequestStatusTaskCandidates([
        timelineTasks.items,
        pinnedTasks.items,
        archivedTasks.items,
      ]),
    [archivedTasks.items, pinnedTasks.items, timelineTasks.items],
  );

  // Reason: taskCandidates is rebuilt on every task-list update, including streaming activity
  // frames. Key the targets on the probe inputs only, so an unchanged probe does not re-run the
  // probe effect (one RPC per workspace) on every frame.
  const targetsSignature = JSON.stringify(
    taskCandidates.map((task) => [
      buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
      task.taskId,
      task.executionWorktree?.branchName ?? null,
      task.executionWorktree?.path ?? null,
      isTaskListRowRunning(task),
    ]),
  );
  const targets = useMemo(
    () =>
      workspaceTabs.flatMap((tab) => {
        const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
        const resolved = workspaceServiceLookup.get(workspaceKey);
        if (!resolved) {
          return [];
        }
        // Task-level only: ordinary sessions never ride the probe, even when
        // the workspace branch itself has a pull request.
        const tasks = taskCandidates
          .filter(
            (task) =>
              buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === workspaceKey,
          )
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
    // taskCandidates is represented by targetsSignature; the closure reads the latest value
    // whenever the signature changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reason: content-keyed memo, see targetsSignature
    [targetsSignature, workspaceServiceLookup, workspaceTabs],
  );

  usePullRequestStatuses(targets);
  return null;
}
