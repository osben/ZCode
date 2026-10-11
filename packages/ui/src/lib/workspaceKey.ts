/**
 * Use workspaceIdentity consistently for identity/isolation semantics; legacy local calls fall back to the path when identity is unavailable.
 * Do not include remoteSessionId: it describes a connection instance and does not change workspace identity.
 */
export function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string | null): string {
  return workspaceIdentity?.trim() || workspacePath;
}
