import { useMemo } from "react";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useBranchMergeStatuses } from "@/hooks/useBranchMergeStatuses.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";

/**
 * Invisible mount that probes branch merge status for every open workspace.
 * Lives once in the sidebar so grouped, flat, and archived task views share
 * the same store entries.
 */
export function BranchMergeStatusProbes({ workspaceTabs }: { workspaceTabs: WorkspaceTabState[] }) {
  const baseServices = useBaseWorkspaceServices();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({ sessionsById, sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const workspaceServiceLookup = useMemo(
    () => buildWorkspaceServiceLookup(workspaceTabs, baseServices, serviceResolverState),
    [baseServices, serviceResolverState, workspaceTabs],
  );
  const targets = useMemo(
    () =>
      workspaceTabs.flatMap((tab) => {
        const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
        const resolved = workspaceServiceLookup.get(workspaceKey);
        if (!resolved) {
          return [];
        }
        return [
          {
            workspaceKey,
            workspacePath: tab.workspacePath,
            ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
            gitService: resolved.services.gitService,
          },
        ];
      }),
    [workspaceServiceLookup, workspaceTabs],
  );
  useBranchMergeStatuses(targets);
  return null;
}
