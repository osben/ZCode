import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { useShallow } from "zustand/react/shallow";
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
  activeTab?: Pick<
    WorkspaceTabState,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "remoteTarget"
  > | null;
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
  const activeWorkspaceTab = useOptionalTabStore(
    useShallow((state) => {
      if (!workspacePath || !state.activeTabId) {
        return null;
      }

      const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (!activeTab || !isWorkspaceTab(activeTab)) {
        return null;
      }

      const matches = workspaceIdentity
        ? activeTab.workspaceIdentity?.trim() === workspaceIdentity.trim()
        : activeTab.workspacePath === workspacePath;
      // Completing the tab classification on first creation used to update every session row of the same workspace; subscribe only to the fields connection resolution consumes.
      return matches
        ? {
            workspacePath: activeTab.workspacePath,
            workspaceIdentity: activeTab.workspaceIdentity,
            remoteSessionId: activeTab.remoteSessionId,
            remoteTarget: activeTab.remoteTarget,
          }
        : null;
    }),
  );

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
