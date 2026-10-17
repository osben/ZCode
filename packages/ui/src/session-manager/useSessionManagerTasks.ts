import { useMemo } from "react";
import type { WindowHostControllerTaskListItem } from "@zcode/services";
import { useRecentProjects } from "@/hooks/useSettingService.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { logger } from "@/logger.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import { toast } from "@/components/ui/toast.js";
import {
  buildSessionManagerRowKey,
  buildSessionManagerRows,
  type SessionManagerRow,
} from "./sessionManagerModel.js";
import type { SessionManagerScope, SessionManagerStatusFilter } from "./sessionManagerTypes.js";

export interface SessionManagerUniverseTab {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/**
 * Scoped mode queries exactly the entry workspace. Unscoped mode queries the v1 universe:
 * open workspace tabs plus local recent projects (spec §2) — no enumeration of "all workspaces"
 * exists, and this union needs zero new state.
 */
export function useSessionManagerUniverse(scope: SessionManagerScope | undefined) {
  const tabs = useTabStore((state) => state.tabs);
  const { recentProjects } = useRecentProjects();
  return useMemo<SessionManagerUniverseTab[]>(() => {
    if (scope) {
      return [
        {
          workspacePath: scope.workspacePath,
          ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        },
      ];
    }
    const byKey = new Map<string, SessionManagerUniverseTab>();
    for (const tab of tabs) {
      if (!isWorkspaceTab(tab)) {
        continue;
      }
      byKey.set(buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity), {
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
      });
    }
    for (const path of recentProjects) {
      const key = buildTaskWorkspaceKey(path, undefined);
      if (!byKey.has(key)) {
        byKey.set(key, { workspacePath: path });
      }
    }
    return Array.from(byKey.values());
  }, [recentProjects, scope, tabs]);
}

export interface SessionManagerTaskLists {
  rows: SessionManagerRow[];
  loading: boolean;
  syncingRemoteWorkspaces: boolean;
}

/** Read model over the shared sessions-index projection; the universe-bound kind queries reuse useGlobalTaskList as-is. */
export function useSessionManagerTaskLists(params: {
  universe: readonly SessionManagerUniverseTab[];
  status: SessionManagerStatusFilter;
  sortBy: "created" | "updated";
  search: string;
}): SessionManagerTaskLists {
  const { universe, status, sortBy, search } = params;
  // Idle hooks receive an empty universe: useGlobalTaskList returns empty without issuing a query.
  const activeUniverse = status !== "archived" ? universe : [];
  const archivedUniverse = status !== "active" ? universe : [];

  const activeList = useGlobalTaskList({
    kind: "active",
    workspaceTabs: activeUniverse,
    sortBy,
    searchQuery: search,
    expanded: true,
    collapsedLimit: 0,
  });
  const archivedList = useGlobalTaskList({
    kind: "archived",
    workspaceTabs: archivedUniverse,
    sortBy,
    searchQuery: search,
    expanded: true,
    collapsedLimit: 0,
  });
  // The pinned kind is the per-row membership truth for the star column and the Pinned filter;
  // it is queried without search so the set covers every visible row regardless of filtering.
  const pinnedList = useGlobalTaskList({
    kind: "pinned",
    workspaceTabs: status === "archived" ? [] : universe,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 0,
  });

  const pinnedKeys = useMemo(
    () =>
      new Set(
        pinnedList.items.map((task: WindowHostControllerTaskListItem) =>
          buildSessionManagerRowKey(task.workspacePath, task.taskId, task.workspaceIdentity),
        ),
      ),
    [pinnedList.items],
  );

  const rows = useMemo(
    () =>
      buildSessionManagerRows({
        activeItems: activeList.items,
        archivedItems: archivedList.items,
        pinnedKeys,
      }),
    [activeList.items, archivedList.items, pinnedKeys],
  );

  return {
    rows,
    loading: activeList.loading || archivedList.loading,
    syncingRemoteWorkspaces:
      activeList.syncingRemoteWorkspaces || archivedList.syncingRemoteWorkspaces,
  };
}

export interface SessionManagerRowActionResult {
  succeeded: number;
  failed: number;
}

