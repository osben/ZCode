export interface WorktreeProtectionEntry {
  path: string;
  branchName: string | null;
  isCurrent: boolean;
}

export function isWorktreeProtected(input: {
  entry: WorktreeProtectionEntry;
  canonicalIdentity: string | null;
  identitiesResolved: boolean;
  openPathIdentities: ReadonlySet<string>;
  activePathIdentities: ReadonlySet<string>;
  activeBranchNames: ReadonlySet<string>;
}): boolean {
  const { entry, canonicalIdentity } = input;
  if (entry.isCurrent || !input.identitiesResolved || !canonicalIdentity) return true;
  return (
    input.openPathIdentities.has(canonicalIdentity) ||
    input.activePathIdentities.has(canonicalIdentity) ||
    Boolean(entry.branchName && input.activeBranchNames.has(entry.branchName))
  );
}
