// Worktree creation failures must name their cause in the setup row / Command Center error
// (specs/composer-worktree-setup-steps.md "A failed creation names its cause"; QA MINOR-2 in
// docs/testing/git-worktree-qa/actual-issues-2026-10-18.md): an unclassified Git rejection carries
// Git's own failure line instead of only the generic "Could not create the worktree".
import { describe, expect, it, vi } from "vitest";
import type { GitWorktreeCreateResult, GitWorktreeMutationIssue } from "@zcode/shared";
import {
  executeWorktreeCreation,
  type WorktreeCreationGitService,
} from "@/command-center/worktreeCreation.js";
import enUS from "@/i18n/locales/en-US.js";

const WORKSPACE = "/dev/alpha";
const TARGET = "/dev/alpha-worktrees/zcode-sleepy-capybara";
const BRANCH = "zcode/sleepy-capybara";

function rejectWith(issue: GitWorktreeMutationIssue) {
  const gitService = {
    createWorktree: vi.fn(
      async (): Promise<GitWorktreeCreateResult> => ({
        ok: false,
        worktreePath: null,
        branchName: null,
        issues: [issue],
      }),
    ),
    listWorktrees: vi.fn(),
    verifyWorktreeUsable: vi.fn(),
    ensureWorktreeExclusion: vi.fn(),
  } as unknown as WorktreeCreationGitService;
  return executeWorktreeCreation({
    gitService,
    workspacePath: WORKSPACE,
    branchName: BRANCH,
    baseBranch: "main",
    targetPath: TARGET,
    formatMessage: (id, values) =>
      Object.entries(values ?? {}).reduce(
        (text, [key, value]) => text.replace(`{${key}}`, value),
        enUS[id] ?? id,
      ),
  });
}

describe("executeWorktreeCreation failure reason", () => {
  it("shows Git's failure line for an unclassified rejection (EACCES on the worktrees parent)", async () => {
    const outcome = await rejectWith({
      code: "unknown",
      message: "Git could not create the worktree.",
      // Real `git worktree add` stderr: a progress line precedes the fatal cause.
      detail: `Preparing worktree (new branch '${BRANCH}')\nfatal: could not create leading directories of '${TARGET}/.git': Permission denied`,
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      message: `Could not create the worktree: could not create leading directories of '${TARGET}/.git': Permission denied`,
      issueCodes: ["unknown"],
    });
  });

  it("keeps the generic text when Git produced no output", async () => {
    const outcome = await rejectWith({
      code: "unknown",
      message: "Git could not create the worktree.",
      detail: null,
    });

    expect(outcome).toMatchObject({ kind: "failed", message: "Could not create the worktree." });
  });

  it("hints at a repository without commits when the base branch is missing", async () => {
    const outcome = await rejectWith({
      code: "target-branch-not-found",
      message: "Base branch was not found.",
      detail: "fatal: invalid reference: main",
    });

    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("“main” was not found");
    expect(outcome.kind === "failed" && outcome.message).toContain(
      "A repository without commits has no branches yet",
    );
  });
});
