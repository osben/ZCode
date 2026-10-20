import { useMemo } from "react";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";

function isLocalWorkspaceTab(tab: WorkspaceTabState): boolean {
  return !tab.remoteSessionId && !tab.remoteTarget && !tab.workspaceIdentity;
}

export function useLocalWorkspaceScopes({
  workspaceTabs,
}: {
  workspaceTabs: WorkspaceTabState[];
}): WorkspaceTabState[] {
  return useMemo(
    () =>
      workspaceTabs.filter((tab) => {
        // Pinned queries use only local workspaces already open in the current window.
        // Do not include a remote workspace from lastWorkspaceSession as a fallback; without remoteSessionId it would use
        // the local service and could read tasks from another workspace at the same path.
        return isWorkspaceTab(tab) && isLocalWorkspaceTab(tab);
      }),
    [workspaceTabs],
  );
}
