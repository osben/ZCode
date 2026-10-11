/* eslint-disable max-lines -- Workspace tasks, automations, and the plugin marketplace share browser-style history; handling them together keeps back/forward targets consistent. */
import { useCallback } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  canGoBack as navCanGoBack,
  canGoForward as navCanGoForward,
  isAutomationsNavEntry,
  isPluginStoreNavEntry,
  type AutomationsNavigationTab,
} from "@/lib/taskNavigationHistory.js";
import { shouldBlockTaskSelectionDuringModelRestart } from "@/lib/taskSwitchGuard.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { getVisibleTaskMetas, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { taskNavigationTargetExists } from "@/lib/taskNavigationTarget.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";

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
  const taskNavGoForward = useZCodeSessionStore((s) => s.taskNavGoForward);
  const removeTaskFromNavHistory = useZCodeSessionStore((s) => s.removeTaskFromNavHistory);

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

    let entry = taskNavGoBack();
    // Performance: task-meta recovery/stream synchronization frequently refresh query cache.
    // History navigation needs an existence snapshot only when a command runs; do not subscribe the hook to the whole meta table and rerender the shell.
    const taskMetaByEntityKey = useTaskQueryCacheStore.getState().taskMetaByEntityKey;
    while (entry) {
      const currentEntry = entry;
      if (isAutomationsNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToAutomations?.({
          workspacePath: currentEntry.workspacePath,
          ...(currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : {}),
          ...(currentEntry.automationId ? { automationId: currentEntry.automationId } : {}),
          ...(currentEntry.automationTab ? { automationTab: currentEntry.automationTab } : {}),
        });
        return;
      }
      if (isPluginStoreNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToPluginStore?.(currentEntry);
        return;
      }
      const navWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(currentEntry.workspacePath, currentEntry.workspaceIdentity);
      const exists = taskNavigationTargetExists({
        entry: currentEntry,
        visibleTasks: getVisibleTaskMetas(navWorkspaceState),
        taskMetaByEntityKey,
      });
      if (exists) {
        handleSelectTask(
          currentEntry.workspacePath,
          currentEntry.taskId,
          currentEntry.workspaceIdentity,
        );
        return;
      }

      // The target task was deleted; remove it from history and keep trying.
      removeTaskFromNavHistory(currentEntry.taskId);
      entry = taskNavGoBack();
    }

    toast(intl.formatMessage({ id: "taskNav.noMoreBack" }));
  }, [
    activateTabByPath,
    handleSelectTask,
    intl,
    onNavigateToAutomations,
    onNavigateToPluginStore,
    removeTaskFromNavHistory,
    taskNavGoBack,
    workspaceAbsPath,
  ]);

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

    let entry = taskNavGoForward();
    // Performance: read the latest query cache only when a forward command runs, instead of subscribing the entire navigation hook to small task-meta updates.
    const taskMetaByEntityKey = useTaskQueryCacheStore.getState().taskMetaByEntityKey;
    while (entry) {
      const currentEntry = entry;
      if (isAutomationsNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToAutomations?.({
          workspacePath: currentEntry.workspacePath,
          ...(currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : {}),
          ...(currentEntry.automationId ? { automationId: currentEntry.automationId } : {}),
          ...(currentEntry.automationTab ? { automationTab: currentEntry.automationTab } : {}),
        });
        return;
      }
      if (isPluginStoreNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToPluginStore?.(currentEntry);
        return;
      }
      const navWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(currentEntry.workspacePath, currentEntry.workspaceIdentity);
      const exists = taskNavigationTargetExists({
        entry: currentEntry,
        visibleTasks: getVisibleTaskMetas(navWorkspaceState),
        taskMetaByEntityKey,
      });
      if (exists) {
        handleSelectTask(
          currentEntry.workspacePath,
          currentEntry.taskId,
          currentEntry.workspaceIdentity,
        );
        return;
      }

      removeTaskFromNavHistory(currentEntry.taskId);
      entry = taskNavGoForward();
    }

    toast(intl.formatMessage({ id: "taskNav.noMoreForward" }));
  }, [
    activateTabByPath,
    handleSelectTask,
    intl,
    onNavigateToAutomations,
    onNavigateToPluginStore,
    removeTaskFromNavHistory,
    taskNavGoForward,
    workspaceAbsPath,
  ]);

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
