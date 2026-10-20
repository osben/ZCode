import { getVisibleTaskMetas } from "@/store/zcodeSessionStoreSelectors.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";

type WorkspaceUnreadState = Pick<
  WorkspaceZCodeUIState,
  "optimisticTaskListByTaskId" | "taskListCache"
> &
  Partial<Pick<WorkspaceZCodeUIState, "taskUnreadByTaskId">>;

export function countWorkspaceUnreadTasks(workspace: WorkspaceUnreadState): number {
  const visibleTasks = getVisibleTaskMetas(workspace);
  if (visibleTasks.length > 0) {
    return visibleTasks.filter((task) => Boolean(task.unreadAt)).length;
  }

  return Object.keys(workspace.taskUnreadByTaskId ?? {}).length;
}

export function countAllUnreadTasks(workspaces: Record<string, WorkspaceUnreadState>): number {
  const countedTaskKeys = new Set<string>();
  const visitedWorkspaceStates = new WeakSet<object>();

  for (const [workspaceKey, workspace] of Object.entries(workspaces)) {
    if (visitedWorkspaceStates.has(workspace)) {
      continue;
    }
    visitedWorkspaceStates.add(workspace);
    // Unread state now comes uniformly from task meta.unreadAt.
    // The Dock badge must read the same metadata as the task-list blue dot instead of relying on the old temporary map.
    const visibleTasks = getVisibleTaskMetas(workspace);
    for (const task of visibleTasks) {
      if (!task.unreadAt) {
        continue;
      }
      countedTaskKeys.add(
        `${task.workspaceIdentity?.trim() || task.workspacePath}::${task.taskId}`,
      );
    }

    if (visibleTasks.length > 0) {
      continue;
    }

    // Remote workspaces retain compatibility state under both the path key and workspaceIdentity key.
    // Deduplicate by workspaceKey + taskId and skip identical object references so the window unread badge does not count the same remote task twice.
    for (const taskId of Object.keys(workspace.taskUnreadByTaskId ?? {})) {
      countedTaskKeys.add(`${workspaceKey}::${taskId}`);
    }
  }

  return countedTaskKeys.size;
}
