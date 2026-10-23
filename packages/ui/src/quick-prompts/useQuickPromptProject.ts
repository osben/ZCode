import { useMemo } from "react";
import { useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import { remoteHostIdFromWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { quickPromptProjectRefOf } from "@/quick-prompts/model.js";
import type { QuickPromptProjectRef } from "./contract.js";

// Same key shape as the project sidebar's availability map (view.ts projectKey, which is not a public entry).
function availabilityKey(project: { id: string; hostId: string }): string {
  return JSON.stringify([project.hostId, project.id]);
}

/**
 * Project identity of the composer's session: an existing session takes it from its task in the project tree; a
 * draft takes it from the draft's project id on the draft's host. Path is never used to derive identity.
 * Returns null (globals only) without a directory, without a project, or for a legacy single-root project.
 */
export function useQuickPromptProject(params: {
  sessionId: string | null;
  workspaceKey: string;
  workspaceIdentity?: string;
}): QuickPromptProjectRef | null {
  const directory = useOptionalProjectDirectory();
  const draftProjectId = useZCodeSessionStore(
    (state) => state.workspaces[params.workspaceKey]?.draftProjectId,
  );
  const { sessionId, workspaceIdentity } = params;
  return useMemo(() => {
    if (!directory) return null;
    if (sessionId) {
      const task = (directory.tree?.tasks ?? []).find(
        (candidate) => candidate.taskId === sessionId,
      );
      if (!task) return null;
      const project = (directory.projects ?? []).find(
        (candidate) => candidate.id === task.projectId && candidate.hostId === task.hostId,
      );
      return quickPromptProjectRefOf({
        projectId: task.projectId,
        hostId: task.hostId,
        legacySingleRoot: Boolean(project?.legacySingleRoot || directory.tree?.legacySingleRoot),
      });
    }
    // Same identity predicate as ProjectComposerMenu: a remote draft matches its host, a local draft matches
    // a project without a remote entry.
    const hostId = workspaceIdentity ? remoteHostIdFromWorkspaceIdentity(workspaceIdentity) : null;
    const project = (directory.projects ?? []).find(
      (candidate) =>
        candidate.id === draftProjectId &&
        (hostId
          ? candidate.hostId === hostId
          : !directory.availability?.get(availabilityKey(candidate))?.entryId),
    );
    return quickPromptProjectRefOf({
      projectId: project?.id,
      hostId: project?.hostId,
      legacySingleRoot: project?.legacySingleRoot,
    });
  }, [directory, draftProjectId, sessionId, workspaceIdentity]);
}
