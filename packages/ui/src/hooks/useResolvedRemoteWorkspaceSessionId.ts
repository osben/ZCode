import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  resolveWorkspaceRemoteSessionId,
  type WorkspaceServiceResolverState,
} from "@/lib/workspaceServiceResolver.js";

export function resolveRemoteWorkspaceSessionIdForTarget<TServices>(params: {
  workspacePath: string | null | undefined;
  preferredRemoteSessionId?: string | null;
  workspaceIdentity?: string | null;
  remoteTarget?: unknown;
  activeTab?: WorkspaceTabState | null;
  state: WorkspaceServiceResolverState<TServices>;
}): string | null {
  if (!params.workspacePath) {
    return null;
  }

  const workspaceIdentity = params.workspaceIdentity?.trim() || undefined;
  const matchingActiveTab =
    params.activeTab &&
    (workspaceIdentity
      ? params.activeTab.workspaceIdentity?.trim() === workspaceIdentity
      : params.activeTab.workspacePath === params.workspacePath)
      ? params.activeTab
      : null;
  const activeTabWorkspaceIdentity = matchingActiveTab?.workspaceIdentity?.trim() || undefined;
  const explicitRemoteSessionId = [
    params.preferredRemoteSessionId,
    matchingActiveTab?.remoteSessionId,
  ].find((candidateSessionId): candidateSessionId is string =>
    Boolean(candidateSessionId && params.state.sessionsById[candidateSessionId]),
  );

  return (
    resolveWorkspaceRemoteSessionId(
      {
        workspacePath: params.workspacePath,
        workspaceIdentity: workspaceIdentity ?? activeTabWorkspaceIdentity,
        remoteSessionId: explicitRemoteSessionId,
        // An identity may be absent for a local workspace, so do not treat every such workspace
        // as a legacy remote tab. Allow the path fallback for legacy data only when the exact
        // active tab matches or the caller's resolved target tab actually carries remoteTarget.
        remoteTarget: matchingActiveTab?.remoteTarget ?? params.remoteTarget,
      },
      params.state,
    ) ?? null
  );
}

export function useResolvedRemoteWorkspaceSessionId(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): string | null {
  const activeWorkspaceTab = useTabStore((state) => {
    if (!workspacePath || !state.activeTabId) {
      return null;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab)) {
      return null;
    }

    if (workspaceIdentity) {
      return activeTab.workspaceIdentity?.trim() === workspaceIdentity.trim() ? activeTab : null;
    }

    return activeTab.workspacePath === workspacePath ? activeTab : null;
  });

  return useRemoteWorkspaceSessionStore((state) =>
    resolveRemoteWorkspaceSessionIdForTarget({
      workspacePath,
      preferredRemoteSessionId,
      workspaceIdentity,
      remoteTarget,
      activeTab: activeWorkspaceTab,
      state,
    }),
  );
}
