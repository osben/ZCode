import type { ZCodeProvider } from "@zcode/shared";
import { useCallback } from "react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useTaskNativeSessionLogFile } from "@/hooks/useTaskNativeSessionLogFile.js";
import { useTaskSessionFilePath } from "@/hooks/useTaskSessionFilePath.js";
import { useWorkspaceProviderConfigFile } from "@/hooks/useWorkspaceProviderConfigFile.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { readLastSelectedEditorId } from "@/lib/editorPreference.js";
import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { logger } from "@/logger.js";

interface TaskPathState {
  loading: boolean;
  path: string | null;
  exists: boolean;
}

interface TaskListItemContextActionsResult {
  taskSessionFile: TaskPathState;
  taskNativeSessionLogFile: TaskPathState;
  providerConfigFile: TaskPathState;
  fileManagerLabel: string;
  /** Whether the file manager and provider config entries can run on this platform. */
  canOpenInFileManager: boolean;
  handleCopyText: (label: string, value: string | null) => Promise<void>;
  handleOpenTaskPathInFileManager: () => Promise<void>;
  handleOpenProviderConfig: () => Promise<void>;
}

export function resolveProviderConfigOpenTargetPath(path: string, exists: boolean): string {
  if (exists) {
    return path;
  }

  // Bugfix: when the provider's main config file has not been written yet, the More menu used to
  // disable “Go to config” entirely. Users could not see the containing directory or create the
  // file there. Fall back to opening the parent directory, preserving the navigation intent and
  // avoiding passing a nonexistent file path to the editor.
  const trimmedPath = path.replace(/[\\/]+$/, "");
  const lastSeparatorIndex = Math.max(trimmedPath.lastIndexOf("/"), trimmedPath.lastIndexOf("\\"));

  if (lastSeparatorIndex < 0) {
    return path;
  }

  if (lastSeparatorIndex === 0) {
    return trimmedPath[0] ?? path;
  }

  const parentPath = trimmedPath.slice(0, lastSeparatorIndex);
  if (/^[A-Za-z]:$/.test(parentPath)) {
    return `${parentPath}\\`;
  }

  return parentPath || path;
}

