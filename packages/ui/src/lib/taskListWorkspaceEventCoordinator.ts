import type { ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import {
  getTaskMetaWorkspaceEventSyncMode,
  isTaskListDeletionWorkspaceEvent,
  isTaskListMembershipWorkspaceEvent,
  shouldApplyTaskMetaFromWorkspaceEvent,
  shouldRefreshTaskListForWorkspaceEvent,
} from "@/lib/taskListRefreshPolicy.js";
import {
  removeTaskFromTaskCaches,
  syncTaskMembershipEventToTaskCaches,
  syncTaskMetaToTaskCaches,
} from "@/lib/taskListMetaSync.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

const COORDINATED_EVENT_TTL_MS = 2_000;
const MAX_COORDINATED_EVENTS = 200;

export interface TaskListWorkspaceEventCacheSyncResult {
  shouldRefresh: boolean;
  handledIncrementally: boolean;
  reused: boolean;
}

const coordinatedResults = new Map<
  string,
  TaskListWorkspaceEventCacheSyncResult & { expiresAt: number }
>();

function pruneCoordinatedResults(currentTime: number): void {
  for (const [key, result] of coordinatedResults) {
    if (result.expiresAt <= currentTime) {
      coordinatedResults.delete(key);
    }
  }

  while (coordinatedResults.size > MAX_COORDINATED_EVENTS) {
    const oldestKey = coordinatedResults.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    coordinatedResults.delete(oldestKey);
  }
}

function buildCoordinatedEventKey(event: ZCodeWorkspaceTaskListChanged): string | null {
  const taskId = event.taskId ?? event.taskMeta?.taskId;
  if (!taskId) {
    return null;
  }

  const workspaceKey = buildTaskWorkspaceKey(event.workspacePath, event.workspaceIdentity);
  const metaRevision = event.taskMeta
    ? [event.taskMeta.updatedAt, event.taskMeta.createdAt, event.taskMeta.status ?? ""].join(":")
    : "";
  return [workspaceKey, event.reason, taskId, metaRevision].join("\u0000");
}

function cacheResult(
  eventKey: string | null,
  result: TaskListWorkspaceEventCacheSyncResult,
): TaskListWorkspaceEventCacheSyncResult {
  if (!eventKey) {
    return result;
  }

  const currentTime = Date.now();
  pruneCoordinatedResults(currentTime);
  coordinatedResults.set(eventKey, {
    ...result,
    reused: false,
    expiresAt: currentTime + COORDINATED_EVENT_TTL_MS,
  });
  return result;
}

export function handleTaskListWorkspaceEventCacheSync(
  event: ZCodeWorkspaceTaskListChanged,
): TaskListWorkspaceEventCacheSyncResult {
  if (shouldApplyTaskMetaFromWorkspaceEvent(event)) {
    const syncMode = getTaskMetaWorkspaceEventSyncMode(event);
    syncTaskMetaToTaskCaches({
      workspacePath: event.taskMeta.workspacePath,
      workspaceIdentity: event.taskMeta.workspaceIdentity,
      task: event.taskMeta,
      ...(syncMode === "insert-active" ? { membership: { pinned: false, archived: false } } : {}),
      // Bugfix: these events only signal task meta/status changes and carry no pinned/archived
      // semantics. Mobile remote control keeps a persistent pinned query, so the task's original
      // list must be preserved or pinned tasks would be wrongly moved out of the pinned section.
      preserveListMembership: syncMode === "preserve-membership",
    });
    // Bugfix: ordinary meta/status updates are idempotent writes and must not be deduplicated by
    // an incomplete meta revision. Swallowing consecutive title, error-detail, or change-summary
    // updates within 2s is riskier than applying the same meta twice.
    return {
      handledIncrementally: true,
      reused: false,
      shouldRefresh: false,
    };
  }

  const eventKey = buildCoordinatedEventKey(event);
  const currentTime = Date.now();
  pruneCoordinatedResults(currentTime);
  const cached = eventKey ? coordinatedResults.get(eventKey) : undefined;
  if (cached && cached.expiresAt > currentTime) {
    // Bugfix: the same workspace_task_list_changed reaches multiple hooks (timeline / pinned /
    // archived / workspace rows). The global query cache mutation may be broadcast only once per
    // membership/delete event, otherwise later listeners would see the mutated state and misjudge.
    return {
      handledIncrementally: cached.handledIncrementally,
      reused: true,
      shouldRefresh: cached.shouldRefresh,
    };
  }

  if (isTaskListMembershipWorkspaceEvent(event) && event.taskMeta) {
    syncTaskMembershipEventToTaskCaches({
      workspacePath: event.taskMeta.workspacePath,
      workspaceIdentity: event.taskMeta.workspaceIdentity,
      task: event.taskMeta,
      reason: event.reason,
    });
    return cacheResult(eventKey, {
      handledIncrementally: true,
      reused: false,
      shouldRefresh: false,
    });
  }

  if (isTaskListDeletionWorkspaceEvent(event) && event.taskId) {
    const removedFromVisibleCache = removeTaskFromTaskCaches({
      workspacePath: event.workspacePath,
      workspaceIdentity: event.workspaceIdentity,
      taskId: event.taskId,
    });
    return cacheResult(eventKey, {
      handledIncrementally: removedFromVisibleCache,
      reused: false,
      shouldRefresh: !removedFromVisibleCache,
    });
  }

  return cacheResult(eventKey, {
    handledIncrementally: false,
    reused: false,
    shouldRefresh: shouldRefreshTaskListForWorkspaceEvent(event),
  });
}

export function clearTaskListWorkspaceEventCoordinatorForTest(): void {
  coordinatedResults.clear();
}
