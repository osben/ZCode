interface ConnectivityWorkspaceTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  localWorkspacePath?: string | null;
}

function isRemoteWorkspaceTab(tab: ConnectivityWorkspaceTab | null | undefined): boolean {
  return Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteSessionId?.trim() || tab?.remoteTarget,
  );
}

/**
 * Provider Settings belongs to the local Environment; when connectivity checks need a cwd, choose only a local workspace.
 * A remote tab's workspacePath belongs to a remote filesystem and cannot be passed directly to the Local Host.
 */
export function resolveModelProviderConnectivityWorkspacePath(params: {
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  activeWorkspaceTab?: ConnectivityWorkspaceTab | null;
  workspaceTabs: readonly ConnectivityWorkspaceTab[];
}): string {
  const rememberedLocalPath = params.activeWorkspaceTab?.localWorkspacePath?.trim();
  if (rememberedLocalPath) {
    return rememberedLocalPath;
  }

  // Older tabs may have only remoteSessionId or remoteTarget and no workspaceIdentity.
  // Their workspacePath is still a remote path and must not be passed to the Local Host just because identity is missing.
  const activeWorkspaceIsRemote = Boolean(
    params.activeWorkspaceIdentity?.trim() || isRemoteWorkspaceTab(params.activeWorkspaceTab),
  );
  if (!activeWorkspaceIsRemote) {
    const activeLocalPath = params.activeWorkspaceTab?.workspacePath.trim();
    if (activeLocalPath) {
      return activeLocalPath;
    }
    const activeWorkspacePath = params.activeWorkspacePath?.trim();
    if (activeWorkspacePath) {
      return activeWorkspacePath;
    }
  }

  const localTab = params.workspaceTabs.find((tab) => !isRemoteWorkspaceTab(tab));
  return localTab?.workspacePath.trim() ?? "";
}