/** Mutations through per-workspace zcodeTaskService (the sidebar-section lane), followed by the shared cache-sync helpers. */
export function useSessionManagerRowActions(
  universe: readonly SessionManagerUniverseTab[],
  formatMessage: (id: string, values?: Record<string, string | number>) => string,
) {
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const resolverState = useMemo(
    () => ({ sessionsById, sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const lookup = useMemo(
    () => buildWorkspaceServiceLookup([...universe], baseServices, resolverState),
    [baseServices, resolverState, universe],
  );

  const resolveRowServices = (row: SessionManagerRow) =>
    lookup.get(row.workspaceKey)?.services.zcodeTaskService ?? null;

  const reportError = (error: unknown, action: string, row: SessionManagerRow) => {
    logger.error(`[SessionManager] ${action} failed`, {
      taskId: row.task.taskId,
      workspacePath: row.task.workspacePath,
      workspaceIdentity: row.task.workspaceIdentity,
      message: error instanceof Error ? error.message : String(error),
    });
  };

  return useMemo(
    () => ({
      canMutate: (row: SessionManagerRow) => !row.offline && Boolean(resolveRowServices(row)),

      async setPinned(row: SessionManagerRow, pinned: boolean) {
        const service = resolveRowServices(row);
        if (!service) {
          return;
        }
        const previousTask = row.task;
        try {
          const meta = await service.setTaskPinned({
            taskId: row.task.taskId,
            workspacePath: row.task.workspacePath,
            ...(row.task.workspaceIdentity
              ? { workspaceIdentity: row.task.workspaceIdentity }
              : {}),
            pinned,
          });
          applyTaskQueryCacheMutation({
            previousTask,
            nextTask: meta,
            previousState: { pinned: !pinned, archived: false },
            nextState: { pinned, archived: false },
          });
        } catch (error) {
          reportError(error, "pin", row);
          toast(formatMessage("sessionManager.mutationFailed"));
        }
      },

      async setArchived(row: SessionManagerRow, archived: boolean) {
        const service = resolveRowServices(row);
        if (!service) {
          return;
        }
        const previousTask = row.task;
        const base = {
          taskId: row.task.taskId,
          workspacePath: row.task.workspacePath,
          ...(row.task.workspaceIdentity ? { workspaceIdentity: row.task.workspaceIdentity } : {}),
        };
        try {
          const meta = archived
            ? await service.archiveTask(base)
            : await service.unarchiveTask(base);
          applyTaskQueryCacheMutation({
            previousTask,
            nextTask: meta,
            previousState: { pinned: row.pinned && !archived, archived: !archived },
            nextState: { pinned: false, archived },
          });
        } catch (error) {
          reportError(error, "archive", row);
          toast(formatMessage("sessionManager.mutationFailed"));
        }
      },

      async rename(row: SessionManagerRow, title: string): Promise<boolean> {
        const service = resolveRowServices(row);
        if (!service) {
          return false;
        }
        const previousTask = row.task;
        try {
          const meta = await service.renameTask({
            taskId: row.task.taskId,
            workspacePath: row.task.workspacePath,
            ...(row.task.workspaceIdentity
              ? { workspaceIdentity: row.task.workspaceIdentity }
              : {}),
            title,
          });
          useZCodeSessionStore
            .getState()
            .upsertOptimisticTaskListItem(row.task.workspacePath, meta, row.task.workspaceIdentity);
          applyTaskQueryCacheMutation({
            previousTask,
            nextTask: meta,
            previousState: { pinned: row.pinned, archived: row.archived },
            nextState: { pinned: row.pinned, archived: row.archived },
          });
          return true;
        } catch (error) {
          reportError(error, "rename", row);
          toast(formatMessage("sessionManager.mutationFailed"));
          return false;
        }
      },

      /**
       * Delete respects the tombstone split (spec §7–8): non-archived rows use deleteTask
       * (index tombstone, files retained), archived rows use the per-workspace batch whose
       * still-archived guard skips rows restored elsewhere. Partial failures are tolerated
       * and reported by count; the list refreshes through the registry either way.
       */
      async deleteRows(rows: readonly SessionManagerRow[]): Promise<SessionManagerRowActionResult> {
        let succeeded = 0;
        let failed = 0;
        const archivedByWorkspace = new Map<
          string,
          {
            workspacePath: string;
            workspaceIdentity?: string;
            taskIds: string[];
          }
        >();
        for (const row of rows) {
          if (row.archived) {
            const key = row.workspaceKey;
            const bucket = archivedByWorkspace.get(key) ?? {
              workspacePath: row.task.workspacePath,
              ...(row.task.workspaceIdentity
                ? { workspaceIdentity: row.task.workspaceIdentity }
                : {}),
              taskIds: [],
            };
            bucket.taskIds.push(row.task.taskId);
            archivedByWorkspace.set(key, bucket);
            continue;
          }
          const service = resolveRowServices(row);
          if (!service) {
            failed += 1;
            continue;
          }
          try {
            await service.deleteTask({
              taskId: row.task.taskId,
              workspacePath: row.task.workspacePath,
              ...(row.task.workspaceIdentity
                ? { workspaceIdentity: row.task.workspaceIdentity }
                : {}),
            });
            removeTaskFromTaskCaches({
              workspacePath: row.task.workspacePath,
              workspaceIdentity: row.task.workspaceIdentity,
              taskId: row.task.taskId,
            });
            succeeded += 1;
          } catch (error) {
            reportError(error, "delete", row);
            failed += 1;
          }
        }
        for (const bucket of archivedByWorkspace.values()) {
          const representative = rows.find(
            (row) =>
              row.workspaceKey ===
              buildTaskWorkspaceKey(bucket.workspacePath, bucket.workspaceIdentity),
          );
          const service = representative ? resolveRowServices(representative) : null;
          if (!service) {
            failed += bucket.taskIds.length;
            continue;
          }
          try {
            const result = await service.deleteArchivedTasks({
              workspacePath: bucket.workspacePath,
              ...(bucket.workspaceIdentity ? { workspaceIdentity: bucket.workspaceIdentity } : {}),
              taskIds: bucket.taskIds,
            });
            // skippedTaskIds = restored elsewhere mid-dialog: neither deleted nor failed; those rows
            // reappear through the next active-kind query and are simply not removed here.
            succeeded += result.deletedTaskIds.length;
            failed += result.failedTaskIds.length;
            for (const taskId of result.deletedTaskIds) {
              removeTaskFromTaskCaches({
                workspacePath: bucket.workspacePath,
                workspaceIdentity: bucket.workspaceIdentity,
                taskId,
              });
            }
          } catch (error) {
            logger.error("[SessionManager] archived batch delete failed", {
              workspacePath: bucket.workspacePath,
              workspaceIdentity: bucket.workspaceIdentity,
              message: error instanceof Error ? error.message : String(error),
            });
            failed += bucket.taskIds.length;
          }
        }
        if (failed > 0) {
          toast(
            formatMessage("sessionManager.delete.partialFailure", {
              failed: String(failed),
              succeeded: String(succeeded),
            }),
          );
        }
        return { succeeded, failed };
      },
    }),
    // lookup changes identity when services or resolver state change; formatMessage is stable per intl instance.
    [formatMessage, lookup],
  );
}
