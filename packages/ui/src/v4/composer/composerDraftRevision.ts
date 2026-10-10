// Delayed trusted parsing for recommended prompts needs to know whether the user edited the Composer while waiting.
// revision exists only in renderer memory and is not part of draft persistence, protocol, or remote sync; workspace identity
// uses the same workspaceKey as the Zustand draft to prevent local paths and remote identities from sharing writes.
const revisionByWorkspaceKey = new Map<string, number>();

function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

export function getComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity?: string,
): number {
  return revisionByWorkspaceKey.get(getWorkspaceKey(workspacePath, workspaceIdentity)) ?? 0;
}

export function advanceComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity?: string,
): number {
  const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  const nextRevision = (revisionByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
  revisionByWorkspaceKey.set(workspaceKey, nextRevision);
  return nextRevision;
}
