// Shared worktree creation orchestration: inside-placement worktrees must be excluded from the
// main checkout's status after creation or reuse, without ever changing the creation outcome.
import { describe, expect, it, vi } from "vitest";
import {
  executeWorktreeCreation,
  type WorktreeCreationGitService,
} from "@/command-center/worktreeCreation.js";

const WORKSPACE = "/dev/alpha";
const TARGET = "/dev/alpha/.worktrees/zcode-sleepy-capybara";
const BRANCH = "zcode/sleepy-capybara";

function createGitService(overrides: Partial<WorktreeCreationGitService> = {}) {
  const service = {
    createWorktree: vi.fn(async () => ({
      ok: true as const,
      worktreePath: TARGET,
      branchName: BRANCH,
      issues: [],
    })),
    listWorktrees: vi.fn(async () => ({
      isGitAvailable: true,
      isRepository: true,
      worktrees: [],
    })),
    verifyWorktreeUsable: vi.fn(async () => ({ ok: true as const })),
    ensureWorktreeExclusion: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
  return service as typeof service & WorktreeCreationGitService;
}

function run(gitService: WorktreeCreationGitService) {
  return executeWorktreeCreation({
    gitService,
    workspacePath: WORKSPACE,
    branchName: BRANCH,
    targetPath: TARGET,
    formatMessage: (id) => id,
  });
}

describe("executeWorktreeCreation worktree exclusion", () => {
  it("excludes the created worktree from the main checkout status before reporting created", async () => {
    const gitService = createGitService();

    const outcome = await run(gitService);

    expect(outcome).toEqual({ kind: "created", worktreePath: TARGET });
    expect(gitService.ensureWorktreeExclusion).toHaveBeenCalledTimes(1);
    expect(gitService.ensureWorktreeExclusion).toHaveBeenCalledWith({
      workspacePath: WORKSPACE,
      targetPath: TARGET,
    });
  });

  it("keeps the created outcome when the exclusion request rejects", async () => {
    const gitService = createGitService({
      ensureWorktreeExclusion: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    });

    await expect(run(gitService)).resolves.toEqual({ kind: "created", worktreePath: TARGET });
  });

  it("keeps the created outcome when the exclusion reports ok:false", async () => {
    const gitService = createGitService({
      ensureWorktreeExclusion: vi.fn(async () => ({ ok: false as const })),
    });

    await expect(run(gitService)).resolves.toEqual({ kind: "created", worktreePath: TARGET });
  });

  it("excludes a reused registered worktree on the existing-worktree outcome", async () => {
    const existingPath = `${WORKSPACE}/.worktrees/existing`;
    const gitService = createGitService({
      createWorktree: vi.fn(async () => ({
        ok: false as const,
        worktreePath: null,
        branchName: null,
        issues: [{ code: "target-path-exists" as const, message: "exists", detail: null }],
      })),
      listWorktrees: vi.fn(async () => ({
        isGitAvailable: true,
        isRepository: true,
        worktrees: [
          {
            path: existingPath,
            headCommitHash: "c",
            branchName: BRANCH,
            isMain: false,
            isBare: false,
            isDetached: false,
            isCurrent: false,
          },
        ],
      })),
    });

    const outcome = await run(gitService);

    expect(outcome.kind).toBe("existing-worktree");
    expect(gitService.ensureWorktreeExclusion).toHaveBeenCalledWith({
      workspacePath: WORKSPACE,
      targetPath: existingPath,
    });
  });

  it("does not exclude anything when creation fails", async () => {
    const gitService = createGitService({
      createWorktree: vi.fn(async () => ({
        ok: false as const,
        worktreePath: null,
        branchName: null,
        issues: [{ code: "git-unavailable" as const, message: "no git", detail: null }],
      })),
    });

    const outcome = await run(gitService);

    expect(outcome.kind).toBe("failed");
    expect(gitService.ensureWorktreeExclusion).not.toHaveBeenCalled();
  });
});
