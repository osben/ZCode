import { useCallback } from "react";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useWorkspaceTaskNavigation } from "@/app-shell/useWorkspaceTaskNavigation.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface OpenExistingSessionTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  unreadAt?: number;
}

export function useOpenExistingSession(
  openRemoteControlWorkspace?: (target: {
    workspacePath: string;
    workspaceIdentity?: string;
  }) => Promise<void>,
) {
  const services = useBaseWorkspaceServices();
  const tabs = useTabStoreApi();
  const { intl } = useZCodeIntl();
  const { handleSelectTask } = useWorkspaceTaskNavigation({
    intl,
    workspaceAbsPath: "",
    activateTabByPath: (path, options) => tabs.getState().activateTabByPath(path, options),
  });
  return useCallback(
    async (target: OpenExistingSessionTarget) => {
      const key = buildTaskWorkspaceKey(target.workspacePath, target.workspaceIdentity);
      const tab = tabs
        .getState()
        .tabs.find(
          (item) =>
            isWorkspaceTab(item) &&
            buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity) === key,
        );
      if (
        tab &&
        isWorkspaceTab(tab) &&
        (tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId)
      ) {
        if (!tab.remoteSessionId || !getRemoteWorkspaceSession(tab.remoteSessionId))
          throw new Error(intl.formatMessage({ id: "sessionManager.openUnavailable" }));
      } else if (!tab) {
        if (openRemoteControlWorkspace) {
          await openRemoteControlWorkspace(target);
        } else {
          if (target.workspaceIdentity)
            throw new Error(intl.formatMessage({ id: "sessionManager.openUnavailable" }));
          const info = await services.fileService.stat({ path: target.workspacePath });
          if (info.type !== "directory")
            throw new Error(intl.formatMessage({ id: "sessionManager.openUnavailable" }));
          tabs.getState().addTab(target.workspacePath);
        }
      }
      handleSelectTask(
        target.workspacePath,
        target.taskId,
        target.workspaceIdentity,
        target.unreadAt,
      );
    },
    [handleSelectTask, intl, openRemoteControlWorkspace, services.fileService, tabs],
  );
}
