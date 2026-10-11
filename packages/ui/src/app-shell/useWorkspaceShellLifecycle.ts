import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { TaskChatMessage as TestChatMessage } from "@/lib/taskChatMessageTypes.js";
import type { BrowserNavigationRequest } from "@/hooks/useAppPanels.js";
import { logger } from "@/logger.js";
import {
  getWorkspaceDisplayedTaskState,
  getWorkspaceInitState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";

export function useWorkspaceShellLifecycle({
  workspaceAbsPath,
  workspaceIdentity,
  services,
  setBrowserNavigationRequest,
  setTestMessages,
}: {
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  services: IServiceAccessor;
  setBrowserNavigationRequest: Dispatch<SetStateAction<BrowserNavigationRequest | null>>;
  setTestMessages: Dispatch<SetStateAction<TestChatMessage[] | null>>;
}) {
  const previousWorkspaceAbsPathRef = useRef(workspaceAbsPath);

  useEffect(() => {
    if (previousWorkspaceAbsPathRef.current === workspaceAbsPath) {
      return;
    }

    previousWorkspaceAbsPathRef.current = workspaceAbsPath;

    // Root previously changed its key by workspacePath to “rebuild the entire App when switching workspaces,”
    // which also unmounted the sidebar / TaskList and caused the whole column to flash on task switches.
    // Now that the same App instance is preserved, explicitly clear only state tightly bound to the old workspace,
    // preventing code previews or test-override messages from the previous project from leaking into the new one.
    // Side panes now restore in memory using workspaceIdentity/workspacePath.
    // Do not clear Git/source or tabs here when workspacePath changes, or switching back across workspaces would overwrite their caches.
    setBrowserNavigationRequest(null);
    setTestMessages(null);
  }, [setBrowserNavigationRequest, setTestMessages, workspaceAbsPath]);

  useEffect(() => {
    return () => {
      const currentWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(workspaceAbsPath);
      const displayedTaskState = getWorkspaceDisplayedTaskState(currentWorkspaceState);
      if (
        currentWorkspaceState.activeTaskId ||
        displayedTaskState.taskStatus === "creating" ||
        displayedTaskState.taskStatus === "streaming"
      ) {
        return;
      }

      // A prewarmed session keeps a ZCode Agent process alive even for a workspace with no task.
      // If these “prewarmed but never actually used” sessions are not cleaned up when switching tabs, switching among multiple workspaces leaves
      // several idle processes in the background. Make a best-effort cleanup when leaving the current workspace.
      // Also reset workspace initialization state to idle, or the next page entry may still show
      // the previous ready/failed state. With one ZCode Agent, cleanup no longer loops over providers.
      const workspaceInitState = getWorkspaceInitState(currentWorkspaceState);
      if (workspaceInitState.status === "idle") {
        return;
      }

      const provider = currentWorkspaceState.selectedProvider;
      logger.info(
        `[App] 回退 workspace 预热状态 workspace=${workspaceAbsPath} provider=${provider}`,
      );
      useZCodeSessionStore
        .getState()
        .setWorkspaceInitAttempts(workspaceAbsPath, 0, workspaceIdentity);
      useZCodeSessionStore
        .getState()
        .setWorkspaceInitState(workspaceAbsPath, "idle", null, workspaceIdentity);

      void services.zcodeTaskService
        .releaseWorkspacePreparation({
          workspacePath: workspaceAbsPath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          provider,
        })
        .catch((error: unknown) => {
          logger.error(
            `[App] 释放 workspace 预热态失败 workspace=${workspaceAbsPath} provider=${provider}:`,
            error,
          );
        });
    };
  }, [services.zcodeTaskService, workspaceIdentity, workspaceAbsPath]);
}
