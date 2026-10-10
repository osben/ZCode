import assert from "assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { GitBranchMergeStatus } from "@zcode/shared";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";
import type { GitCliRepo } from "../src/git/repo/gitCliRepo.js";
import { createGitService } from "../src/git/gitService.js";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function createLoggerCapture(): { logger: ServiceLogger; infos: unknown[][]; warns: unknown[][] } {
  const infos: unknown[][] = [];
  const warns: unknown[][] = [];
  return {
    infos,
    warns,
    logger: {
      debug: () => {},
      info: (_traceId, ...args: unknown[]) => {
        infos.push(args);
      },
      warn: (_traceId, ...args: unknown[]) => {
        warns.push(args);
      },
      error: () => {},
    },
  };
}

function createFakeRepo(statuses: GitBranchMergeStatus[]): {
  repo: GitCliRepo;
  getCalls: () => number;
} {
  let calls = 0;
  const repo = {
    getBranchMergeStatus: async () => {
      const status = statuses[Math.min(calls, statuses.length - 1)];
      calls += 1;
      return status;
    },
    switchBranch: async () => ({
      ok: true,
      action: "switch",
      branchName: "b",
      didChange: true,
      created: false,
      summary: {},
      issues: [],
    }),
    createBranchAndSwitch: async () => ({
      ok: true,
      action: "create",
      branchName: "b",
      didChange: true,
      created: true,
      summary: {},
      issues: [],
    }),
    commit: async () => ({ commitHash: "0000000000000000000000000000000000000000" }),
    getStatus: async () => ({ resolution: {}, summary: {} }),
  } as unknown as GitCliRepo;
  return { repo, getCalls: () => calls };
}

const MERGED: GitBranchMergeStatus = {
  state: "merged",
  baseRef: "origin/main",
  headRef: "feat/x",
  lastCommitAt: "2026-10-10T00:00:00Z",
};
const NOT_MERGED: GitBranchMergeStatus = {
  state: "not_merged",
  baseRef: "origin/main",
  headRef: "feat/x",
  lastCommitAt: "2026-10-10T00:00:00Z",
};

test("getBranchMergeStatus caches within TTL and re-probes after expiry", async () => {
  const fake = createFakeRepo([MERGED, NOT_MERGED]);
  let nowMs = 0;
  const { logger, infos } = createLoggerCapture();
  const service = createGitService({ repo: fake.repo, logger, now: () => nowMs });

  const first = await service.getBranchMergeStatus({ workspacePath: "/w" });
  assert.equal(first.state, "merged");
  assert.equal(fake.getCalls(), 1);

  nowMs = 30_000;
  const cached = await service.getBranchMergeStatus({ workspacePath: "/w" });
  assert.equal(fake.getCalls(), 1);
  assert.equal(cached.state, "merged");

  nowMs = 61_000;
  const refreshed = await service.getBranchMergeStatus({ workspacePath: "/w" });
  assert.equal(fake.getCalls(), 2);
  assert.equal(refreshed.state, "not_merged");
  assert.equal(infos.length, 1, "state change logs one info");
});

test("getBranchMergeStatus keys the cache by workspaceIdentity with path fallback", async () => {
  const fake = createFakeRepo([MERGED]);
  let nowMs = 0;
  const service = createGitService({
    repo: fake.repo,
    logger: createLoggerCapture().logger,
    now: () => nowMs,
  });

  await service.getBranchMergeStatus({ workspacePath: "/w", workspaceIdentity: "id-a" });
  await service.getBranchMergeStatus({ workspacePath: "/w", workspaceIdentity: "id-b" });
  assert.equal(fake.getCalls(), 2, "distinct identities probe separately");

  await service.getBranchMergeStatus({ workspacePath: "/w", workspaceIdentity: "id-b" });
  await service.getBranchMergeStatus({ workspacePath: "/w", workspaceIdentity: "  " });
  assert.equal(
    fake.getCalls(),
    3,
    "identity reuse hits cache; blank identity falls back to path key",
  );
});

test("switchBranch and commit invalidate the merge cache", async () => {
  const fake = createFakeRepo([MERGED]);
  let nowMs = 0;
  const service = createGitService({
    repo: fake.repo,
    logger: createLoggerCapture().logger,
    now: () => nowMs,
  });

  await service.getBranchMergeStatus({ workspacePath: "/w" });
  await service.switchBranch({ workspacePath: "/w", targetBranchName: "other" });
  await service.getBranchMergeStatus({ workspacePath: "/w" });
  assert.equal(fake.getCalls(), 2, "switchBranch forces a re-probe");

  await service.commit({ workspacePath: "/w", message: "m" });
  await service.getBranchMergeStatus({ workspacePath: "/w" });
  assert.equal(fake.getCalls(), 3, "commit forces a re-probe");
});

test("gitCliRepo.getBranchMergeStatus maps real git states", async (t) => {
  const workRoot = await mkdtemp(join(tmpdir(), "zcode-merge-status-"));
  t.after(async () => {
    await rm(workRoot, { recursive: true, force: true });
  });

  const repoDir = join(workRoot, "repo");
  const originDir = join(workRoot, "origin.git");
  await execFileAsync("git", ["init", "-b", "main", repoDir]);
  await git(repoDir, "config", "user.email", "test@example.com");
  await git(repoDir, "config", "user.name", "Test");
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "base"], { cwd: repoDir });
  await git(repoDir, "checkout", "-b", "feat/demo");
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "feat"], { cwd: repoDir });

  await execFileAsync("git", ["clone", "--bare", repoDir, originDir]);
  // The bare clone inherits HEAD from the checked-out feat/demo; point the
  // remote default branch at main so `remote set-head --auto` resolves it.
  await execFileAsync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: originDir });
  await git(repoDir, "remote", "add", "origin", originDir);
  await git(repoDir, "fetch", "origin");
  await git(repoDir, "remote", "set-head", "origin", "--auto");

  const repo = createGitCliRepo();

  // feat/demo tip is not contained in origin/main.
  const notMerged = await repo.getBranchMergeStatus(repoDir);
  assert.equal(notMerged.state, "not_merged");
  assert.equal(notMerged.baseRef, "origin/main");
  assert.equal(notMerged.headRef, "feat/demo");
  assert.ok(notMerged.lastCommitAt, "tip commit timestamp is returned");

  // A branch already contained in the default branch reads as merged.
  await git(repoDir, "checkout", "-q", "main");
  const merged = await repo.getBranchMergeStatus(repoDir);
  assert.equal(merged.state, "merged");
  assert.equal(merged.headRef, "main");

  // No origin/HEAD → unknown.
  await git(repoDir, "remote", "set-head", "origin", "-d");
  const unknown = await repo.getBranchMergeStatus(repoDir);
  assert.equal(unknown.state, "unknown");

  // Detached HEAD → unknown.
  await git(repoDir, "checkout", "-q", "--detach", "HEAD");
  const detached = await repo.getBranchMergeStatus(repoDir);
  assert.equal(detached.state, "unknown");
});
