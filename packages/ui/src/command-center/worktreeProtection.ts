export interface WorktreeProtectionEntry {
  path: string;
  branchName: string | null;
  isCurrent: boolean;
}

export interface WorktreeProtectionTaskFact {
  executionWorktree?: { path: string; branchName?: string } | null;
  /** Host-owned preparation of a not-yet-active session; cancelled preparations release the guard. */
  worktreePreparation?: {
    status: string;
    branchName: string;
    targetPath: string;
  } | null;
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

/**
 * Click-time re-check for worktree removal (normal and force): the rendered guard can be stale
 * after a prepared session's worktree fact or the task list changed, and the dirty-directory
 * force confirmation must never bypass the in-use guard.
 */
export function isWorktreeRemovalBlockedNow(input: {
  targetPath: string;
  targetBranch: string | null;
  targetIdentity: string | undefined;
  canonicalIdentityOf: (path: string) => string | undefined;
  tasks: readonly WorktreeProtectionTaskFact[];
}): boolean {
  const { targetPath, targetBranch, targetIdentity } = input;
  const identityMatches = (usedPath: string) =>
    usedPath === targetPath || input.canonicalIdentityOf(usedPath) === targetIdentity;
  return input.tasks.some((task) => {
    const prepared =
      task.worktreePreparation && task.worktreePreparation.status !== "cancelled"
        ? task.worktreePreparation
        : null;
    const usedPaths = [
      ...(task.executionWorktree?.path ? [task.executionWorktree.path] : []),
      ...(prepared ? [prepared.targetPath] : []),
    ];
    const usedBranches = [
      ...(task.executionWorktree?.branchName ? [task.executionWorktree.branchName] : []),
      ...(prepared ? [prepared.branchName] : []),
    ];
    return (
      usedPaths.some(identityMatches) ||
      (targetBranch !== null && usedBranches.includes(targetBranch))
    );
  });
}
