import type { ZCodeProvider } from "@zcode/shared";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

function resolveChatViewActiveTaskProvider(
  taskId: string | null,
  workspaceState: Pick<
    WorkspaceZCodeUIState,
    "selectedProvider" | "taskListCache" | "optimisticTaskListByTaskId"
  >,
): ZCodeProvider {
  if (!taskId) {
    return workspaceState.selectedProvider;
  }

  // The input's $/ skill list and / panel previously used only the provider selected for the current workspace.
  // When users switch to a historical/forked task, or the task provider briefly differs from the workspace default,
  // the panel can include skills for another agent, and the available_skills injected before send can be wrong too.
  // Prefer the current task's provider so “the task currently being viewed” is the sole source of truth.
  // Also, after a successful Agent switch, the old provider in taskListCache may refresh a moment later;
  // optimistic metadata is the latest result confirmed by the frontend, so use it first to switch the icon immediately.
  return (
    workspaceState.optimisticTaskListByTaskId[taskId]?.provider ??
    workspaceState.taskListCache?.find((task) => task.taskId === taskId)?.provider ??
    workspaceState.selectedProvider
  );
}

export function useChatViewActiveTaskProvider(
  taskId: string | null,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  const activeTabWorkspaceIdentity = useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspacePath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
  const resolvedWorkspaceIdentity = workspaceIdentity ?? activeTabWorkspaceIdentity;

  return useZCodeSessionStore((state) => {
    const workspaceState = selectWorkspaceZCodeState(
      state,
      workspacePath,
      resolvedWorkspaceIdentity,
    );

    return resolveChatViewActiveTaskProvider(taskId, workspaceState);
  });
}
