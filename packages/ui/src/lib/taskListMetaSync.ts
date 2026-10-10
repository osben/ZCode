import type { ZCodeTaskMeta } from "@zcode/shared";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { getTaskMeta, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  applyTaskQueryCacheMutation,
  removeTaskFromTaskQueryCaches,
  updateTaskQueryCacheTaskMetaPreservingMembership,
  upsertTaskQueryCacheTaskMeta,
  useTaskQueryCacheStore,
  type TaskListMembershipState,
} from "@/store/taskQueryCacheStore.js";

export function removeTaskFromTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): boolean {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  if (workspaceState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      workspaceState.taskListCache.filter((task) => task.taskId !== params.taskId),
      params.workspaceIdentity,
    );
  }
  store.removeTaskState(params.workspacePath, params.taskId, params.workspaceIdentity);
  return removeTaskFromTaskQueryCaches(params);
}

const ABSENT_MEMBERSHIP: TaskListMembershipState = {
  pinned: true,
  archived: true,
};

function sortTasksByUpdatedAt(tasks: readonly ZCodeTaskMeta[]): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

export function syncTaskMetaToTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  membership?: TaskListMembershipState;
  forceInsertMembership?: boolean;
  ensureInWorkspaceTaskCache?: boolean;
  preserveListMembership?: boolean;
  applyQueryCacheMutation?: boolean;
}): void {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const previousTask = getTaskMeta(workspaceState, params.task.taskId);
  const queryTask =
    useTaskQueryCacheStore.getState().taskMetaByEntityKey[
      buildTaskEntityKey({
        taskId: params.task.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? params.task.workspaceIdentity,
      })
    ];
  // Bugfix: updatedAt in a session/readSession snapshot may be older than the frontend optimistic time written by the initial prompt.
  // Before syncing a snapshot, monotonically merge it with existing local task metadata; otherwise a new task jumps down after the initial SQLite refresh.
  // Bugfix: during restart recovery, the workspace store may not yet contain the current task even though the query cache already has SQLite-indexed metadata.
  // The raw session snapshot has no titleOverridden field, so merge it too to prevent a manually renamed title from being reverted in the renderer.
  const task = mergeTaskMetaCandidates(params.task, previousTask, queryTask) ?? params.task;
  const cachedTasks = workspaceState.taskListCache ?? [];
  const hasCachedTask = cachedTasks.some((cachedTask) => cachedTask.taskId === task.taskId);
  const shouldExistInWorkspaceTaskCache =
    params.membership?.pinned === false && params.membership.archived === false;
  const nextCachedTasks = params.preserveListMembership
    ? cachedTasks.map((cachedTask) => (cachedTask.taskId === task.taskId ? task : cachedTask))
    : shouldExistInWorkspaceTaskCache
      ? sortTasksByUpdatedAt([
          task,
          ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId),
        ])
      : cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId);

  // Bugfix: terminal/rollback operations previously bumped the entire taskListVersion only to reload the newest snapshot.meta
  // into the list. Write back to taskListCache incrementally by task instead, avoiding a full refetch of every task list.
  if (
    workspaceState.taskListCache !== null &&
    ((params.preserveListMembership && hasCachedTask) ||
      params.ensureInWorkspaceTaskCache ||
      hasCachedTask ||
      !shouldExistInWorkspaceTaskCache)
  ) {
    store.setTaskListCache(params.workspacePath, nextCachedTasks, params.workspaceIdentity);
  }

  // Bugfix: Header/current-session details prefer optimistic metadata over an older cache value.
  // If only the query cache is updated here, the active task may continue showing its old title/summary because its optimistic entry was not updated.
  store.upsertOptimisticTaskListItem(params.workspacePath, task, params.workspaceIdentity);
  upsertTaskQueryCacheTaskMeta(task);

  if (params.preserveListMembership) {
    updateTaskQueryCacheTaskMetaPreservingMembership(task);
  } else if (params.membership && params.applyQueryCacheMutation !== false) {
    // Bugfix: when a task is created on a mobile shared host, the Desktop renderer receives only a workspace event,
    // with no local first-send call to insertTaskIntoTaskCaches. If previousTask is missing, still insert into the query cache by active
    // membership or the remote-control home screen keeps the old task order.
    // Bugfix: local first-send writes optimistic metadata before inserting the list membership. At this point previousTask exists,
    // but only represents “metadata already exists,” not “already counted in the list total.” Treat task creation explicitly as absent -> active
    // or the total for a workspace with six tasks remains 5 and Show more never appears.
    applyTaskQueryCacheMutation({
      previousTask: previousTask ?? task,
      nextTask: task,
      previousState:
        previousTask && !params.forceInsertMembership ? params.membership : ABSENT_MEMBERSHIP,
      nextState: params.membership,
    });
  }
}

export function insertTaskIntoTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  membership: TaskListMembershipState;
}): void {
  // Bugfix: create/fork/shared-host remote task creation must all use the same “absent -> present” membership change.
  // syncTaskMetaToTaskCaches inserts into the query cache as ABSENT_MEMBERSHIP when previousTask is missing;
  // do not apply the mutation a second time here, or total is incremented twice.
  syncTaskMetaToTaskCaches({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    task: params.task,
    membership: params.membership,
    forceInsertMembership: true,
    ensureInWorkspaceTaskCache:
      params.membership.pinned === false && params.membership.archived === false,
  });
}
