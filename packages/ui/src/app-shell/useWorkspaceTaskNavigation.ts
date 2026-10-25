/* eslint-disable max-lines -- Workspace tasks, automations, and the plugin marketplace share browser-style history; handling them together keeps back/forward targets consistent. */
import { useCallback } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  canGoBack as navCanGoBack,
  canGoForward as navCanGoForward,
  isAutomationsNavEntry,
  isPluginStoreNavEntry,
  type AutomationsNavigationTab,
  type WorkspaceNavEntry,
} from "@/lib/taskNavigationHistory.js";
import { shouldBlockTaskSelectionDuringModelRestart } from "@/lib/taskSwitchGuard.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";

// Replay purges a task entry only when the project directory owner reports it as deleted.
// A query-cache or visible-list miss is not deletion: such a task stays navigable and handleSelectTask opens it.
const NO_KNOWN_DELETED_TASKS = (): boolean => false;

export interface AutomationsNavigationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  automationId?: string;
  automationTab?: AutomationsNavigationTab;
}

export function useWorkspaceTaskNavigation({
  intl,
  workspaceAbsPath,
  workspaceIdentity,
  activateTabByPath,
  onNavigateToTask,
  onNavigateToAutomations,
  onNavigateToPluginStore,
}: {
  intl: { formatMessage: (descriptor: { id: string }) => string };
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  onNavigateToTask?: () => void;
  onNavigateToAutomations?: (target: AutomationsNavigationTarget) => void;
  onNavigateToPluginStore?: (target: Omit<AutomationsNavigationTarget, "automationId">) => void;
}) {
  // Cross-workspace selection switches tabs synchronously, but ambient services captured by this React render may still belong to the old remote attachment.
  // A local target must start from the window's base attachment and be routed by the Host Controller; do not send a local path into the old remote scope.
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const setActiveTaskId = useZCodeSessionStore((s) => s.setActiveTaskId);
  const taskNavHistory = useZCodeSessionStore((s) => s.taskNavHistory);
  const taskNavPushAutomations = useZCodeSessionStore((s) => s.taskNavPushAutomations);
  const taskNavPushPluginStore = useZCodeSessionStore((s) => s.taskNavPushPluginStore);
  const taskNavGoBack = useZCodeSessionStore((s) => s.taskNavGoBack);
  // Read at command time through the owner; no tombstone copy lives in the session store.
  const isTaskKnownDeleted =
    useOptionalProjectDirectory()?.isTaskKnownDeleted ?? NO_KNOWN_DELETED_TASKS;
  const taskNavGoForward = useZCodeSessionStore((s) => s.taskNavGoForward);

  const handleSelectTask = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentityHint?: string,
      selectedRowUnreadAt?: number,
    ) => {
      const targetWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(targetWorkspacePath, targetWorkspaceIdentityHint);
      if (
        shouldBlockTaskSelectionDuringModelRestart(
          targetWorkspaceState.modelSwitchPending,
          targetWorkspaceState.modelSwitchStage,
        )
      ) {
        // When switching model providers triggers runtime reconstruction, the current provider-workspace task handle is briefly reclaimed.
        // Switching to another task at this point would start resumeTask and reconstruction concurrently, making a failed switch look like a failed task restore.
        // Intercept task switching here and allow it again after reconstruction, preventing the UI from entering a false notReady/error state.
        logger.info(
          `[App] 模型运行时重建中，忽略 task 切换 workspace=${targetWorkspacePath} taskId=${taskId} stage=${targetWorkspaceState.modelSwitchStage}`,
        );
        toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
        return;
      }

      // Do not use workspacePath alone to look up a session when clearing unread state for a remote workspace.
      // If multiple remote tabs in the same window share a path, the path map may select an old session,
      // causing "open this task" to mark another remote connection as read.
      // Activate the target tab first, then read the more precise remoteSessionId from the active tab.
      activateTabByPath(
        targetWorkspacePath,
        targetWorkspaceIdentityHint
          ? { workspaceIdentity: targetWorkspaceIdentityHint }
          : undefined,
      );
      const activeTab = tabStoreApi
        .getState()
        .tabs.find((tab) => tab.id === tabStoreApi.getState().activeTabId);
      const targetWorkspaceKey = buildTaskWorkspaceKey(
        targetWorkspacePath,
        targetWorkspaceIdentityHint,
      );
      const activeWorkspaceTabMatchesTarget = Boolean(
        activeTab &&
        isWorkspaceTab(activeTab) &&
        buildTaskWorkspaceKey(activeTab.workspacePath, activeTab.workspaceIdentity) ===
          targetWorkspaceKey,
      );
      const resolvedRemoteSessionId =
        activeTab && isWorkspaceTab(activeTab) && activeWorkspaceTabMatchesTarget
          ? activeTab.remoteSessionId
          : undefined;
      const targetWorkspaceIdentity =
        activeTab && isWorkspaceTab(activeTab) && activeWorkspaceTabMatchesTarget
          ? (activeTab.workspaceIdentity ?? targetWorkspaceIdentityHint)
          : targetWorkspaceIdentityHint;
      const targetTask = {
        taskId,
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
      };
      const taskEntityKey = buildTaskEntityKey(targetTask);
      const cachedTaskMeta = useTaskQueryCacheStore.getState().taskMetaByEntityKey[taskEntityKey];
      const previousUnreadAt = cachedTaskMeta?.unreadAt;
      // The task timeline receives rows directly from Window Controller, unlike project lists that write background-created tasks to query cache.
      // If the click transaction checks only the cache, a row with a visible unread dot may be incorrectly treated as read.
      // Prefer unreadAt from the clicked row—the snapshot the user actually saw—for compare-and-clear;
      // older entry points without a row snapshot continue to fall back to query cache for compatibility.
      const expectedUnreadAt =
        typeof selectedRowUnreadAt === "number" ? selectedRowUnreadAt : previousUnreadAt;
      const shouldClearUnread = typeof expectedUnreadAt === "number";
      const isRemoteWorkspace = Boolean(
        targetWorkspaceIdentity ||
        (activeTab &&
          isWorkspaceTab(activeTab) &&
          activeWorkspaceTabMatchesTarget &&
          (activeTab.remoteSessionId || activeTab.remoteTarget)),
      );

      if (shouldClearUnread) {
        // Unread state was previously cleared persistently only after resumeTask in useTaskRestore.
        // Clicking the current task again does not run restore, leaving unreadAt on disk and making the task appear unread after app restart.
        // Treat explicit task selection as a read entry point too, so selecting the same task repeatedly clears persisted unread state.
        // V4 task rows are rendered from query cache, so updating only the old Zustand unread map does not rerender the dot.
        // First add a field-level overlay for the exact entity key, then reconcile after the server response;
        // stale membership refreshes during that time must not restore the unread dot.
        setTaskQueryCacheUnreadOverlay(targetTask, undefined);
        const targetServices = resolvedRemoteSessionId
          ? (getRemoteWorkspaceSession(resolvedRemoteSessionId)?.services ?? null)
          : isRemoteWorkspace
            ? null
            : baseServices;
        if (!targetServices) {
          // If a remote workspace disconnects, do not fall back by matching workspacePath to
          // another remote session or local base services; that could clear unread state for a different workspace.
          rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
          logger.warn(
            `[App] 选择 task 时跳过未读持久化，远程 workspace 未连接 workspace=${targetWorkspacePath} taskId=${taskId}`,
          );
        } else {
          void targetServices.zcodeTaskService
            .setTaskUnread({
              ...targetTask,
              unread: false,
              expectedUnreadAt,
            })
            .then((meta) => {
              reconcileTaskQueryCacheUnread(targetTask, meta.unreadAt);
              bumpTaskListMembershipVersion();
            })
            .catch((error: unknown) => {
              rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
              markTaskQueryCacheScopesStale([targetTask]);
              bumpTaskListMembershipVersion();
              logger.warn(
                `[App] 选择 task 时清除未读状态失败 workspace=${targetWorkspacePath} taskId=${taskId}:`,
                error instanceof Error ? error.message : String(error),
              );
            });
        }
      }

      // slashCommands is a workspace-identity catalog, not a task projection.
      // If cleared while selecting an existing task, only the conversation projection is restored afterward,
      // so the workspace catalog read by Composer never gets repopulated. Keep the same identity bucket here;
      // workspace catalog hydration fills it independently when cold recovery is truly empty.
      setActiveTaskId(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      onNavigateToTask?.();
    },
    [activateTabByPath, intl, onNavigateToTask, baseServices, tabStoreApi, setActiveTaskId],
  );

  const handleOpenAutomations = useCallback(
    (automationId?: string, automationTab?: AutomationsNavigationTab) => {
      const normalizedAutomationId = automationId?.trim() || undefined;
      // Automations previously changed only the local view in WorkspaceShellLayout, bypassing
      // browser-style navigation history so the top back/forward controls could not revisit or restore the page. Add it as an official navigation target
      // scoped by workspace identity; history replay consumes the entry without pushing it again.
      taskNavPushAutomations(
        workspaceAbsPath,
        workspaceIdentity,
        normalizedAutomationId,
        automationTab,
      );
      onNavigateToAutomations?.({
        workspacePath: workspaceAbsPath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(normalizedAutomationId ? { automationId: normalizedAutomationId } : {}),
        ...(automationTab ? { automationTab } : {}),
      });
    },
    [onNavigateToAutomations, taskNavPushAutomations, workspaceAbsPath, workspaceIdentity],
  );

  const handleOpenPluginStore = useCallback(() => {
    taskNavPushPluginStore(workspaceAbsPath, workspaceIdentity);
    onNavigateToPluginStore?.({ workspacePath: workspaceAbsPath, workspaceIdentity });
  }, [onNavigateToPluginStore, taskNavPushPluginStore, workspaceAbsPath, workspaceIdentity]);

  // Opens a history target. Automations and the plugin marketplace are page entries; task entries go through the normal selection path.
  const openHistoryEntry = useCallback(
    (entry: WorkspaceNavEntry) => {
      if (isAutomationsNavEntry(entry)) {
        activateTabByPath(
          entry.workspacePath,
          entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : undefined,
        );
        onNavigateToAutomations?.({
          workspacePath: entry.workspacePath,
          ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
          ...(entry.automationId ? { automationId: entry.automationId } : {}),
          ...(entry.automationTab ? { automationTab: entry.automationTab } : {}),
        });
        return;
      }
      if (isPluginStoreNavEntry(entry)) {
        activateTabByPath(
          entry.workspacePath,
          entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : undefined,
        );
        onNavigateToPluginStore?.(entry);
        return;
      }
      handleSelectTask(entry.workspacePath, entry.taskId, entry.workspaceIdentity);
    },
    [activateTabByPath, handleSelectTask, onNavigateToAutomations, onNavigateToPluginStore],
  );

  const handleTaskNavBack = useCallback(() => {
    const currentWorkspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspaceAbsPath);
    if (
      shouldBlockTaskSelectionDuringModelRestart(
        currentWorkspaceState.modelSwitchPending,
        currentWorkspaceState.modelSwitchStage,
      )
    ) {
      logger.info(
        "[App] 模型运行时重建中，忽略任务后退导航 workspace=" +
          workspaceAbsPath +
          " stage=" +
          currentWorkspaceState.modelSwitchStage,
      );
      toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
      return;
    }

    // The store purges unavailable task entries and picks the next reachable one in the same update.
    const entry = taskNavGoBack((target) => !isTaskKnownDeleted(target));
    if (!entry) {
      toast(intl.formatMessage({ id: "taskNav.noMoreBack" }));
      return;
    }
    openHistoryEntry(entry);
  }, [intl, isTaskKnownDeleted, openHistoryEntry, taskNavGoBack, workspaceAbsPath]);

  const handleTaskNavForward = useCallback(() => {
    const currentWorkspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspaceAbsPath);
    if (
      shouldBlockTaskSelectionDuringModelRestart(
        currentWorkspaceState.modelSwitchPending,
        currentWorkspaceState.modelSwitchStage,
      )
    ) {
      logger.info(
        "[App] 模型运行时重建中，忽略任务前进导航 workspace=" +
          workspaceAbsPath +
          " stage=" +
          currentWorkspaceState.modelSwitchStage,
      );
      toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
      return;
    }

    const entry = taskNavGoForward((target) => !isTaskKnownDeleted(target));
    if (!entry) {
      toast(intl.formatMessage({ id: "taskNav.noMoreForward" }));
      return;
    }
    openHistoryEntry(entry);
  }, [intl, isTaskKnownDeleted, openHistoryEntry, taskNavGoForward, workspaceAbsPath]);

  const canGoBack = navCanGoBack(taskNavHistory);
  const canGoForward = navCanGoForward(taskNavHistory);
  const currentWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspaceAbsPath);
  const isTaskSwitchLockedByModelRestart = shouldBlockTaskSelectionDuringModelRestart(
    currentWorkspaceState.modelSwitchPending,
    currentWorkspaceState.modelSwitchStage,
  );
  const canTaskNavBack = canGoBack && !isTaskSwitchLockedByModelRestart;
  const canTaskNavForward = canGoForward && !isTaskSwitchLockedByModelRestart;

  return {
    handleSelectTask,
    handleOpenAutomations,
    handleOpenPluginStore,
    handleTaskNavBack,
    handleTaskNavForward,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
  };
}
