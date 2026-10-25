export type TaskNavigationWorkspaceResult =
  | { accepted: true; openedLocalTab: boolean }
  | { accepted: false; reason: "remote_attachment_missing" };

export function ensureTaskNavigationWorkspace(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addLocalWorkspaceTab: (workspacePath: string) => void;
}): TaskNavigationWorkspaceResult {
  const workspaceIdentity = params.workspaceIdentity?.trim();
  if (
    params.activateTabByPath(
      params.workspacePath,
      workspaceIdentity ? { workspaceIdentity } : undefined,
    )
  ) {
    return { accepted: true, openedLocalTab: false };
  }

  if (workspaceIdentity) {
    // A remote workspace identity expresses isolation only; it cannot recreate an SSH/WSL/Docker
    // attachment. If the current window has no matching tab, fail closed to avoid creating an unconnectable remote tab.
    return { accepted: false, reason: "remote_attachment_missing" };
  }

  // Automations is a cross-project list, and the local workspace for a run's history may already be closed.
  // If we only try to activate it, failure still closes Automations and leaves the user in the current project's old session.
  params.addLocalWorkspaceTab(params.workspacePath);
  return { accepted: true, openedLocalTab: true };
}

/**
 * Selects a task after making its workspace visible. handleSelectTask only activates an existing tab, so a task of a
 * local project whose tab is closed (the command-center search covers those, ISSUE-020) used to be selected in a
 * hidden workspace and the view never moved (ISSUE-069).
 */
export function selectTaskInNavigationWorkspace(params: {
  target: { workspacePath: string; taskId: string; workspaceIdentity?: string };
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addLocalWorkspaceTab: (workspacePath: string) => void;
  selectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onRejected: (reason: "remote_attachment_missing") => void;
}): void {
  const { workspacePath, taskId, workspaceIdentity } = params.target;
  const result = ensureTaskNavigationWorkspace({
    workspacePath,
    workspaceIdentity,
    activateTabByPath: params.activateTabByPath,
    addLocalWorkspaceTab: params.addLocalWorkspaceTab,
  });
  if (!result.accepted) {
    params.onRejected(result.reason);
    return;
  }
  params.selectTask(workspacePath, taskId, workspaceIdentity);
}
