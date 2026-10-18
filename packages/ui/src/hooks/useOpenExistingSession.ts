import { useCallback } from "react";
import { useBaseWorkspaceServices } from "./useWorkspaceServices.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useWorkspaceTaskNavigation } from "@/app-shell/useWorkspaceTaskNavigation.js";
import { isWorkspaceTab, type TabStoreState, type WorkspaceTabState } from "@/store/tabStore.js";
import { isSameWorkspaceTab } from "@/store/tabWorkspaceIdentity.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface OpenExistingSessionTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  unreadAt?: number;
}

// A local target must only resolve to a local tab: a remote tab sharing the same path
// (with or without a workspaceIdentity) would otherwise be activated for a local task.
function findTargetWorkspaceTab(
  state: Pick<TabStoreState, "tabs">,
  workspacePath: string,
  workspaceIdentity?: string,
): WorkspaceTabState | undefined {
  const identity = workspaceIdentity?.trim();
  const key = buildTaskWorkspaceKey(workspacePath, identity);
  return state.tabs.find(
    (item): item is WorkspaceTabState =>
      isWorkspaceTab(item) &&
      (identity
        ? buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity) === key
        : isSameWorkspaceTab(item, workspacePath)),
  );
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
  // The store's activateTabByPath matches any tab by path when no identity is given,
  // which can pick a remote tab for a local target; activate the exact tab instead.
  const activateTargetTab = useCallback(
    (path: string, options?: { workspaceIdentity?: string }) => {
      const tab = findTargetWorkspaceTab(tabs.getState(), path, options?.workspaceIdentity);
      if (!tab) return false;
      tabs.getState().activateTab(tab.id);
      return true;
    },
    [tabs],
  );
  const { handleSelectTask } = useWorkspaceTaskNavigation({
    intl,
    workspaceAbsPath: "",
    activateTabByPath: activateTargetTab,
  });
  return useCallback(
    async (target: OpenExistingSessionTarget) => {
      const workspaceIdentity = target.workspaceIdentity?.trim() || undefined;
      const tab = findTargetWorkspaceTab(tabs.getState(), target.workspacePath, workspaceIdentity);
      if (tab && (tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId)) {
        if (!tab.remoteSessionId || !getRemoteWorkspaceSession(tab.remoteSessionId))
          throw new Error(intl.formatMessage({ id: "sessionManager.openUnavailable" }));
      } else if (!tab) {
        if (openRemoteControlWorkspace) {
          await openRemoteControlWorkspace(target);
        } else {
          if (workspaceIdentity)
            throw new Error(intl.formatMessage({ id: "sessionManager.openUnavailable" }));
          const info = await services.fileService.stat({ path: target.workspacePath });
          if (info.type !== "directory")
            throw new Error(intl.formatMessage({ id: "sessionManager.openUnavailable" }));
          tabs.getState().addTab(target.workspacePath);
        }
      }
      handleSelectTask(target.workspacePath, target.taskId, workspaceIdentity, target.unreadAt);
    },
    [handleSelectTask, intl, openRemoteControlWorkspace, services.fileService, tabs],
  );
}
