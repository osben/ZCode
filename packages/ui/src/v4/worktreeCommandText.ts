/**
 * The Git command line the Host runs to create the worktree (gitCliRepo.createWorktree): shown in
 * the setup/created card details so "expand → see which commands ran" always works
 * (specs/composer-worktree-setup-steps.md, Timeline presentation). An existing branch is checked
 * out as-is (no `-b`, no base); a new branch names the base when it is known.
 */
export function formatWorktreeAddCommand(params: {
  branchName: string;
  targetPath: string;
  baseBranch?: string;
  /** HEAD-default fallback: rendered as the literal HEAD base, matching what Git runs. */
  baseFromHeadDefault?: boolean;
}): string {
  const { branchName, targetPath, baseBranch, baseFromHeadDefault } = params;
  const base = baseBranch?.trim() || (baseFromHeadDefault ? "HEAD" : undefined);
  const head = ["git", "worktree", "add", "-b", branchName, "--", targetPath];
  return [...head, ...(base ? [base] : [])].join(" ");
}
