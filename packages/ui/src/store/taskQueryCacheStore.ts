/* eslint-disable max-lines -- Keep task-query cache descriptors, membership, and mutations in the same Zustand transaction; splitting them would raise cache-consistency risk. */
import { create } from "zustand";
import type { ZCodeTaskListItem } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { getTaskListRowActivity, mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import {
  buildTaskEntityKey,
  buildTaskWorkspaceKey,
  type CachedTaskListResult,
  type TaskListCacheDescriptor,
  type TaskEntityKey,
  type TaskListCacheKey,
} from "@/lib/taskQueryCache.js";
import { notifyTaskLifecycle } from "@/lib/taskLifecycleEvents.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TaskListMembershipState {
  pinned: boolean;
  archived: boolean;
}

interface TaskQueryCacheState {
  resultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult>;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  /** Override unreadAt while it is being submitted or awaiting membership confirmation; null means clear it. */
  taskUnreadOverlayByEntityKey: Record<TaskEntityKey, number | null>;
  setQueryResult: (params: {
    queryKey: TaskListCacheKey;
    descriptor: TaskListCacheDescriptor;
    items: CachedTaskListItem[];
    total: number;
    hasMore: boolean;
    unreadTaskKeys?: TaskEntityKey[];
    partial?: boolean;
    loadingShardKeys?: string[];
    failedShardKeys?: string[];
  }) => void;
  setQueryResults: (
    entries: Array<{
      queryKey: TaskListCacheKey;
      descriptor: TaskListCacheDescriptor;
      items: CachedTaskListItem[];
      total: number;
      hasMore: boolean;
      unreadTaskKeys?: TaskEntityKey[];
      partial?: boolean;
      loadingShardKeys?: string[];
      failedShardKeys?: string[];
      /** invalidationVersion observed when this async query started; discard the entire result if it no longer matches. */
      expectedInvalidationVersion?: number;
    }>,
  ) => void;
  upsertTaskMeta: (task: ZCodeTaskMeta) => void;
  updateTaskMetaPreservingMembership: (task: ZCodeTaskMeta) => void;
  applyTaskMutation: (params: {
    previousTask: ZCodeTaskMeta;
    nextTask: ZCodeTaskMeta;
    previousState: TaskListMembershipState;
    nextState: TaskListMembershipState;
  }) => void;
  setTaskUnreadOverlay: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  reconcileTaskUnread: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  rollbackTaskUnread: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  removeTask: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  markWorkspaceKeysStale: (workspaceKeys: string[]) => void;
  invalidateWorkspaceKeys: (workspaceKeys: string[]) => void;
  clearAll: () => void;
}

type CachedTaskListItem = ZCodeTaskListItem & { searchSnippets?: string[] };

function buildCachedTaskListResult(params: {
  descriptor: TaskListCacheDescriptor;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial?: boolean;
  loadingShardKeys?: string[];
  failedShardKeys?: string[];
  invalidationVersion?: number;
}): CachedTaskListResult {
  return {
    taskKeys: params.taskKeys,
    unreadTaskKeys: params.unreadTaskKeys,
    searchSnippetsByTaskKey: params.searchSnippetsByTaskKey,
    searchSnippetListsByTaskKey: params.searchSnippetListsByTaskKey,
    total: params.total,
    hasMore: params.hasMore,
    fetchedAt: Date.now(),
    invalidationVersion: params.invalidationVersion ?? 0,
    stale: false,
    partial: params.partial ?? false,
    loadingShardKeys: params.loadingShardKeys ?? [],
    failedShardKeys: params.failedShardKeys ?? [],
    descriptor: params.descriptor,
  };
}

function matchesTaskMembership(
  descriptor: TaskListCacheDescriptor,
  membership: TaskListMembershipState,
): boolean {
  const kind = descriptor.kind === "workspace" ? "timeline" : descriptor.kind;
  return matchesTaskListMembershipKind(membership, kind);
}

