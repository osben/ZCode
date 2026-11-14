/* eslint-disable max-lines -- workspace 的 task、自动化与插件市场共享浏览器式历史，集中处理才能保证前进/后退目标一致。 */
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  canGoBack as navCanGoBack,
  canGoForward as navCanGoForward,
  goBack,
  goForward,
  isAutomationsNavEntry,
  isPluginStoreNavEntry,
  isTaskNavEntry,
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
import {
  onTaskNavigationCommitted,
  onTaskNavigationRequested,
} from "@/store/zcodeSessionStoreNavigation.js";
import { ensureTaskNavigationWorkspace } from "@/app-shell/taskNavigationWorkspace.js";
import { selectWorkbenchSession } from "@/v4/workbenchSessionPlacement.js";

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
  isWebRemoteControl = false,
  activateTabByPath,
  onNavigateToTask,
  onNavigateToAutomations,
  onNavigateToPluginStore,
}: {
  intl: { formatMessage: (descriptor: { id: string }) => string };
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  isWebRemoteControl?: boolean;
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
  // Read at command time through the owner; no tombstone copy lives in the session store.
  const isTaskKnownDeleted =
    useOptionalProjectDirectory()?.isTaskKnownDeleted ?? NO_KNOWN_DELETED_TASKS;
  const navigationVersion = useRef(0);
  useEffect(() => {
    const subscription = onTaskNavigationCommitted(() => {
      navigationVersion.current += 1;
    });
    return () => {
      navigationVersion.current += 1;
      subscription.dispose();
    };
  }, []);

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
      // Global search can return a directory not yet opened; a bare activate would fail and leave the user on the original task.
      const workspaceResult = ensureTaskNavigationWorkspace({
        workspacePath: targetWorkspacePath,
        workspaceIdentity: targetWorkspaceIdentityHint,
        activateTabByPath,
        addLocalWorkspaceTab: (path) => {
          tabStoreApi.getState().addTab(path);
        },
      });
      if (!workspaceResult.accepted) {
        toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
        return;
      }
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

  const navigateHistory = useCallback(
    async (direction: "back" | "forward") => {
      const sessionStore = useZCodeSessionStore.getState();
      const origin = sessionStore.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
      if (
        shouldBlockTaskSelectionDuringModelRestart(
          origin.modelSwitchPending,
          origin.modelSwitchStage,
        )
      ) {
        toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
        return;
      }
      const request = ++navigationVersion.current;
      const originalHistory = sessionStore.taskNavHistory;
      const originalTabId = tabStoreApi.getState().activeTabId;
      const isCurrent = () => {
        const state = useZCodeSessionStore.getState();
        const current = state.getWorkspaceState(workspaceAbsPath, workspaceIdentity);
        return (
          request === navigationVersion.current &&
          state.taskNavHistory === originalHistory &&
          tabStoreApi.getState().activeTabId === originalTabId &&
          current.activeTaskId === origin.activeTaskId &&
          current.draftFocusVersion === origin.draftFocusVersion
        );
      };
      const step = direction === "back" ? goBack : goForward;
      let history = originalHistory;
      try {
        for (let next = step(history); next; next = step(history)) {
          const { entry } = next;
          if (isAutomationsNavEntry(entry) || isPluginStoreNavEntry(entry)) {
            if (!isCurrent()) return;
            useZCodeSessionStore.setState({ taskNavHistory: next.history });
            activateTabByPath(entry.workspacePath, { workspaceIdentity: entry.workspaceIdentity });
            if (isAutomationsNavEntry(entry)) onNavigateToAutomations?.(entry);
            else onNavigateToPluginStore?.(entry);
            return;
          }
          // Fork: a task the project directory reports as deleted is purged like a missing Host row.
          if (isTaskNavEntry(entry) && isTaskKnownDeleted(entry)) {
            history = {
              entries: history.entries.filter((_, index) => index !== next.history.cursor),
              cursor: history.cursor - (next.history.cursor < history.cursor ? 1 : 0),
            };
            continue;
          }
          const targetTab = tabStoreApi
            .getState()
            .tabs.find(
              (tab) =>
                isWorkspaceTab(tab) &&
                buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
                  buildTaskWorkspaceKey(entry.workspacePath, entry.workspaceIdentity),
            );
          const remoteSessionId =
            targetTab && isWorkspaceTab(targetTab) ? targetTab.remoteSessionId : undefined;
          const remote = Boolean(
            entry.workspaceIdentity ||
            (targetTab && isWorkspaceTab(targetTab) && targetTab.remoteTarget),
          );
          const services = remoteSessionId
            ? getRemoteWorkspaceSession(remoteSessionId)?.services
            : remote
              ? undefined
              : baseServices;
          if (!services) throw new Error("Navigation target is disconnected");
          // The sidebar moved to the project tree, so an old cache miss does not mean deletion; only trust an explicit empty result from the Host index.
          // The real cursor does not move during the query; a new selection, draft or connection generation invalidates a late result.
          const meta = await services.zcodeTaskService.getTaskMeta({
            workspacePath: entry.workspacePath,
            workspaceIdentity: entry.workspaceIdentity,
            taskId: entry.taskId,
          });
          if (
            !isCurrent() ||
            (remoteSessionId && getRemoteWorkspaceSession(remoteSessionId)?.services !== services)
          )
            return;
          if (!meta) {
            // Remove only the exact entry from this query and keep the current position; deleting every duplicate task would skip neighboring targets.
            history = {
              entries: history.entries.filter((_, index) => index !== next.history.cursor),
              cursor: history.cursor - (next.history.cursor < history.cursor ? 1 : 0),
            };
            continue;
          }
          const targetState = useZCodeSessionStore
            .getState()
            .getWorkspaceState(entry.workspacePath, entry.workspaceIdentity);
          if (
            shouldBlockTaskSelectionDuringModelRestart(
              targetState.modelSwitchPending,
              targetState.modelSwitchStage,
            )
          ) {
            toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
            return;
          }
          const workspace = ensureTaskNavigationWorkspace({
            workspacePath: entry.workspacePath,
            workspaceIdentity: entry.workspaceIdentity,
            activateTabByPath,
            addLocalWorkspaceTab: (path) => {
              tabStoreApi.getState().addTab(path);
            },
          });
          if (!workspace.accepted) throw new Error("Navigation target is disconnected");
          // Share the workbench owner with sidebar selection so only the shell activeTaskId does not change while the split view still shows the old session.
          if (!isWebRemoteControl)
            selectWorkbenchSession(
              origin.activeTaskId
                ? {
                    sessionId: origin.activeTaskId,
                    workspaceScope: { workspacePath: workspaceAbsPath, workspaceIdentity },
                  }
                : null,
              {
                workspacePath: entry.workspacePath,
                workspaceIdentity: entry.workspaceIdentity,
                remoteSessionId,
                sessionId: entry.taskId,
              },
            );
          useZCodeSessionStore.setState({ taskNavHistory: next.history });
          handleSelectTask(
            entry.workspacePath,
            entry.taskId,
            entry.workspaceIdentity,
            meta.unreadAt,
          );
          return;
        }
        if (isCurrent()) {
          useZCodeSessionStore.setState({ taskNavHistory: history });
          toast(
            intl.formatMessage({
              id: direction === "back" ? "taskNav.noMoreBack" : "taskNav.noMoreForward",
            }),
          );
        }
      } catch (error) {
        if (!isCurrent()) return;
        logger.warn("[task-navigation] 历史目标查询或打开失败，保留当前选择和历史", {
          direction,
          error,
        });
        toast(intl.formatMessage({ id: "automations.runs.openSessionFailed" }));
      }
    },
    [
      activateTabByPath,
      baseServices,
      handleSelectTask,
      intl,
      isTaskKnownDeleted,
      isWebRemoteControl,
      onNavigateToAutomations,
      onNavigateToPluginStore,
      tabStoreApi,
      workspaceAbsPath,
      workspaceIdentity,
    ],
  );
  const handleTaskNavBack = useCallback(() => {
    void navigateHistory("back");
  }, [navigateHistory]);
  const handleTaskNavForward = useCallback(() => {
    void navigateHistory("forward");
  }, [navigateHistory]);

  const canGoBack = navCanGoBack(taskNavHistory);
  const canGoForward = navCanGoForward(taskNavHistory);
  // 深层组件的跳转请求（规格 0.13）在这里落地：本 hook 是 handleSelectTask 的唯一持有者，
  // 订阅放在它这儿才不会出现第二条导航路径。App 只挂一次，所以订阅者唯一。
  const selectTaskRef = useRef(handleSelectTask);
  useLayoutEffect(() => {
    selectTaskRef.current = handleSelectTask;
  });
  useEffect(() => {
    const subscription = onTaskNavigationRequested((request) => {
      selectTaskRef.current(request.workspacePath, request.taskId, request.workspaceIdentity);
    });
    return () => subscription.dispose();
  }, []);

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
