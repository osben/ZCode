import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface WorkspaceShellTargetTab {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
}

export interface RootWorkspaceShellTarget {
  workspaceShellPath: string | null;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

function normalizeOptionalString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveRootWorkspaceShellTarget({
  activeWorkspaceTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  workspaceTabs,
}: {
  activeWorkspaceTab: WorkspaceShellTargetTab | null;
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  /** All workspace tabs in the current window; used to find the covered tab when a non-workspace tab such as Settings is active. */
  workspaceTabs: readonly WorkspaceShellTargetTab[];
}): RootWorkspaceShellTarget {
  if (activeWorkspaceTab) {
    return {
      workspaceShellPath: activeWorkspaceTab.workspacePath,
      workspaceIdentity: normalizeOptionalString(activeWorkspaceTab.workspaceIdentity),
      workspaceRemoteSessionId: normalizeOptionalString(activeWorkspaceTab.remoteSessionId),
    };
  }

  // When a Settings tab covers a workspace, the active tab is not a workspace tab.
  // Previously, the fallback restored workspacePath but not workspaceIdentity, so a disconnected SSH path was mistaken for a local base service.
  const workspaceIdentity = normalizeOptionalString(activeWorkspaceIdentity);
  // That fix still set workspaceRemoteSessionId to undefined. The completion notification hook in App uses it as the
  // endpointKey in the sessions-index registry; when missing, it creates another store for the same remote workspace under the `__base__` key,
  // and subscribes to the same topic again. The CLI keeps only the latest subscription for a connection/topic, silently replacing the one used by the sidebar,
  // so it never receives frames again. The left-side task spins indefinitely and its time remains frozen at the moment Settings was opened.
  // The covered workspace tab remains in the tab list; find it by workspaceKey so the shell target exactly matches the active tab.
  const coveredWorkspaceTab =
    activeWorkspacePath === null
      ? undefined
      : workspaceTabs.find(
          (tab) =>
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
            buildTaskWorkspaceKey(activeWorkspacePath, workspaceIdentity),
        );

  return {
    workspaceShellPath: activeWorkspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: normalizeOptionalString(coveredWorkspaceTab?.remoteSessionId),
  };
}
