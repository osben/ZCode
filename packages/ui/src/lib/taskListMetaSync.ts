import type { InputId, ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import {
  getTaskMeta,
  resolveWorkspaceStateKey,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import { mergeTaskMetaCandidates, mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import {
  applyTaskQueryCacheMutation,
  removeTaskFromTaskQueryCaches,
  updateTaskQueryCacheTaskMetaPreservingMembership,
  upsertTaskQueryCacheTaskMeta,
  useTaskQueryCacheStore,
  type TaskListMembershipState,
} from "@/store/taskQueryCacheStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

const ABSENT_MEMBERSHIP: TaskListMembershipState = {
  pinned: true,
  archived: true,
};

function inferTaskMembershipFromQueryCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): TaskListMembershipState | null {
  const entityKey = buildTaskEntityKey(params);
  const workspaceKey = buildTaskWorkspaceKey(params.workspacePath, params.workspaceIdentity);
  const { resultsByQueryKey } = useTaskQueryCacheStore.getState();
  let foundActive = false;
  let foundPinned = false;

  for (const result of Object.values(resultsByQueryKey)) {
    if (!result.taskKeys.includes(entityKey)) {
      continue;
    }
    if (!result.descriptor.workspaceKeys.includes(workspaceKey)) {
      continue;
    }
    if (result.descriptor.kind === "archived") {
      return { pinned: false, archived: true };
    }
    if (result.descriptor.kind === "pinned") {
      foundPinned = true;
      continue;
    }
    if (
      result.descriptor.kind === "workspace" ||
      result.descriptor.kind === "timeline" ||
      // Bugfix: active is the canonical active list used by search/Command Center. Omitting it makes
      // active-only visible tasks appear absent, causing pin/archive events to update total incorrectly.
      result.descriptor.kind === "active"
    ) {
      foundActive = true;
    }
  }

  if (foundPinned) {
    return { pinned: true, archived: false };
  }
  if (foundActive) {
    return { pinned: false, archived: false };
  }

  return null;
}

function membershipForWorkspaceEventReason(
  reason: "task_archived" | "task_unarchived" | "task_pinned" | "task_unpinned",
): TaskListMembershipState {
  switch (reason) {
    case "task_archived":
      return { pinned: false, archived: true };
    case "task_pinned":
      return { pinned: true, archived: false };
    case "task_unarchived":
    case "task_unpinned":
      return { pinned: false, archived: false };
  }
}

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

export function syncTaskMembershipEventToTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  reason: "task_archived" | "task_unarchived" | "task_pinned" | "task_unpinned";
}): void {
  const previousMembership =
    inferTaskMembershipFromQueryCaches({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      taskId: params.task.taskId,
    }) ?? ABSENT_MEMBERSHIP;
  const nextMembership = membershipForWorkspaceEventReason(params.reason);

  // Bugfix: when remote control or another window archives/pins a task, this window has no local
  // optimistic mutation. Previously, only the entire query cache could be invalidated, making the
  // list flicker after a click. Infer the old membership from the current cache position and move it incrementally.
  syncTaskMetaToTaskCaches({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    task: params.task,
    membership: nextMembership,
    applyQueryCacheMutation: false,
  });
  applyTaskQueryCacheMutation({
    previousTask: params.task,
    nextTask: params.task,
    previousState: previousMembership,
    nextState: nextMembership,
  });
}

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

export function patchTaskMetaInTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  patch: (task: ZCodeTaskMeta) => Partial<ZCodeTaskMeta>;
}): ZCodeTaskMeta | null {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const identityWorkspaceState = params.workspaceIdentity
    ? store.workspaces[resolveWorkspaceStateKey(params.workspacePath, params.workspaceIdentity)]
    : undefined;
  const taskCacheState = identityWorkspaceState ?? workspaceState;
  const currentTask =
    getTaskMeta(workspaceState, params.taskId) ??
    (identityWorkspaceState ? getTaskMeta(identityWorkspaceState, params.taskId) : null);
  if (!currentTask) {
    return null;
  }

  const patch = params.patch(currentTask);
  const shouldPreserveManualTitle =
    currentTask.titleOverridden === true &&
    patch.title !== undefined &&
    patch.title !== currentTask.title &&
    patch.titleOverridden !== false;
  const patchedTask = {
    ...currentTask,
    ...patch,
    // Bugfix: after a user renames a task, session_info_update from the running session may still
    // contain its automatic title. These patches should refresh only runtime fields and must not
    // temporarily overwrite a manually set titleOverridden value.
    title: shouldPreserveManualTitle ? currentTask.title : (patch.title ?? currentTask.title),
    titleOverridden: patch.titleOverridden ?? currentTask.titleOverridden,
  };
  // Bugfix: session_info_update/snapshot patches may only be filling runtime state while carrying
  // the “New session” placeholder title. Merge with current metadata again after the patch to keep
  // status/target/updatedAt without writing the placeholder into the task/query cache.
  const nextTask = mergeTaskWithOptimisticMeta(patchedTask, currentTask);

  store.upsertOptimisticTaskListItem(params.workspacePath, nextTask, params.workspaceIdentity);
  if (taskCacheState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      taskCacheState.taskListCache.map((task) => (task.taskId === params.taskId ? nextTask : task)),
      params.workspaceIdentity,
    );
  }
  // Bugfix: when mobile returns from chat to the task list, run start patches only the current
  // task's status/updatedAt. If the query cache replaces metadata without reordering, the
  // remote-control home sorted by update time stays in the old order.
  updateTaskQueryCacheTaskMetaPreservingMembership(nextTask);

  return nextTask;
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

export function initializeBackgroundTaskInTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  provider: ZCodeProvider;
  activeInputId: InputId;
}): void {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const previousTask = getTaskMeta(workspaceState, params.task.taskId);
  const task = previousTask ? mergeTaskWithOptimisticMeta(params.task, previousTask) : params.task;

  store.initializeBackgroundTaskRuntime(params.workspacePath, {
    workspaceIdentity: params.workspaceIdentity,
    task,
    provider: params.provider,
    activeInputId: params.activeInputId,
  });
  upsertTaskQueryCacheTaskMeta(task);
  // Root cause: background first-send no longer writes optimistically before inserting into the
  // cache. The query cache still needs to insert the member as “absent → active” so sidebar total
  // and Show more match a regular first send.
  applyTaskQueryCacheMutation({
    previousTask: previousTask ?? task,
    nextTask: task,
    previousState: ABSENT_MEMBERSHIP,
    nextState: { pinned: false, archived: false },
  });
}
