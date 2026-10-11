import type { ZCodeTaskMeta } from "@zcode/shared";
import type { CachedTaskListResult } from "@/lib/taskQueryCache.js";
import {
  mergeWorkspaceTaskListItemsWithOptimistic,
  type WorkspaceOptimisticTaskOverlay,
} from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import { areTaskListItemsEquivalent } from "@/hooks/workspaceTaskListRefreshSignatures.js";
import { countLiveWorkflowRuns } from "@/lib/workflowRunLine.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

interface WorkspaceTaskListDisplayConfig {
  scope: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  workspaceKey: string;
  visibleLimit: number;
  queryKey: string;
}

export interface WorkspaceTaskListGroup {
  workspacePath: string;
  workspaceIdentity?: string;
  items: ZCodeTaskMeta[];
  total: number;
  hasMore: boolean;
  hasUnread: boolean;
  /** Number of workflow runs currently active in the group; drives the pulse beside a collapsed project heading. */
  liveWorkflowCount: number;
}

export function buildWorkspaceTaskListDisplayGroups(params: {
  queryConfigs: WorkspaceTaskListDisplayConfig[];
  resultsByQueryKey: Record<string, CachedTaskListResult>;
  taskMetaByEntityKey: Record<string, ZCodeTaskMeta>;
  taskUnreadOverlayByEntityKey: Record<string, number | null>;
  optimisticTaskOverlayByWorkspaceKey: Map<string, WorkspaceOptimisticTaskOverlay>;
  previousGroupsByWorkspaceKey: Map<string, WorkspaceTaskListGroup>;
  sortBy: "created" | "updated";
}): {
  groups: WorkspaceTaskListGroup[];
  cache: Map<string, WorkspaceTaskListGroup>;
} {
  const cache = new Map<string, WorkspaceTaskListGroup>();
  const groups = params.queryConfigs.map<WorkspaceTaskListGroup>((config) => {
    const cachedResult = params.resultsByQueryKey[config.queryKey];
    const previousGroup = params.previousGroupsByWorkspaceKey.get(config.workspaceKey);
    if (!cachedResult && previousGroup) {
      // Changing the workspace visible limit from 5 to 10/15 creates a new limit cache key.
      // While the new key is first computed, reuse the previous snapshot and clip it to the target
      // limit to avoid blanking task rows. Resetting to 5 when collapsing also avoids briefly showing
      // extra tasks from the previous limit.
      const placeholderItems = previousGroup.items.slice(0, config.visibleLimit);
      const placeholderHasMore = previousGroup.total > placeholderItems.length;
      const placeholderGroup =
        placeholderItems.length === previousGroup.items.length &&
        previousGroup.hasMore === placeholderHasMore &&
        previousGroup.workspacePath === config.scope.workspacePath &&
        previousGroup.workspaceIdentity === config.scope.workspaceIdentity
          ? previousGroup
          : {
              ...previousGroup,
              workspacePath: config.scope.workspacePath,
              workspaceIdentity: config.scope.workspaceIdentity,
              items: placeholderItems,
              hasMore: placeholderHasMore,
            };
      cache.set(config.workspaceKey, placeholderGroup);
      return placeholderGroup;
    }

    const displayResult = cachedResult;
    const cachedItems =
      displayResult?.taskKeys
        .map((taskKey) => params.taskMetaByEntityKey[taskKey])
        .filter((task): task is ZCodeTaskMeta => Boolean(task)) ?? [];
    const optimisticOverlay = params.optimisticTaskOverlayByWorkspaceKey.get(config.workspaceKey);
    const items = mergeWorkspaceTaskListItemsWithOptimistic({
      items: cachedItems,
      optimisticTasks: optimisticOverlay?.tasks ?? [],
      activeTaskId: optimisticOverlay?.activeTaskId ?? null,
      sortBy: params.sortBy,
      visibleLimit: config.visibleLimit,
    });
    const total = Math.max(displayResult?.total ?? cachedItems.length, items.length);
    const hasUnread =
      items.some((task) => typeof task.unreadAt === "number") ||
      (displayResult?.unreadTaskKeys ?? []).some(
        (taskKey) => params.taskUnreadOverlayByEntityKey[taskKey] !== null,
      );
    const liveWorkflowCount = items.reduce(
      (count, task) =>
        count + countLiveWorkflowRuns(getTaskListRowActivity(task)?.workflowActivity),
      0,
    );
    const nextGroup = {
      workspacePath: config.scope.workspacePath,
      workspaceIdentity: config.scope.workspaceIdentity,
      items,
      total,
      hasMore: Math.max(total, items.length) > items.length,
      hasUnread,
      liveWorkflowCount,
    };
    if (
      previousGroup &&
      previousGroup.workspacePath === nextGroup.workspacePath &&
      previousGroup.workspaceIdentity === nextGroup.workspaceIdentity &&
      previousGroup.total === nextGroup.total &&
      previousGroup.hasMore === nextGroup.hasMore &&
      previousGroup.hasUnread === nextGroup.hasUnread &&
      previousGroup.liveWorkflowCount === nextGroup.liveWorkflowCount &&
      areTaskListItemsEquivalent(previousGroup.items, nextGroup.items)
    ) {
      cache.set(config.workspaceKey, previousGroup);
      return previousGroup;
    }

    // When adding a workspace or reordering containers by dragging, only the workspace order changes.
    // Rebuilding every group/items array would give memoized row components new references and make
    // the whole sidebar appear to refresh. Reuse equivalent display snapshots by workspaceKey so
    // only new or actually changed workspaces enter optimistic loading.
    cache.set(config.workspaceKey, nextGroup);
    return nextGroup;
  });

  return { groups, cache };
}