/** Clipboard write shared by task, side-chat and Agent-row context menus; failures are logged only. */
export async function copyTextToClipboard(label: string, value: string | null): Promise<void> {
  if (!value) {
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    logger.info(`[TaskListItem] ${label} 已复制: ${value}`);
  } catch (error) {
    logger.warn("[TaskListItem] 复制文本失败", {
      label,
      value,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function useTaskListItemContextActions({
  workspacePath,
  remoteSessionId,
  workspaceIdentity,
  taskId,
  provider,
  intl,
  loadTaskPaths = true,
  loadProviderConfig = true,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
  taskId: string;
  provider?: ZCodeProvider;
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  loadTaskPaths?: boolean;
  loadProviderConfig?: boolean;
}): TaskListItemContextActionsResult {
  const platform = usePlatform();
  const workspaceOpenTarget = useWorkspaceOpenInEditorTarget({
    workspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: remoteSessionId,
  });
  const taskProvider = provider ?? "glm";
  const taskSessionFile = useTaskSessionFilePath(workspacePath, taskId, workspaceIdentity, {
    // Task session/log paths are used only by context-menu items; do not issue bulk RPCs during list reordering while the menu is closed.
    enabled: loadTaskPaths,
  });
  const taskNativeSessionLogFile = useTaskNativeSessionLogFile(
    workspacePath,
    taskId,
    provider ?? null,
    workspaceIdentity,
    { enabled: loadTaskPaths },
  );
  const providerConfigFile = useWorkspaceProviderConfigFile(
    workspacePath,
    taskProvider,
    remoteSessionId,
    workspaceIdentity,
    {
      // Bugfix: in a remote workspace, “Go to config” opens a provider config that can be edited
      // locally. Using the remote zcodeTaskService for its path returned an absolute path on the
      // remote machine (for example, /root/...), which the local platform layer then opened at the
      // wrong location or failed to open. Always use the base service in remote mode so the UI gets
      // a config path available on this machine.
      serviceScope: remoteSessionId ? "base" : "workspace",
      // Bugfix: every task-list item mounts context-menu actions. Reading the provider config path
      // at mount time would multiply base RPCs and logs by the number of tasks in a remote
      // workspace. Load it only when the menu is opened.
      enabled: loadProviderConfig,
    },
  );

  const handleCopyText = useCallback(copyTextToClipboard, []);

  const handleOpenTaskPathInFileManager = useCallback(async () => {
    const hasRemoteWorkspaceScope = Boolean(
      remoteSessionId || workspaceIdentity?.trim() || workspaceOpenTarget.isRemoteWorkspace,
    );
    if (hasRemoteWorkspaceScope) {
      if (workspaceOpenTarget.remoteTarget?.kind !== "wsl") {
        // A remote project path is not a host path. Fail closed unless it can be resolved precisely as WSL,
        // so an SSH/Docker Linux path is not sent to a native Windows, macOS, or Linux file manager.
        logger.warn("[TaskListItem] 远程 workspace 不支持本机文件管理器", {
          taskId,
          path: workspacePath,
          remoteKind: workspaceOpenTarget.remoteTarget?.kind ?? "unresolved",
        });
        return;
      }

      const result = await platform.openInEditor("explorer", workspacePath, {
        pathKind: "directory",
        remoteTarget: workspaceOpenTarget.remoteTarget,
        workspaceIdentity,
      });
      if (!result.success) {
        logger.warn("[TaskListItem] 打开 WSL workspace 路径失败", {
          taskId,
          path: workspacePath,
          error: result.error ?? "unknown-error",
        });
      }
      return;
    }

    const isMac = isMacLike();
    const isWindows = isWindowsLike();
    if (isMac || isWindows) {
      const editorId = isMac ? "finder" : "explorer";
      const result = await platform.openInEditor(editorId, workspacePath);
      if (result.success) {
        return;
      }
    }

    const result = await platform.openInFileManager(workspacePath);
    if (!result.success) {
      // "Open in Finder" in the header/task menu should open the project directory.
      // It was previously tied to the task session file path, so menu availability depended on the task snapshot file;
      // if the session file had not been resolved yet, the Finder action appeared unexpectedly unavailable.
      // Always open workspacePath so this action matches "Copy path = project path".
      logger.warn("[TaskListItem] 打开 workspace 路径失败", {
        taskId,
        path: workspacePath,
        error: result.error ?? "unknown-error",
      });
    }
  }, [
    platform,
    remoteSessionId,
    taskId,
    workspaceIdentity,
    workspaceOpenTarget.isRemoteWorkspace,
    workspaceOpenTarget.remoteTarget,
    workspacePath,
  ]);

  const handleOpenProviderConfig = useCallback(async () => {
    if (!providerConfigFile.path) {
      return;
    }

    const openTargetPath = resolveProviderConfigOpenTargetPath(
      providerConfigFile.path,
      providerConfigFile.exists,
    );

    try {
      const preferredEditorId = readLastSelectedEditorId();
      const editors = await platform.getInstalledEditors();
      const sortedEditors = sortInstalledEditorsForOpenWith(editors);
      const preferredEditor =
        sortedEditors.find((editor) => editor.id === preferredEditorId) ?? sortedEditors[0] ?? null;

      // Bugfix: the task context menu is in the sidebar and cannot access the Header's local
      // selectedEditor state. Hardcoding an editor here would give “Go to config” different paths
      // from the Header. Read the persisted editor preference so both use the same user selection.
      if (preferredEditor) {
        const result = await platform.openInEditor(preferredEditor.id, openTargetPath);
        if (result.success) {
          return;
        }
      }

      const result = await platform.openInFileManager(openTargetPath);
      if (!result.success) {
        logger.warn("[TaskListItem] 打开 provider 配置失败", {
          taskId,
          provider: taskProvider,
          path: providerConfigFile.path,
          openTargetPath,
          error: result.error ?? "unknown-error",
        });
      }
    } catch (error) {
      logger.warn("[TaskListItem] 打开 provider 配置失败", {
        taskId,
        provider: taskProvider,
        path: providerConfigFile.path,
        openTargetPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [platform, providerConfigFile.exists, providerConfigFile.path, taskId, taskProvider]);

  return {
    taskSessionFile,
    taskNativeSessionLogFile,
    providerConfigFile,
    fileManagerLabel: getFileManagerLabel(intl),
    // ISSUE-066: web rejects openInFileManager ("Not supported in web mode"), so these menu
    // entries were silent no-ops there. Gate them on the platform capability instead.
    canOpenInFileManager: platform.canOpenLocalFiles === true,
    handleCopyText,
    handleOpenTaskPathInFileManager,
    handleOpenProviderConfig,
  };
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

function getFileManagerLabel(intl: {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}
