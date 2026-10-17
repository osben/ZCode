import { expect, test } from "vitest";
import { isTaskBranchMerged } from "@/lib/taskBranchMergeStatus.js";

test("uses workspace merge state for ordinary tasks", () => {
  expect(
    isTaskBranchMerged(
      {},
      {
        state: "merged",
        baseRef: "origin/main",
        headRef: "feature/workspace",
        lastCommitAt: null,
      },
    ),
  ).toBe(true);
});

test("a worktree task is merged only when the observed head matches its branch", () => {
  const status = {
    state: "merged" as const,
    baseRef: "origin/main",
    headRef: "feature/worktree",
    lastCommitAt: null,
  };

  expect(
    isTaskBranchMerged(
      { executionWorktree: { path: "/tmp/tree", branchName: "feature/worktree" } },
      status,
    ),
  ).toBe(true);
  expect(
    isTaskBranchMerged(
      { executionWorktree: { path: "/tmp/tree", branchName: "feature/parent" } },
      status,
    ),
  ).toBe(false);
  expect(isTaskBranchMerged({ executionWorktree: { path: "/tmp/tree" } }, status)).toBe(true);
});
