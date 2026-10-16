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
 * the same store entries. The sidebar panel is hidden with CSS and never
 * unmounts, so reopening is reported through `active` — each open re-probes.
 */
// Determination temporarily off (2026-10-15 user decision): the status is observed per workspace,
// so every task row inherited the workspace's own merge state — worktree sessions showed "Merged"
// immediately. Flip back on once the status is resolved per task branch.
const MERGE_STATUS_PROBES_ENABLED = false;

export function BranchMergeStatusProbes({
  workspaceTabs,
  active,
}: {
  workspaceTabs: WorkspaceTabState[];
  active: boolean;
}) {
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
  useBranchMergeStatuses(targets, { active: active && MERGE_STATUS_PROBES_ENABLED });
  return null;
}
