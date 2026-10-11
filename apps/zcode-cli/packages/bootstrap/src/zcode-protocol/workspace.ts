import { parseRemoteWorkspaceIdentity, type ZCodeWorkspaceRef } from "@zcode/shared";

export function buildWorkspaceRef(input: {
  workspaceIdentity?: string;
  workspacePath: string;
}): ZCodeWorkspaceRef {
  const workspaceIdentity = input.workspaceIdentity?.trim() || undefined;
  return {
    workspaceIdentity,
    workspaceKey: workspaceIdentity ?? input.workspacePath,
    workspacePath: input.workspacePath,
  };
}

/**
 * Resolve the local-path / remote-identity forms of a V4 workspaceId to a workspace ref.
 */
export function resolveWorkspaceRefFromId(workspaceId: string): ZCodeWorkspaceRef {
  const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
  if (!parsedRemote) {
    // Treating an invalid remote identity as a local path would write the identity into directory/path
    // again. The remote namespace must fail closed; retain the existing fallback for local paths.
    if (workspaceId.startsWith("remote:")) {
      throw new Error(`Invalid remote workspace identity: ${workspaceId}`);
    }
    return buildWorkspaceRef({ workspacePath: workspaceId });
  }

  // WSL identities with an explicit user previously fell through to the local-path branch when
  // parsing failed, causing the full identity to be treated as workingDirectory. Use the shared
  // parser to separate identity and path consistently.
  return buildWorkspaceRef({
    workspaceIdentity: workspaceId,
    workspacePath: parsedRemote.workspacePath,
  });
}