function matchesTaskSearch(descriptor: TaskListCacheDescriptor, task: ZCodeTaskMeta): boolean {
  if (!descriptor.search) {
    return true;
  }

  return task.title.toLocaleLowerCase().includes(descriptor.search);
}

function matchesTaskDescriptor(
  descriptor: TaskListCacheDescriptor,
  task: ZCodeTaskMeta,
  membership: TaskListMembershipState,
): boolean {
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  if (!descriptor.workspaceKeys.includes(workspaceKey)) {
    return false;
  }

  return matchesTaskMembership(descriptor, membership) && matchesTaskSearch(descriptor, task);
}

function sortTaskKeysByDescriptor(params: {
  taskKeys: TaskEntityKey[];
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): TaskEntityKey[] {
  const uniqueTaskKeys = [...new Set(params.taskKeys)];
  return uniqueTaskKeys.sort((leftKey, rightKey) => {
    const leftTask = params.taskMetaByEntityKey[leftKey];
    const rightTask = params.taskMetaByEntityKey[rightKey];
    if (!leftTask && !rightTask) {
      return leftKey.localeCompare(rightKey);
    }
    if (!leftTask) {
      return 1;
    }
    if (!rightTask) {
      return -1;
    }
    return compareZCodeTaskListItems(leftTask, rightTask, params.descriptor.sortBy);
  });
}

// Items produced by republish (membership refresh, sessions-index frame) are all new object references.
// Even if the contents did not change, replacing the references would refresh taskMetaByEntityKey and derived items memo for the whole list,
// causing every list row to rerender unnecessarily. Compare fields and retain the old reference when equivalent.
// Compare nested fields (lastError/target, etc.) using JSON; task metadata objects are small enough for this cost.
function areCachedTaskListItemsEquivalent(
  left: CachedTaskListItem,
  right: CachedTaskListItem,
): boolean {
  if (left === right) {
    return true;
  }
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) {
    return false;
  }
  for (const key of leftKeys) {
    const leftValue = leftRecord[key];
    const rightValue = rightRecord[key];
    if (leftValue === rightValue) {
      continue;
    }
    if (
      typeof leftValue === "object" &&
      leftValue !== null &&
      typeof rightValue === "object" &&
      rightValue !== null
    ) {
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

function mergeIncomingTaskListItem(params: {
  item: CachedTaskListItem;
  existingItem: CachedTaskListItem | undefined;
  descriptor: TaskListCacheDescriptor;
  hasUnreadOverlay: boolean;
  unreadAtOverlay: number | null | undefined;
}): CachedTaskListItem {
  const incomingActivity = getTaskListRowActivity(params.item);
  const existingActivity = params.existingItem ? getTaskListRowActivity(params.existingItem) : null;
  // Search results come from tasks-index, but the entity cache may already contain sessions-index activity.
  // Preserve that sidecar when merging; otherwise running/waiting-for-confirmation state disappears as soon as the user types a search term.
  const incomingWithActivity =
    params.descriptor.search && params.existingItem && existingActivity && !incomingActivity
      ? (mergeTaskListMembershipFields(params.existingItem, params.item) as CachedTaskListItem)
      : params.item;
  const keepExistingNonPlaceholderTitle =
    params.existingItem &&
    incomingActivity &&
    (params.item.title.trim().length === 0 ||
      params.item.title.trim().toLocaleLowerCase() === "new session") &&
    params.existingItem.title.trim().length > 0 &&
    params.existingItem.title.trim().toLocaleLowerCase() !== "new session";
  // For non-search lists, incoming items combine sessions-index activity with the latest membership join.
  // Do not choose a whole-meta winner by tasks-index updatedAt; a rename/unread response could overwrite live
  // phase/lastActivityAt. Preserve only the initial title and non-activity display fields until sessions-index catches up.
  const mergedItem = params.descriptor.search
    ? incomingWithActivity
    : ({
        ...incomingWithActivity,
        ...(keepExistingNonPlaceholderTitle ? { title: params.existingItem?.title } : {}),
        changeSummary: incomingWithActivity.changeSummary ?? params.existingItem?.changeSummary,
        model: incomingWithActivity.model ?? params.existingItem?.model,
        provider: incomingWithActivity.provider ?? params.existingItem?.provider,
      } as CachedTaskListItem);
  const itemWithUnreadOverlay = params.hasUnreadOverlay
    ? ({
        ...mergedItem,
        unreadAt: params.unreadAtOverlay ?? undefined,
      } as CachedTaskListItem)
    : mergedItem;
  const nextItem =
    params.descriptor.search || !params.existingItem?.searchSnippet
      ? itemWithUnreadOverlay
      : {
          ...itemWithUnreadOverlay,
          searchSnippet: params.existingItem.searchSnippet,
          searchSnippets: params.existingItem.searchSnippets,
        };
  // Preserve references: when the merged result equals the current value, reuse the old object so downstream memoization/shallow comparisons can short-circuit.
  return params.existingItem && areCachedTaskListItemsEquivalent(nextItem, params.existingItem)
    ? params.existingItem
    : nextItem;
}

// If republished content is equivalent to the current cache, skip the entire setState,
// avoiding needless reference changes to resultsByQueryKey/taskMetaByEntityKey and rerenders of the whole list.
// fetchedAt/stale are excluded from comparison (retaining their old values is safe and only makes the preserve window more conservative).
function isQueryResultEquivalent(params: {
  previousResult: CachedTaskListResult | undefined;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial: boolean;
  loadingShardKeys: string[];
  failedShardKeys: string[];
}): boolean {
  const previous = params.previousResult;
  if (!previous || previous.stale) {
    return false;
  }
  if (
    previous.total !== params.total ||
    previous.hasMore !== params.hasMore ||
    previous.partial !== params.partial
  ) {
    return false;
  }
  if (
    previous.taskKeys.length !== params.taskKeys.length ||
    previous.taskKeys.some((taskKey, index) => taskKey !== params.taskKeys[index])
  ) {
    return false;
  }
  const sameStringArray = (left: string[], right: string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  if (
    !sameStringArray(previous.unreadTaskKeys ?? [], params.unreadTaskKeys ?? []) ||
    !sameStringArray(previous.loadingShardKeys, params.loadingShardKeys) ||
    !sameStringArray(previous.failedShardKeys, params.failedShardKeys)
  ) {
    return false;
  }
  return (
    JSON.stringify(previous.searchSnippetsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetsByTaskKey ?? null) &&
    JSON.stringify(previous.searchSnippetListsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetListsByTaskKey ?? null)
  );
}

function preserveFreshLocalTaskKeys(params: {
  incomingTaskKeys: TaskEntityKey[];
  previousResult: CachedTaskListResult | undefined;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): { taskKeys: TaskEntityKey[]; preservedCount: number } {
  if (!params.previousResult || params.descriptor.search) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const previousResult = params.previousResult;
  const incomingTaskKeySet = new Set(params.incomingTaskKeys);
  const preservedTaskKeys = previousResult.taskKeys.filter((taskKey) => {
    if (incomingTaskKeySet.has(taskKey)) {
      return false;
    }
    const task = params.taskMetaByEntityKey[taskKey];
    return Boolean(task && task.updatedAt > previousResult.fetchedAt);
  });
  if (preservedTaskKeys.length === 0) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const sortedTaskKeys = sortTaskKeysByDescriptor({
    // A SQLite list refresh may arrive after the optimistic insertion of a newly created task.
    // Temporarily preserve only keys locally updated after the previous list snapshot, so an older refresh does not remove the new task from the sidebar.
    taskKeys: [...params.incomingTaskKeys, ...preservedTaskKeys],
    taskMetaByEntityKey: params.taskMetaByEntityKey,
    descriptor: params.descriptor,
  });
  const visibleTaskKeys =
    params.descriptor.visibleLimit === null
      ? sortedTaskKeys
      : sortedTaskKeys.slice(0, params.descriptor.visibleLimit);
  return {
    taskKeys: visibleTaskKeys,
    preservedCount: preservedTaskKeys.length,
  };
}

export const useTaskQueryCacheStore = create<TaskQueryCacheState>()((set) => ({
  resultsByQueryKey: {},
  taskMetaByEntityKey: {},
  taskUnreadOverlayByEntityKey: {},
  setQueryResult: ({
    queryKey,
    descriptor,
    items,
    total,
    hasMore,
    unreadTaskKeys,
    partial,
    loadingShardKeys,
    failedShardKeys,
  }) =>
    set((state) => {
      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      let taskMetaChanged = false;
      let taskUnreadOverlayChanged = false;
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
      const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
      const incomingTaskKeys = items.map((item) => {
        const entityKey = buildTaskEntityKey(item);
        if (item.searchSnippet) {
          searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
        }
        if (item.searchSnippets?.length) {
          searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
        }
        const existingItem = nextTaskMetaByEntityKey[entityKey];
        const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
          state.taskUnreadOverlayByEntityKey,
          entityKey,
        );
        const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
        const mergedItem = mergeIncomingTaskListItem({
          item,
          existingItem,
          descriptor,
          hasUnreadOverlay,
          unreadAtOverlay,
        });
        if (
          hasUnreadOverlay &&
          (unreadAtOverlay === null
            ? typeof item.unreadAt !== "number"
            : item.unreadAt === unreadAtOverlay)
        ) {
          // RPC success does not mean every in-flight membership query has refreshed.
          // Release the overlay only after a query actually publishes the same field value; older responses must not overwrite the new state before or after that.
          delete nextTaskUnreadOverlayByEntityKey[entityKey];
          taskUnreadOverlayChanged = true;
        }
        if (mergedItem !== existingItem) {
          taskMetaChanged = true;
          nextTaskMetaByEntityKey[entityKey] = mergedItem;
        }
        return entityKey;
      });
      const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
        incomingTaskKeys,
        previousResult: state.resultsByQueryKey[queryKey],
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
        descriptor,
      });

      const resultParams = {
        descriptor,
        taskKeys,
        unreadTaskKeys,
        searchSnippetsByTaskKey:
          Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
        searchSnippetListsByTaskKey:
          Object.keys(searchSnippetListsByTaskKey).length > 0
            ? searchSnippetListsByTaskKey
            : undefined,
        total:
          preservedCount > 0
            ? Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length)
            : total,
        hasMore:
          hasMore ||
          (preservedCount > 0 &&
            Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length) >
              taskKeys.length),
        partial,
        loadingShardKeys,
        failedShardKeys,
        invalidationVersion: state.resultsByQueryKey[queryKey]?.invalidationVersion ?? 0,
      };
      // If contents are equivalent to the current cache, skip setState so republishing does not rerender the whole list unnecessarily.
      if (
        !taskMetaChanged &&
        !taskUnreadOverlayChanged &&
        isQueryResultEquivalent({
          previousResult: state.resultsByQueryKey[queryKey],
          taskKeys,
          unreadTaskKeys: resultParams.unreadTaskKeys,
          searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
          searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
          total: resultParams.total,
          hasMore: resultParams.hasMore,
          partial: partial ?? false,
          loadingShardKeys: loadingShardKeys ?? [],
          failedShardKeys: failedShardKeys ?? [],
        })
      ) {
        return state;
      }

      return {
        resultsByQueryKey: {
          ...state.resultsByQueryKey,
          [queryKey]: buildCachedTaskListResult(resultParams),
        },
        taskMetaByEntityKey: taskMetaChanged ? nextTaskMetaByEntityKey : state.taskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
          ? nextTaskUnreadOverlayByEntityKey
          : state.taskUnreadOverlayByEntityKey,
      };
    }),
  setQueryResults: (entries) =>
    set((state) => {
      if (entries.length === 0) {
        return state;
      }

      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      let taskMetaChanged = false;
      let taskUnreadOverlayChanged = false;
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      let resultsChanged = false;

      for (const entry of entries) {
        const previousResult = state.resultsByQueryKey[entry.queryKey];
        const currentInvalidationVersion = previousResult?.invalidationVersion ?? 0;
        if (
          entry.expectedInvalidationVersion !== undefined &&
          entry.expectedInvalidationVersion !== currentInvalidationVersion
        ) {
          // sessions-index activity and tasks-index membership are joined asynchronously.
          // If invalidated again while a request is in flight, the old result must not update the entity, release the unread overlay, or mark the query fresh;
          // the hook will recompute using the latest activity/membership revision.
          continue;
        }
        const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
        const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
        const incomingTaskKeys = entry.items.map((item) => {
          const entityKey = buildTaskEntityKey(item);
          if (item.searchSnippet) {
            searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
          }
          if (item.searchSnippets?.length) {
            searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
          }
          const existingItem = nextTaskMetaByEntityKey[entityKey];
          const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
            state.taskUnreadOverlayByEntityKey,
            entityKey,
          );
          const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
          const mergedItem = mergeIncomingTaskListItem({
            item,
            existingItem,
            descriptor: entry.descriptor,
            hasUnreadOverlay,
            unreadAtOverlay,
          });
          if (
            hasUnreadOverlay &&
            (unreadAtOverlay === null
              ? typeof item.unreadAt !== "number"
              : item.unreadAt === unreadAtOverlay)
          ) {
            delete nextTaskUnreadOverlayByEntityKey[entityKey];
            taskUnreadOverlayChanged = true;
          }
          if (mergedItem !== existingItem) {
            taskMetaChanged = true;
            nextTaskMetaByEntityKey[entityKey] = mergedItem;
          }
          return entityKey;
        });
        const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
          incomingTaskKeys,
          previousResult,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor: entry.descriptor,
        });

        const resultParams = {
          descriptor: entry.descriptor,
          taskKeys,
          unreadTaskKeys: entry.unreadTaskKeys,
          searchSnippetsByTaskKey:
            Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
          searchSnippetListsByTaskKey:
            Object.keys(searchSnippetListsByTaskKey).length > 0
              ? searchSnippetListsByTaskKey
              : undefined,
          total:
            preservedCount > 0
              ? Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length)
              : entry.total,
          hasMore:
            entry.hasMore ||
            (preservedCount > 0 &&
              Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length) > taskKeys.length),
          partial: entry.partial,
          loadingShardKeys: entry.loadingShardKeys,
          failedShardKeys: entry.failedShardKeys,
          invalidationVersion: currentInvalidationVersion,
        };
        // Same equivalence short-circuit as setQueryResult for a single item; retain old result references for unchanged entries.
        if (
          isQueryResultEquivalent({
            previousResult,
            taskKeys,
            unreadTaskKeys: resultParams.unreadTaskKeys,
            searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
            searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
            total: resultParams.total,
            hasMore: resultParams.hasMore,
            partial: entry.partial ?? false,
            loadingShardKeys: entry.loadingShardKeys ?? [],
            failedShardKeys: entry.failedShardKeys ?? [],
          })
        ) {
          continue;
        }
        resultsChanged = true;
        nextResultsByQueryKey[entry.queryKey] = buildCachedTaskListResult(resultParams);
      }

      if (!taskMetaChanged && !resultsChanged && !taskUnreadOverlayChanged) {
        return state;
      }

      return {
        resultsByQueryKey: resultsChanged ? nextResultsByQueryKey : state.resultsByQueryKey,
        taskMetaByEntityKey: taskMetaChanged ? nextTaskMetaByEntityKey : state.taskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
          ? nextTaskUnreadOverlayByEntityKey
          : state.taskUnreadOverlayByEntityKey,
      };
    }),
  upsertTaskMeta: (task) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // During restart recovery, a raw session snapshot may update the query cache before the list refresh.
      // Merge it with indexed metadata here so a snapshot without titleOverridden does not overwrite a user-renamed title.
      const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
      const nextTask = getTaskListRowActivity(task)
        ? mergeTaskListMembershipFields(task, mergedTask)
        : existingTask
          ? mergeTaskListMembershipFields(existingTask, mergedTask)
          : mergedTask;
      return {
        ...state,
        taskMetaByEntityKey: {
          ...state.taskMetaByEntityKey,
          [entityKey]: nextTask,
        },
      };
    }),
  updateTaskMetaPreservingMembership: (task) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // workspace_task_list_changed may include a projected title from the runtime snapshot.
      // Preserve the existing manual-rename source of truth in the query cache; use the new metadata only for runtime fields such as status/updatedAt.
      const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
      // updatedAt from tasks-index in workspace_task_list_changed
      // is a metadata update, not real session activity. When a sessions-index sidecar exists,
      // merge only membership/metadata fields; otherwise a rename/unread update could incorrectly move the task to the top.
      const nextTask = existingTask
        ? mergeTaskListMembershipFields(existingTask, mergedTask)
        : mergedTask;
      const nextTaskMetaByEntityKey = {
        ...state.taskMetaByEntityKey,
        [entityKey]: nextTask,
      };
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };

      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (!result.taskKeys.includes(entityKey)) {
          continue;
        }

        // A metadata delta from workspace_task_list_changed indicates a task content/status change,
        // not a change in pinned/archived membership. Reorder only lists that already contain the task; do not move it out of pinned.
        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys: sortTaskKeysByDescriptor({
            taskKeys: result.taskKeys,
            taskMetaByEntityKey: nextTaskMetaByEntityKey,
            descriptor: result.descriptor,
          }),
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  applyTaskMutation: ({ previousTask, nextTask, previousState, nextState }) =>
    set((state) => {
      const previousEntityKey = buildTaskEntityKey(previousTask);
      const nextEntityKey = buildTaskEntityKey(nextTask);
      const existingTask =
        state.taskMetaByEntityKey[nextEntityKey] ?? state.taskMetaByEntityKey[previousEntityKey];
      const mergedNextTask = existingTask
        ? mergeTaskListMembershipFields(existingTask, nextTask)
        : nextTask;
      const nextTaskMetaByEntityKey = {
        ...state.taskMetaByEntityKey,
        [nextEntityKey]: mergedNextTask,
      };
      if (previousEntityKey !== nextEntityKey) {
        delete nextTaskMetaByEntityKey[previousEntityKey];
      }

      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (result.descriptor.search) {
          // The server's SQLite searchable_text determines body-search matches, while the frontend cache has only task metadata/title.
          // It cannot use title-only rules to decide membership in incremental results; that would make locally cached conversations with body matches appear not to match.
          nextResultsByQueryKey[queryKey] = {
            ...result,
            invalidationVersion: result.invalidationVersion + 1,
            stale: true,
          };
          continue;
        }

        const previousIncluded = matchesTaskDescriptor(
          result.descriptor,
          previousTask,
          previousState,
        );
        const nextIncluded = matchesTaskDescriptor(result.descriptor, nextTask, nextState);
        const wasVisible =
          result.taskKeys.includes(previousEntityKey) || result.taskKeys.includes(nextEntityKey);

        if (!previousIncluded && !nextIncluded && !wasVisible) {
          continue;
        }

        const taskKeysWithoutTarget = result.taskKeys.filter(
          (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
        );
        const unreadTaskKeysWithoutTarget = (result.unreadTaskKeys ?? []).filter(
          (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
        );
        const visibleCandidateKeys = nextIncluded
          ? [...taskKeysWithoutTarget, nextEntityKey]
          : taskKeysWithoutTarget;
        const nextUnreadTaskKeys =
          nextIncluded && typeof mergedNextTask.unreadAt === "number"
            ? [...unreadTaskKeysWithoutTarget, nextEntityKey]
            : unreadTaskKeysWithoutTarget;
        const sortedTaskKeys = sortTaskKeysByDescriptor({
          taskKeys: visibleCandidateKeys,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor: result.descriptor,
        });
        const visibleTaskKeys =
          result.descriptor.visibleLimit === null
            ? sortedTaskKeys
            : sortedTaskKeys.slice(0, result.descriptor.visibleLimit);
        const nextTotal = Math.max(
          0,
          result.total + Number(nextIncluded) - Number(previousIncluded),
        );
        const shouldBackgroundRefresh =
          result.descriptor.visibleLimit !== null &&
          previousIncluded !== nextIncluded &&
          nextTotal > visibleTaskKeys.length;

        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys: visibleTaskKeys,
          ...(result.unreadTaskKeys ? { unreadTaskKeys: nextUnreadTaskKeys } : {}),
          total: nextTotal,
          hasMore: nextTotal > visibleTaskKeys.length,
          stale: result.stale || shouldBackgroundRefresh,
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  setTaskUnreadOverlay: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      return {
        taskUnreadOverlayByEntityKey: {
          ...state.taskUnreadOverlayByEntityKey,
          [entityKey]: unreadAt ?? null,
        },
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  reconcileTaskUnread: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // The server response only confirms that the mutation was persisted; an older membership request may still return later.
      // Update the overlay to the server value until setQueryResult observes that same value and releases it automatically.
      return {
        taskUnreadOverlayByEntityKey: {
          ...state.taskUnreadOverlayByEntityKey,
          [entityKey]: unreadAt ?? null,
        },
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  rollbackTaskUnread: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      const nextOverlays = { ...state.taskUnreadOverlayByEntityKey };
      delete nextOverlays[entityKey];
      return {
        taskUnreadOverlayByEntityKey: nextOverlays,
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  removeTask: (task) => {
    let removedFromVisibleCache = false;
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      if (!state.taskMetaByEntityKey[entityKey]) {
        const hasCachedResult = Object.values(state.resultsByQueryKey).some((result) =>
          result.taskKeys.includes(entityKey),
        );
        if (!hasCachedResult) {
          return state;
        }
      }

      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      delete nextTaskMetaByEntityKey[entityKey];
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      delete nextTaskUnreadOverlayByEntityKey[entityKey];

      const nextResultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult> = {};
      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (!result.taskKeys.includes(entityKey)) {
          nextResultsByQueryKey[queryKey] = result;
          continue;
        }

        const taskKeys = result.taskKeys.filter((taskKey) => taskKey !== entityKey);
        removedFromVisibleCache = true;
        // Task deletion used to require a full-table refresh; here, decrement total only for lists where the task is actually present in visible cache.
        // Do not guess membership for hidden items outside the collapsed visible area, which could incorrectly decrement another list's count.
        const total = Math.max(0, result.total - 1);
        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys,
          total,
          hasMore: total > taskKeys.length,
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: nextTaskUnreadOverlayByEntityKey,
      };
    });
    return removedFromVisibleCache;
  },
  markWorkspaceKeysStale: (workspaceKeys) =>
    set((state) => {
      if (workspaceKeys.length === 0) {
        return state;
      }

      const staleWorkspaceKeySet = new Set(workspaceKeys);
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      let changed = false;

      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (
          !result.descriptor.workspaceKeys.some((workspaceKey) =>
            staleWorkspaceKeySet.has(workspaceKey),
          )
        ) {
          continue;
        }

        // When deleting a collapsed/page-hidden task, taskId alone is not enough to safely decrement total.
        // Keep the current visible lists and mark only matching workspaces dirty so the hook's next effect really refreshes counts from the source.
        nextResultsByQueryKey[queryKey] = {
          ...result,
          invalidationVersion: result.invalidationVersion + 1,
          stale: true,
        };
        changed = true;
      }

      if (!changed) {
        return state;
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
      };
    }),
  invalidateWorkspaceKeys: (workspaceKeys) =>
    set((state) => {
      if (workspaceKeys.length === 0) {
        return state;
      }

      const invalidatedWorkspaceKeySet = new Set(workspaceKeys);
      const nextResultsByQueryKey = Object.fromEntries(
        Object.entries(state.resultsByQueryKey).filter(([queryKey]) => {
          return ![...invalidatedWorkspaceKeySet].some(
            (workspaceKey) =>
              queryKey.includes(`workspaces=${workspaceKey}`) ||
              queryKey.includes(`|${workspaceKey}`),
          );
        }),
      );
      const nextTaskMetaByEntityKey = Object.fromEntries(
        Object.entries(state.taskMetaByEntityKey).filter(([entityKey]) => {
          const workspaceKey = entityKey.split("::")[0] ?? "";
          return !invalidatedWorkspaceKeySet.has(workspaceKey);
        }),
      );

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  clearAll: () =>
    set(() => ({
      // clearAll is a Zustand action and must write back to the store through set.
      // Previously it returned an object only, leaving old task metadata behind when clearing the query cache in tests or development.
      resultsByQueryKey: {},
      taskMetaByEntityKey: {},
      taskUnreadOverlayByEntityKey: {},
    })),
}));

export function selectTaskListCacheResult(queryKey: TaskListCacheKey) {
  return (state: TaskQueryCacheState): CachedTaskListResult | null => {
    return state.resultsByQueryKey[queryKey] ?? null;
  };
}

export function invalidateTaskQueryCacheByScopes(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().invalidateWorkspaceKeys(workspaceKeys);
}

export function markTaskQueryCacheScopesStale(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().markWorkspaceKeysStale(workspaceKeys);
}

export function upsertTaskQueryCacheTaskMeta(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().upsertTaskMeta(task);
}

export function updateTaskQueryCacheTaskMetaPreservingMembership(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().updateTaskMetaPreservingMembership(task);
}

export function applyTaskQueryCacheMutation(params: {
  previousTask: ZCodeTaskMeta;
  nextTask: ZCodeTaskMeta;
  previousState: TaskListMembershipState;
  nextState: TaskListMembershipState;
}): void {
  useTaskQueryCacheStore.getState().applyTaskMutation(params);
  if (!params.previousState.archived && params.nextState.archived) {
    notifyTaskLifecycle({
      type: "archived",
      taskId: params.nextTask.taskId,
      workspaceKey: buildTaskWorkspaceKey(
        params.nextTask.workspacePath,
        params.nextTask.workspaceIdentity,
      ),
    });
  }
}

export function setTaskQueryCacheUnreadOverlay(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().setTaskUnreadOverlay(task, unreadAt);
}

export function reconcileTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().reconcileTaskUnread(task, unreadAt);
}

export function rollbackTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().rollbackTaskUnread(task, unreadAt);
}

export function removeTaskFromTaskQueryCaches(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): boolean {
  const removed = useTaskQueryCacheStore.getState().removeTask(task);
  notifyTaskLifecycle({
    type: "deleted",
    taskId: task.taskId,
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
  });
  return removed;
}

// In-memory diagnostic counter: versioned queryKeys only grow, so log them first.
uiMemoryDiagnosticsRegistry.register("taskQueryCache", () => {
  const state = useTaskQueryCacheStore.getState();
  return {
    queryKeys: Object.keys(state.resultsByQueryKey).length,
    taskMetas: Object.keys(state.taskMetaByEntityKey).length,
  };
});
