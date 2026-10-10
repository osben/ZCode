import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { getTaskUnreadIndicator, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { logger } from "@/logger.js";

type TaskUnreadService = Pick<IZCodeTaskService, "setTaskUnread">;

const STATUS_UNREAD_DEDUPE_WINDOW_MS = 1_000;
const STATUS_UNREAD_DEDUPE_MAX_KEYS = 256;
const recentStatusUnreadAtByKey = new Map<string, number>();

function isTerminalTaskStatus(status: ZCodeTaskMeta["status"]): boolean {
  return status === "completed" || status === "error";
}

function buildStatusUnreadKey(event: ZCodeWorkspaceTaskListChanged, taskId: string): string {
  const workspaceKey = buildTaskWorkspaceKey(event.workspacePath, event.workspaceIdentity);
  return [workspaceKey, taskId, event.taskMeta?.status ?? "", event.taskMeta?.updatedAt ?? ""].join(
    "::",
  );
}

function shouldSkipRecentStatusUnread(key: string): boolean {
  const now = Date.now();
  for (const [recentKey, at] of recentStatusUnreadAtByKey) {
    if (now - at > STATUS_UNREAD_DEDUPE_WINDOW_MS) {
      recentStatusUnreadAtByKey.delete(recentKey);
    }
  }
  if (recentStatusUnreadAtByKey.has(key)) {
    return true;
  }
  recentStatusUnreadAtByKey.set(key, now);
  if (recentStatusUnreadAtByKey.size > STATUS_UNREAD_DEDUPE_MAX_KEYS) {
    const oldestKey = recentStatusUnreadAtByKey.keys().next().value;
    if (oldestKey) {
      recentStatusUnreadAtByKey.delete(oldestKey);
    }
  }
  return false;
}

function shouldMarkStatusEventTaskUnread(params: {
  activeTaskId: string | null;
  activeWorkspace: { workspacePath: string; workspaceIdentity?: string };
  event: ZCodeWorkspaceTaskListChanged;
}): boolean {
  const taskId = params.event.taskId ?? params.event.taskMeta?.taskId;
  const isEventWorkspaceActive =
    buildTaskWorkspaceKey(
      params.activeWorkspace.workspacePath,
      params.activeWorkspace.workspaceIdentity,
    ) === buildTaskWorkspaceKey(params.event.workspacePath, params.event.workspaceIdentity);
  return (
    params.event.reason === "task_status_changed" &&
    params.event.unreadSignal === "background_terminal" &&
    Boolean(taskId) &&
    isTerminalTaskStatus(params.event.taskMeta?.status) &&
    (!isEventWorkspaceActive || params.activeTaskId !== taskId)
  );
}

export function syncTaskUnreadFromStatusWorkspaceEvent(params: {
  activeWorkspace: { workspacePath: string; workspaceIdentity?: string };
  event: ZCodeWorkspaceTaskListChanged;
  service: TaskUnreadService;
}): void {
  const { event, service } = params;
  const taskId = event.taskId ?? event.taskMeta?.taskId;
  if (
    !taskId ||
    event.reason !== "task_status_changed" ||
    event.unreadSignal !== "background_terminal"
  ) {
    return;
  }

  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(event.workspacePath, event.workspaceIdentity);
  if (
    !shouldMarkStatusEventTaskUnread({
      activeTaskId: workspaceState.activeTaskId,
      activeWorkspace: params.activeWorkspace,
      event,
    })
  ) {
    return;
  }

  const targetTask = {
    taskId,
    workspacePath: event.workspacePath,
    ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
  };
  const taskEntityKey = buildTaskEntityKey(targetTask);
  const queryCacheState = useTaskQueryCacheStore.getState();
  const cachedTask = queryCacheState.taskMetaByEntityKey[taskEntityKey];
  const pendingUnreadAt = queryCacheState.taskUnreadOverlayByEntityKey[taskEntityKey];
  const persistedUnreadAt =
    cachedTask?.unreadAt ??
    event.taskMeta?.unreadAt ??
    (typeof pendingUnreadAt === "number" ? pendingUnreadAt : undefined);
  if (typeof persistedUnreadAt === "number") {
    // The same status event may be received by multiple sidebar subscriptions. After the first listener writes the
    // query-row overlay, later listeners only update the compatibility Dock badge and do not write it again.
    // If the event already carries unreadAt, reconcile that field directly; do not create a permanent overlay for an existing unread marker.
    if (typeof cachedTask?.unreadAt !== "number" && typeof pendingUnreadAt !== "number") {
      rollbackTaskQueryCacheUnread(targetTask, persistedUnreadAt);
    }
    store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
    return;
  }

  const dedupeKey = buildStatusUnreadKey(event, taskId);
  if (shouldSkipRecentStatusUnread(dedupeKey)) {
    return;
  }

  const previousUnreadAt = cachedTask?.unreadAt;
  const previousLegacyUnread = getTaskUnreadIndicator(workspaceState, taskId);
  const optimisticUnreadAt = Date.now();
  // The V4 sidebar now consumes unreadAt only from the task query row; the old Zustand
  // taskUnreadByTaskId no longer drives TaskListItem. Background terminal states must first write a field overlay by exact entity key;
  // later queries will merge this overlay even if the new task row has not been published yet.
  setTaskQueryCacheUnreadOverlay(targetTask, optimisticUnreadAt);
  // Transitional projection for the compatibility Dock badge; query-row unreadAt remains the sidebar blue dot's only source of truth.
  store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
  void service
    .setTaskUnread({
      ...targetTask,
      unread: true,
    })
    .then((meta) => {
      // The server updates tasks-index before replying; reconcile only the unreadAt field and never overwrite all metadata
      // from sessions-index activity, so background completion/unread updates do not change Updated sorting.
      const committedUnreadAt = meta.unreadAt ?? optimisticUnreadAt;
      reconcileTaskQueryCacheUnread(targetTask, committedUnreadAt);
      store.setTaskUnreadIndicator(event.workspacePath, taskId, true, event.workspaceIdentity);
    })
    .catch((error: unknown) => {
      // Do not leave a renderer-only fake unread marker when persistence fails. Restore the pre-commit field,
      // then mark the exact workspace dirty so the next membership join returns to tasks-index as the source of truth.
      rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
      store.setTaskUnreadIndicator(
        event.workspacePath,
        taskId,
        previousLegacyUnread,
        event.workspaceIdentity,
      );
      markTaskQueryCacheScopesStale([targetTask]);
      bumpTaskListMembershipVersion();
      logger.warn(
        "[taskStatusUnreadSync] 持久化后台终态未读失败",
        {
          taskId,
          workspaceIdentity: event.workspaceIdentity ?? null,
          workspacePath: event.workspacePath,
        },
        error,
      );
    });
}
