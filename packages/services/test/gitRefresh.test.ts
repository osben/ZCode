import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GitRepositorySummary } from "@zcode/shared";
import { createGitService } from "../src/git/gitService.js";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";
import { getGitCommandEnv } from "../src/git/config.js";

const execGit = promisify(execFile);

describe("Git refresh resilience", () => {
  it("keeps refresh data when the tracking ref is missing and recovers comparison later", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "zcode-git-refresh-"));
    onTestFinished(() => rm(workspacePath, { recursive: true, force: true }));
    const git = (args: string[]) =>
      execGit("git", args, { cwd: workspacePath, env: getGitCommandEnv() });
    await git(["init", "-b", "main"]);
    await git(["config", "user.name", "ZCode Tester"]);
    await git(["config", "user.email", "tester@example.com"]);
    await writeFile(join(workspacePath, "tracked.txt"), "original\n");
    await git(["add", "tracked.txt"]);
    await git(["commit", "-m", "baseline"]);
    await git(["remote", "add", "origin", "."]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(["branch", "--set-upstream-to=origin/main", "main"]);
    await git(["update-ref", "-d", "refs/remotes/origin/main"]);
    await writeFile(join(workspacePath, "tracked.txt"), "changed after missing ref\n");
    await writeFile(join(workspacePath, "staged.txt"), "staged\n");
    await git(["add", "staged.txt"]);
    const service = createGitService();
    const request = { workspacePath, includeIdentity: true, includeBranchComparison: true };

    const failedComparison = await service.refresh(request);
    expect(failedComparison.summary).toMatchObject({
      isGitAvailable: true,
      isRepository: true,
      isDirty: true,
      trackingBranchName: "origin/main",
    });
    expect(failedComparison.identity?.userName).toBe("ZCode Tester");
    expect(failedComparison.unstagedChanges.map((change) => change.workspaceRelativePath)).toEqual([
      "tracked.txt",
    ]);
    expect(failedComparison.stagedChanges.map((change) => change.workspaceRelativePath)).toEqual([
      "staged.txt",
    ]);
    expect(failedComparison.branchComparison).toBeNull();
    expect(failedComparison).toHaveProperty(
      "branchComparisonError",
      expect.stringContaining("bad revision"),
    );

    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const recovered = await service.refresh(request);
    expect(recovered).toHaveProperty("branchComparisonError", null);
    expect(recovered.branchComparison?.baseRef).toBe("origin/main");
    expect(recovered.stagedChanges).toEqual(failedComparison.stagedChanges);
    expect(recovered.unstagedChanges).toEqual(failedComparison.unstagedChanges);
  });

  it("discloses unexpected comparison errors while required refresh errors still reject", async () => {
    const summary: GitRepositorySummary = {
      workspacePath: "/repo",
      repoRoot: "/repo",
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [],
      branchName: "main",
      trackingBranchName: "origin/main",
      headRefType: "branch",
      ahead: 0,
      behind: 0,
      isDirty: false,
      isGitAvailable: true,
      isRepository: true,
    };
    const getStatus = vi.fn().mockResolvedValue({
      summary,
      resolution: summary,
      entries: [],
      stagedStats: new Map(),
      unstagedStats: new Map(),
      untrackedStats: new Map(),
    });
    const identity = { userName: "Tester", userEmail: null, nameSource: null, emailSource: null };
    const getIdentity = vi.fn().mockResolvedValue(identity);
    const getBranchComparison = vi
      .fn()
      .mockRejectedValue(new Error("unexpected comparison failure"));
    const service = createGitService({
      repo: { ...createGitCliRepo(), getStatus, getIdentity, getBranchComparison },
    });
    const request = {
      workspacePath: summary.workspacePath,
      includeIdentity: true,
      includeBranchComparison: true,
    };
    const result = await service.refresh(request);
    expect(result.summary).toEqual(summary);
    expect(result.identity).toEqual(identity);
    expect(result).toHaveProperty("branchComparisonError", "unexpected comparison failure");
    expect(result.branchComparison).toBeNull();

    getStatus.mockRejectedValueOnce(new Error("git status timed out after 15000ms"));
    await expect(service.refresh(request)).rejects.toThrow("git status timed out");
    getIdentity.mockRejectedValueOnce(new Error("identity failed"));
    await expect(service.refresh(request)).rejects.toThrow("identity failed");
  });
});
