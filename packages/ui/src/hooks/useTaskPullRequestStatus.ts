import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  selectTaskPullRequestStatus,
  usePullRequestStatusStore,
} from "@/store/pullRequestStatusStore.js";

/**
 * One store entry per task key (workspaceKey::taskId); subscribes the
 * component to its task's pull request status without prop plumbing.
 */
export function useTaskPullRequestStatus(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
) {
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  return usePullRequestStatusStore((state) =>
    selectTaskPullRequestStatus(state, workspaceKey, task.taskId),
  );
}
