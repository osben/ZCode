import { useCallback, useMemo, useState } from "react";
import type {
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
} from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

export function buildWebRemoteControlTaskRowKey(task: WebRemoteControlTaskTarget): string {
  return `${resolveWebRemoteControlWorkspaceKey(task)}:${task.taskId}`;
}

interface OpenWebRemoteControlTaskOptions {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  task: WebRemoteControlTaskTarget;
  markTaskReadOnOpen?: boolean;
  mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onNavigateToChat?: () => void;
  onTaskOpen?: (options: { crossWorkspace: boolean }) => void;
  onSwitchingChange?: (switching: boolean) => void;
  onNavigateHome?: () => void;
  setSwitchingTaskKey?: (taskKey: string | null) => void;
  setError?: (error: string | null) => void;
}

function isDisconnectedRemoteWorkspaceBridgeError(message: string): boolean {
  return message.includes("远程工作区尚未连接") || message.includes("请先重连");
}

export async function openWebRemoteControlTask({
  activeWorkspaceIdentity,
  activeWorkspacePath,
  markTaskReadOnOpen,
  mobileNavigationIntent,
  onNavigateHome,
  onNavigateToChat,
  onSelectTask,
  onSwitchingChange,
  onTaskOpen,
  setError,
  setSwitchingTaskKey,
  switcher,
  task,
}: OpenWebRemoteControlTaskOptions): Promise<void> {
  const activeWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath: activeWorkspacePath,
    workspaceIdentity: activeWorkspaceIdentity,
  });
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  const isCrossWorkspace = taskWorkspaceKey !== activeWorkspaceKey;
  onTaskOpen?.({ crossWorkspace: isCrossWorkspace });

  if (!isCrossWorkspace) {
    if (markTaskReadOnOpen && typeof task.unreadAt === "number" && switcher.markTaskRead) {
      const logReadFailure = (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // A failed mark-read must not block opening the task; the authoritative tasks-index
        // snapshot restores the blue dot after returning home.
        logger.warn("[useWebRemoteControlTaskOpen] 标记手机端 task 已读失败", {
          error: message,
          taskId: task.taskId,
          workspaceKey: taskWorkspaceKey,
        });
      };
      try {
        // Fix reason: the phone home blue dot comes from the desktop-pushed snapshot, and the
        // current Root's query cache may not be hydrated yet. "User has viewed" is expressed
        // explicitly here instead of continuing to rely on the desktop selection logic's cache hit.
        void switcher.markTaskRead(task).catch(logReadFailure);
      } catch (err) {
        logReadFailure(err);
      }
    }
    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    try {
      await switcher.updateMobileViewState?.(taskWorkspaceKey, task.taskId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[useWebRemoteControlTaskOpen] 更新手机端查看状态失败", {
        error: message,
        taskId: task.taskId,
        workspaceKey: taskWorkspaceKey,
      });
    }
    onNavigateToChat?.();
    return;
  }

  const rowKey = buildWebRemoteControlTaskRowKey(task);
  onSwitchingChange?.(true);
  setSwitchingTaskKey?.(rowKey);
  setError?.(null);
  logger.info("[useWebRemoteControlTaskOpen] 开始切换远控 workspace", {
    taskId: task.taskId,
    workspaceKey: taskWorkspaceKey,
  });

  try {
    await switcher.switchWorkspace(taskWorkspaceKey, {
      taskId: task.taskId,
      ...(mobileNavigationIntent ? { mobileNavigationIntent } : {}),
      ...(markTaskReadOnOpen && typeof task.unreadAt === "number"
        ? { markTaskReadExpectedUnreadAt: task.unreadAt }
        : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[useWebRemoteControlTaskOpen] 打开远程 task 失败", {
      error: message,
      taskId: task.taskId,
      workspaceKey: taskWorkspaceKey,
    });
    setSwitchingTaskKey?.(null);
    onSwitchingChange?.(false);
    if (isDisconnectedRemoteWorkspaceBridgeError(message)) {
      // Bugfix: after the phone reconnects, the workspace list may not have synced to the new
      // remoteSessionId yet, and opening a task is then rejected by desktop main when creating
      // the bridge. Fall back to the task home page so the user sees the disconnected state and
      // the reconnect button instead of being stuck on the chat page's error message.
      onNavigateHome?.();
      return;
    }
    setError?.(message);
  }
}

export function useWebRemoteControlTaskOpen({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  markTaskReadOnOpen,
  mobileNavigationIntent,
  onNavigateHome,
  onNavigateToChat,
  onSelectTask,
  onSwitchingChange,
  onTaskOpen,
  switcher,
}: Omit<OpenWebRemoteControlTaskOptions, "setError" | "setSwitchingTaskKey" | "task">) {
  const [switchingTaskKey, setSwitchingTaskKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeWorkspaceKey = useMemo(
    () =>
      resolveWebRemoteControlWorkspaceKey({
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath],
  );
  const openTask = useCallback(
    (task: WebRemoteControlTaskTarget) => {
      void openWebRemoteControlTask({
        activeTaskId,
        activeWorkspaceIdentity,
        activeWorkspacePath,
        markTaskReadOnOpen,
        mobileNavigationIntent,
        onNavigateHome,
        onNavigateToChat,
        onSelectTask,
        onSwitchingChange,
        onTaskOpen,
        setError,
        setSwitchingTaskKey,
        switcher,
        task,
      });
    },
    [
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      markTaskReadOnOpen,
      mobileNavigationIntent,
      onNavigateHome,
      onNavigateToChat,
      onSelectTask,
      onSwitchingChange,
      onTaskOpen,
      switcher,
    ],
  );

  return {
    activeWorkspaceKey,
    error,
    openTask,
    switchingTaskKey,
  };
}
