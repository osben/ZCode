import type { ZCodeTaskMeta } from "@zcode/shared";
import { getPathLeaf } from "@/lib/path.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

interface TaskFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

function resolveTaskFileTreeTarget(
  task: ZCodeTaskMeta,
  tab: WorkspaceTabState | undefined,
): TaskFileTreeTarget | null {
  // Legacy local tasks lack workspaceIdentity, so the key falls back to workspacePath; if a remote tab at the same path also lacks identity,
  // matching by key alone could attach the remote session. Ensure local/remote types match before comparing keys.
  const taskIsRemote = Boolean(task.workspaceIdentity?.trim());
  const tabIsRemote = Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteTarget || tab?.remoteSessionId,
  );
  const matchingTab =
    tab &&
    buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
      buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) &&
    taskIsRemote === tabIsRemote
      ? tab
      : undefined;
  if (tab && !matchingTab) {
    return null;
  }
  const isRemoteWorkspace = Boolean(
    task.workspaceIdentity?.trim() || matchingTab?.remoteTarget || matchingTab?.remoteSessionId,
  );
  // A remote task's workspacePath may match a local workspace. Do not open the file tree without the matching remoteSessionId,
  // or file reads will incorrectly fall back to the local service.
  if (isRemoteWorkspace && !matchingTab?.remoteSessionId) {
    return null;
  }

  return {
    workspacePath: task.workspacePath,
    workspaceName: matchingTab?.label || getPathLeaf(task.workspacePath) || task.workspacePath,
    ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(matchingTab?.remoteSessionId
      ? { workspaceRemoteSessionId: matchingTab.remoteSessionId }
      : {}),
  };
}

export function resolveTaskFileTreeTargetFromTabs(
  task: ZCodeTaskMeta,
  tabs: readonly WorkspaceTabState[],
): TaskFileTreeTarget | null {
  // A local and legacy remote tab at the same path may produce the same key, so do not collapse them into a single-value Map;
  // retain all candidates and let the single-tab resolver validate workspace type and remote session.
  for (const tab of tabs) {
    const target = resolveTaskFileTreeTarget(task, tab);
    if (target) {
      return target;
    }
  }
  // Local tasks do not depend on an open tab; open the file tree by path even when the owning workspace is closed.
  // Remote tasks must match a tab to get an identity-scoped remoteSessionId; do not use the same fallback.
  if (!task.workspaceIdentity?.trim()) {
    return resolveTaskFileTreeTarget(task, undefined);
  }
  return null;
}
