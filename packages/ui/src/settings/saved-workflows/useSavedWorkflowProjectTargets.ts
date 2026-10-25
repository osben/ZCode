import { useMemo } from "react";
import type { ZCodeAgentWorkspaceTarget } from "@zcode/services";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import type { SavedWorkflowProjectTarget } from "@/settings/saved-workflows/savedWorkflowContract.js";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

interface SavedWorkflowProjectTargets {
  /** RPC target (including remoteSessionId), for store/service calls. */
  target: ZCodeAgentWorkspaceTarget;
  /** Project coordinates for sending to a conversation/opening an instance: workspacePath + identity only (no remoteSessionId). */
  projectTarget: SavedWorkflowProjectTarget;
  /** Coordinates for a direct-start connection: also includes remoteSessionId to determine the conversation connection endpoint and navigation target. */
  launchTarget: SavedWorkflowLaunchTarget;
}

/**
 * Three coordinate sets used by a project group (all actions use **that project's** target).
 * They differ only in whether they include remoteSessionId; references stay stable while dependencies are unchanged for memo/effect dependencies.
 */
export function useSavedWorkflowProjectTargets(
  project: Pick<
    AutomationWorkspaceOption,
    "workspacePath" | "workspaceIdentity" | "projectId" | "hostId"
  >,
  remoteSessionId: string | null,
): SavedWorkflowProjectTargets {
  const target = useMemo<ZCodeAgentWorkspaceTarget>(
    () => ({
      projectId: project.projectId,
      hostId: project.hostId,
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity?.trim()
        ? { workspaceIdentity: project.workspaceIdentity }
        : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [
      project.projectId,
      project.hostId,
      project.workspacePath,
      project.workspaceIdentity,
      remoteSessionId,
    ],
  );
  const projectTarget = useMemo<SavedWorkflowProjectTarget>(
    () => ({
      projectId: project.projectId,
      hostId: project.hostId,
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
    }),
    [project.projectId, project.hostId, project.workspacePath, project.workspaceIdentity],
  );
  const launchTarget = useMemo<SavedWorkflowLaunchTarget>(
    () => ({
      projectId: project.projectId,
      hostId: project.hostId,
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [
      project.projectId,
      project.hostId,
      project.workspacePath,
      project.workspaceIdentity,
      remoteSessionId,
    ],
  );
  return { target, projectTarget, launchTarget };
}
