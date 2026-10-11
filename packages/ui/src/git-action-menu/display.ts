import type { GitRepositorySummary } from "@zcode/shared";

type GitActionMenuPrimaryActionId = "commit" | "push";

export function canRenderGitActionMenu(options: {
  actionAvailable: boolean;
  commitEnabled: boolean;
  pushEnabled: boolean;
}): boolean {
  // Bugfix: The top-level Git action previously used branch creation as the empty-state fallback,
  // so clean repositories with nothing to push still showed “Create branch,” implying that users had to create one.
  // Render the entry only when a commit/push workflow is available; keep branch creation as a secondary menu action.
  return options.actionAvailable && (options.commitEnabled || options.pushEnabled);
}

export function canUseGitActionMenu(
  summary: Pick<GitRepositorySummary, "isGitAvailable" | "isRepository">,
): boolean {
  return summary.isGitAvailable && summary.isRepository;
}

export function resolveGitActionMenuPrimaryAction(options: {
  actionAvailable: boolean;
  commitEnabled: boolean;
  pushEnabled: boolean;
}): GitActionMenuPrimaryActionId | null {
  // Key business rule: the primary button only commits or pushes; branch creation stays in the dropdown menu.
  // This lets users create a branch from a clean repository without accidentally triggering branch creation via “Commit or push.”
  if (options.actionAvailable && options.commitEnabled) {
    return "commit";
  }

  if (options.actionAvailable && options.pushEnabled) {
    return "push";
  }

  return null;
}

export function canPushGitBranch(
  summary: Pick<
    GitRepositorySummary,
    "headRefType" | "branchName" | "trackingBranchName" | "ahead"
  >,
): boolean {
  const branchName = summary.branchName?.trim() ?? "";
  if (summary.headRefType !== "branch" || branchName.length === 0) {
    return false;
  }

  return !summary.trackingBranchName || summary.ahead > 0;
}
