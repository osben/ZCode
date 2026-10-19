import assert from "assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, copyFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";
import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";
import { createGhCommandProvider } from "../src/git/providers/ghCommandProvider.js";
import { createSessionPullRequestsService } from "../src/git/sessionPullRequestsService.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

/**
 * Integration over the real host path — no network: gh is the checked-in
 * fake script (fixtures/fake-gh.sh) resolved through ZCODE_GH_BINARY, git is
 * real. Exercises binary resolution, auth detection, remote parsing, the
 * push-remote head-owner chain, the batched GraphQL call, and the mapping
 * end to end.
 */

async function prepareWorkspace(root: string): Promise<void> {
  const repoDir = join(root, "repo");
  const worktreeDir = join(root, "wt");
  await git(root, "init", "-q", "-b", "main", "repo");
  await git(repoDir, "config", "user.email", "t@t");
  await git(repoDir, "config", "user.name", "t");
  await execFileAsync("git", ["commit", "--allow-empty", "-q", "-m", "base"], { cwd: repoDir });
  await git(repoDir, "worktree", "add", "-q", "-b", "feat/demo", "../wt");
  await git(repoDir, "remote", "add", "origin", "https://github.com/e2e-fork/ZCode.git");
  void worktreeDir;
}

test("sessionPullRequestsService resolves PRs through the fake gh and a real git repository", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-session-pr-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await prepareWorkspace(root);

  // Copy the fixture per run and make it executable (git keeps the mode, but a
  // fresh checkout on some filesystems does not).
  const fakeGhPath = join(root, "fake-bin", "gh");
  await mkdir(join(root, "fake-bin"), { recursive: true });
  copyFileSync(join(import.meta.dirname, "fixtures", "fake-gh.sh"), fakeGhPath);
  chmodSync(fakeGhPath, 0o755);

  const previousGhBinary = process.env.ZCODE_GH_BINARY;
  process.env.ZCODE_GH_BINARY = fakeGhPath;
  t.after(() => {
    if (previousGhBinary === undefined) {
      delete process.env.ZCODE_GH_BINARY;
    } else {
      process.env.ZCODE_GH_BINARY = previousGhBinary;
    }
  });

  const service = createSessionPullRequestsService({
    repo: createGitCliRepo(),
    gitRunner: createGitCommandProvider(),
    gh: createGhCommandProvider(),
  });

  const result = await service.getSessionPullRequests({
    workspacePath: join(root, "repo"),
    tasks: [{ taskId: "t1", branchName: "feat/demo", worktreePath: join(root, "wt") }],
  });
  const status = result.t1!;
  assert.equal(status.state, "ready");
  assert.equal(status.primaryNumber, 101, "the open PR is primary over the merged one");
  assert.equal(status.pullRequests.length, 2);
  const primary = status.pullRequests[0]!;
  assert.equal(primary.repository, "e2e-fork/ZCode");
  assert.equal(primary.stage, "open");
  assert.equal(primary.checks, "failing", "the fake open PR has a failing required check");
  assert.equal(primary.failingCheckCount, 1);
  assert.equal(primary.hasConflict, false);
  const merged = status.pullRequests[1]!;
  assert.equal(merged.stage, "merged");
  assert.equal(merged.checks, "none");
  assert.equal(merged.mergedAt, "2026-10-18T00:00:00Z");
  assert.equal(status.stale, false);
  assert.ok(status.fetchedAt);
});
