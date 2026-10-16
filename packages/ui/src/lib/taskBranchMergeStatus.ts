import type { GitBranchMergeStatus, ZCodeTaskMeta } from "@zcode/shared";

export function isTaskBranchMerged(
  task: Pick<ZCodeTaskMeta, "executionWorktree">,
  status?: GitBranchMergeStatus,
): boolean {
  if (status?.state !== "merged") return false;
  const worktreeBranch = task.executionWorktree?.branchName;
  return !worktreeBranch || status.headRef === worktreeBranch;
}
