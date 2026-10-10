type TaskNavigationWorkspaceResult =
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
