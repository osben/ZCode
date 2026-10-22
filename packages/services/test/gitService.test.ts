import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { getSingularPatch } from "@pierre/diffs";
import type {
  GitCommitMessageConversationContext,
  GitDiffResult,
  GitFileChange,
  GitRepositorySummary,
} from "@zcode/shared";
import type { GitCommitMessageGenerator } from "../src/git/gitCommitMessageGenerator.js";
import { createGitService } from "../src/git/gitService.js";
import type { GitCliRepo } from "../src/git/repo/gitCliRepo.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const describeIfGit = gitAvailable ? describe : describe.skip;
let repoTemplatePath: string | null = null;
const gitLocalEnvVars = gitAvailable
  ? execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf-8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  : [];

function createSummary(overrides: Partial<GitRepositorySummary> = {}): GitRepositorySummary {
  return {
    workspacePath: "/repo/packages/app",
    repoRoot: "/repo",
    workspaceInRepoPath: "packages/app",
    autoRefreshWatchPaths: [],
    branchName: "main",
    trackingBranchName: "origin/main",
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: true,
    isRepository: true,
    ...overrides,
  };
}

function createMockRepo(overrides: Partial<GitCliRepo>): GitCliRepo {
  const unexpected = (name: keyof GitCliRepo) =>
    vi.fn(async () => {
      throw new Error(`Unexpected GitCliRepo call in test: ${name}`);
    });

  return {
    invalidate: vi.fn(),
    resolveRepository: unexpected("resolveRepository"),
    getWorkspaceRepositoryInfo: unexpected("getWorkspaceRepositoryInfo"),
    getStatus: unexpected("getStatus"),
    getCommitGraph: unexpected("getCommitGraph"),
    getIgnoredPaths: unexpected("getIgnoredPaths"),
    listLocalBranches: unexpected("listLocalBranches"),
    switchBranch: unexpected("switchBranch"),
    createBranchAndSwitch: unexpected("createBranchAndSwitch"),
    getDiff: unexpected("getDiff"),
    getBranchComparison: unexpected("getBranchComparison"),
    stage: unexpected("stage"),
    unstage: unexpected("unstage"),
    discard: unexpected("discard"),
    commit: unexpected("commit"),
    push: unexpected("push"),
    getIdentity: unexpected("getIdentity"),
    ...overrides,
  } as GitCliRepo;
}

function createDetachedGitEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
  };

  // Bugfix: when tests are triggered by the pre-push hook, Git injects local env vars such as
  // GIT_DIR/GIT_WORK_TREE. Without clearing them, this helper would operate on the current working repo
  // even when given a temp repo cwd (e.g. renaming its branch to main). Removing the Git local env here
  // ensures every git command in tests only acts on the explicitly passed repository directory.
  for (const variableName of gitLocalEnvVars) {
    delete env[variableName];
  }

  return env;
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function runGit(cwd: string | undefined, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: createDetachedGitEnv(),
  }).trim();
}

function runGitAllowFailure(cwd: string | undefined, args: string[]) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
  });
}

function resolveGitPath(repoPath: string, gitPath: string): string {
  return isAbsolute(gitPath) ? gitPath : resolve(repoPath, gitPath);
}

function createRepoTemplate(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "zcode-git-template-"));
  const workspacePath = join(repoPath, "packages", "app");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(join(repoPath, "packages", "other"), { recursive: true });

  writeFileSync(join(workspacePath, "tracked.txt"), "line 1\nline 2\n");
  writeFileSync(join(repoPath, "packages", "other", "skip.txt"), "skip\n");

  runGit(repoPath, ["init"]);
  runGit(repoPath, ["branch", "-M", "main"]);
  runGit(repoPath, ["config", "user.name", "ZCode Tester"]);
  runGit(repoPath, ["config", "user.email", "tester@example.com"]);
  runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  runGit(repoPath, ["config", "core.autocrlf", "false"]);
  runGit(repoPath, ["config", "maintenance.auto", "false"]);
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "chore: initial"]);

  return repoPath;
}

async function createRepo(options?: { withRemote?: boolean }) {
  if (!repoTemplatePath) {
    throw new Error("Git test repository template is not initialized");
  }

  // Bugfix: each test used to build a repo from scratch via 8 synchronous Git subprocesses, exhausting
  // macOS's process launch queue when related tests run concurrently. Reuse a one-time template and copy
  // an independent worktree, preserving real Git behavior and per-test isolation.
  const repoContainer = makeTempDir("zcode-git-repo-");
  const repoPath = join(repoContainer, "repo");
  await cp(repoTemplatePath, repoPath, { recursive: true });
  const workspacePath = join(repoPath, "packages", "app");

  let remotePath: string | null = null;
  if (options?.withRemote) {
    remotePath = makeTempDir("zcode-git-remote-");
    runGit(undefined, ["init", "--bare", remotePath]);
    runGit(repoPath, ["remote", "add", "origin", remotePath]);
    runGit(repoPath, ["push", "-u", "origin", "main"]);
  }

  return { repoPath, workspacePath, remotePath };
}

beforeAll(() => {
  if (gitAvailable) {
    repoTemplatePath = createRepoTemplate();
  }
});

afterAll(async () => {
  if (repoTemplatePath) {
    await rm(repoTemplatePath, { recursive: true, force: true });
    repoTemplatePath = null;
  }
});

describeIfGit("gitService", () => {
  it("lists local branches and marks the current branch", async () => {
    const workspacePath = "/repo/packages/app";
    const listLocalBranches = vi.fn().mockResolvedValue({
      headRefType: "branch",
      currentBranchName: "main",
      branches: [
        {
          name: "main",
          isCurrent: true,
          upstreamName: "origin/main",
          commitHash: "a".repeat(40),
          commitTimestampMs: 1,
        },
        {
          name: "feature/list-branches",
          isCurrent: false,
          upstreamName: null,
          commitHash: "b".repeat(40),
          commitTimestampMs: 2,
        },
      ],
    });
    const service = createGitService({
      repo: createMockRepo({ listLocalBranches }),
    });

    const branches = await service.getLocalBranches({ workspacePath });

    expect(branches.headRefType).toBe("branch");
    expect(branches.currentBranchName).toBe("main");
    expect(branches.branches[0]).toMatchObject({
      name: "main",
      isCurrent: true,
    });
    expect(branches.branches.map((branch) => branch.name)).toEqual([
      "main",
      "feature/list-branches",
    ]);
    expect(
      branches.branches.find((branch) => branch.name === "feature/list-branches"),
    ).toMatchObject({
      isCurrent: false,
      upstreamName: null,
    });
    expect(listLocalBranches).toHaveBeenCalledWith(workspacePath);
  });

  // Bugfix: this test really creates/switches/merges Git repos and can occasionally exceed the default
  // 5s under full pre-push parallelism. Only this integration test's timeout is relaxed, so Git process
  // scheduling jitter is not misjudged as a business failure.
  it("returns real commit graph history with parents, refs, and max-count", async () => {
    const { repoPath, workspacePath } = await createRepo();
    const service = createGitService();

    runGit(repoPath, ["switch", "-c", "feature/git-graph"]);
    writeFileSync(join(workspacePath, "feature-graph.txt"), "feature graph\n");
    runGit(repoPath, ["add", "packages/app/feature-graph.txt"]);
    runGit(repoPath, ["commit", "-m", "feat: graph branch"]);
    runGit(repoPath, ["switch", "main"]);
    writeFileSync(join(workspacePath, "main-graph.txt"), "main graph\n");
    runGit(repoPath, ["add", "packages/app/main-graph.txt"]);
    runGit(repoPath, ["commit", "-m", "feat: graph main"]);
    runGit(repoPath, ["merge", "--no-ff", "feature/git-graph", "-m", "merge graph branch"]);
    runGit(repoPath, ["tag", "v-graph"]);
    const hiddenCheckpointOid = runGit(repoPath, [
      "commit-tree",
      "HEAD^{tree}",
      "-m",
      "zcode checkpoint hidden",
    ]);
    runGit(repoPath, [
      "update-ref",
      "refs/zcode/checkpoints/test-workspace/hidden",
      hiddenCheckpointOid,
    ]);

    const graph = await service.getCommitGraph({ workspacePath, maxCount: 10 });

    expect(graph.hasMore).toBe(false);
    expect(graph.commits.map((commit) => commit.subject)).not.toContain("zcode checkpoint hidden");
    expect(graph.commits[0]).toMatchObject({
      subject: "merge graph branch",
      parents: expect.arrayContaining([
        expect.stringMatching(/^[0-9a-f]{40}$/),
        expect.stringMatching(/^[0-9a-f]{40}$/),
      ]),
    });
    expect(graph.commits[0]?.refs).toEqual(
      expect.arrayContaining([
        { name: "HEAD", kind: "head" },
        { name: "main", kind: "branch" },
        { name: "v-graph", kind: "tag" },
      ]),
    );

    const cappedGraph = await service.getCommitGraph({
      workspacePath,
      maxCount: 2,
    });
    expect(cappedGraph.commits).toHaveLength(2);
    expect(cappedGraph.hasMore).toBe(true);

    const secondPage = await service.getCommitGraph({
      workspacePath,
      maxCount: 2,
      skip: 2,
    });
    expect(secondPage.commits.map((commit) => commit.hash)).toEqual(
      graph.commits.slice(2, 4).map((commit) => commit.hash),
    );
  });

  it("switches branches successfully and treats switching to the current branch as a no-op", async () => {
    const workspacePath = "/repo/packages/app";
    const switchedSummary = createSummary({
      branchName: "feature/switch-target",
    });
    const switchBranch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        action: "switch",
        branchName: "feature/switch-target",
        didChange: true,
        created: false,
        summary: switchedSummary,
        issues: [],
      })
      .mockResolvedValueOnce({
        ok: true,
        action: "switch",
        branchName: "feature/switch-target",
        didChange: false,
        created: false,
        summary: switchedSummary,
        issues: [],
      });
    const service = createGitService({
      repo: createMockRepo({ switchBranch }),
    });

    const switched = await service.switchBranch({
      workspacePath,
      targetBranchName: "feature/switch-target",
    });
    expect(switched).toMatchObject({
      ok: true,
      action: "switch",
      branchName: "feature/switch-target",
      didChange: true,
      created: false,
    });
    expect(switched.summary.branchName).toBe("feature/switch-target");

    const noOp = await service.switchBranch({
      workspacePath,
      targetBranchName: "feature/switch-target",
    });
    expect(noOp).toMatchObject({
      ok: true,
      didChange: false,
      created: false,
    });
    expect(noOp.summary.branchName).toBe("feature/switch-target");
    expect(switchBranch).toHaveBeenNthCalledWith(1, workspacePath, "feature/switch-target");
    expect(switchBranch).toHaveBeenNthCalledWith(2, workspacePath, "feature/switch-target");
  });

  it("keeps Git-native behavior and allows switching when dirty changes do not conflict", async () => {
    const { repoPath, workspacePath } = await createRepo();
    const service = createGitService();

    runGit(repoPath, ["switch", "-c", "feature/keep-dirty"]);
    runGit(repoPath, ["switch", "main"]);
    writeFileSync(join(workspacePath, "tracked.txt"), "line 1\nline 2 dirty\n");

    const result = await service.switchBranch({
      workspacePath,
      targetBranchName: "feature/keep-dirty",
    });

    expect(result).toMatchObject({
      ok: true,
      didChange: true,
      created: false,
    });
    expect(result.summary.branchName).toBe("feature/keep-dirty");
    expect(result.summary.isDirty).toBe(true);
    expect(readFileSync(join(workspacePath, "tracked.txt"), "utf-8")).toBe(
      "line 1\nline 2 dirty\n",
    );
  });

  it("returns structured issues when tracked changes would be overwritten", async () => {
    const { repoPath, workspacePath } = await createRepo();
    const service = createGitService();

    runGit(repoPath, ["switch", "-c", "feature/overwrite-tracked"]);
    writeFileSync(join(workspacePath, "tracked.txt"), "branch version\n");
    runGit(repoPath, ["commit", "-am", "feat: change tracked file"]);
    runGit(repoPath, ["switch", "main"]);
    writeFileSync(join(workspacePath, "tracked.txt"), "local dirty\n");

    const result = await service.switchBranch({
      workspacePath,
      targetBranchName: "feature/overwrite-tracked",
    });

    expect(result.ok).toBe(false);
    expect(result.summary.branchName).toBe("main");
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "tracked-changes-would-be-overwritten",
        paths: ["packages/app/tracked.txt"],
      }),
    ]);
  });

  it("returns structured issues when untracked files would be overwritten", async () => {
    const { repoPath, workspacePath } = await createRepo();
    const service = createGitService();

    runGit(repoPath, ["switch", "-c", "feature/overwrite-untracked"]);
    writeFileSync(join(workspacePath, "collide.txt"), "branch file\n");
    runGit(repoPath, ["add", "packages/app/collide.txt"]);
    runGit(repoPath, ["commit", "-m", "feat: add collide file"]);
    runGit(repoPath, ["switch", "main"]);
    writeFileSync(join(workspacePath, "collide.txt"), "local untracked\n");

    const result = await service.switchBranch({
      workspacePath,
      targetBranchName: "feature/overwrite-untracked",
    });

    expect(result.ok).toBe(false);
    expect(result.summary.branchName).toBe("main");
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "untracked-changes-would-be-overwritten",
        paths: ["packages/app/collide.txt"],
      }),
    ]);
  });

  it("returns a structured issue when the target branch does not exist", async () => {
    const workspacePath = "/repo/packages/app";
    const switchBranch = vi.fn().mockResolvedValue({
      ok: false,
      action: "switch",
      branchName: "main",
      didChange: false,
      created: false,
      summary: createSummary(),
      issues: [
        {
          code: "target-branch-not-found",
          message: "Target branch was not found",
        },
      ],
    });
    const service = createGitService({
      repo: createMockRepo({ switchBranch }),
    });

    const result = await service.switchBranch({
      workspacePath,
      targetBranchName: "feature/missing-branch",
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ code: "target-branch-not-found" })]);
    expect(switchBranch).toHaveBeenCalledWith(workspacePath, "feature/missing-branch");
  });

  it("returns structured issues for conflicts and in-progress operations before calling git switch", async () => {
    const { repoPath, workspacePath } = await createRepo();
    const service = createGitService();

    runGit(repoPath, ["switch", "-c", "feature/conflict"]);
    writeFileSync(join(workspacePath, "tracked.txt"), "branch version\n");
    runGit(repoPath, ["commit", "-am", "feat: branch conflict change"]);
    runGit(repoPath, ["switch", "main"]);
    writeFileSync(join(workspacePath, "tracked.txt"), "main version\n");
    runGit(repoPath, ["commit", "-am", "feat: main conflict change"]);
    const mergeResult = runGitAllowFailure(repoPath, ["merge", "feature/conflict"]);
    expect(mergeResult.status).not.toBe(0);

    const conflictResult = await service.switchBranch({
      workspacePath,
      targetBranchName: "feature/conflict",
    });
    expect(conflictResult.ok).toBe(false);
    expect(conflictResult.issues).toEqual([expect.objectContaining({ code: "conflicts-present" })]);

    runGit(repoPath, ["merge", "--abort"]);
    const mergeHeadPath = resolveGitPath(
      repoPath,
      runGit(repoPath, ["rev-parse", "--git-path", "MERGE_HEAD"]),
    );
    writeFileSync(mergeHeadPath, "synthetic-merge-head\n");

    const inProgressResult = await service.switchBranch({
      workspacePath,
      targetBranchName: "feature/conflict",
    });
    expect(inProgressResult.ok).toBe(false);
    expect(inProgressResult.issues).toEqual([
      expect.objectContaining({ code: "operation-in-progress" }),
    ]);
  });

  it("creates and switches branches with structured failures for invalid or existing names", async () => {
    const workspacePath = "/repo/packages/app";
    const createBranchAndSwitch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        action: "create-and-switch",
        branchName: "feature/new-branch",
        didChange: true,
        created: true,
        summary: createSummary({ branchName: "feature/new-branch" }),
        issues: [],
      })
      .mockResolvedValueOnce({
        ok: false,
        action: "create-and-switch",
        branchName: "main",
        didChange: false,
        created: false,
        summary: createSummary(),
        issues: [{ code: "invalid-branch-name", message: "Invalid branch" }],
      })
      .mockResolvedValueOnce({
        ok: false,
        action: "create-and-switch",
        branchName: "main",
        didChange: false,
        created: false,
        summary: createSummary(),
        issues: [{ code: "branch-already-exists", message: "Branch exists" }],
      });
    const service = createGitService({
      repo: createMockRepo({ createBranchAndSwitch }),
    });

    const created = await service.createBranchAndSwitch({
      workspacePath,
      branchName: "feature/new-branch",
    });
    expect(created).toMatchObject({
      ok: true,
      action: "create-and-switch",
      branchName: "feature/new-branch",
      didChange: true,
      created: true,
    });
    expect(created.summary.branchName).toBe("feature/new-branch");

    const invalid = await service.createBranchAndSwitch({
      workspacePath,
      branchName: "bad name",
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.issues).toEqual([expect.objectContaining({ code: "invalid-branch-name" })]);

    const existing = await service.createBranchAndSwitch({
      workspacePath,
      branchName: "main",
    });
    expect(existing.ok).toBe(false);
    expect(existing.issues).toEqual([expect.objectContaining({ code: "branch-already-exists" })]);
    expect(createBranchAndSwitch).toHaveBeenNthCalledWith(
      1,
      workspacePath,
      "feature/new-branch",
      undefined,
    );
  });

  it("filters changes to the current workspace scope and exposes summary plus identity", async () => {
    const { repoPath, workspacePath } = await createRepo();
    const service = createGitService();

    writeFileSync(join(workspacePath, "tracked.txt"), "line 1\nline 2 changed\n");
    writeFileSync(join(workspacePath, "staged.txt"), "staged content\n");
    writeFileSync(join(workspacePath, "untracked.txt"), "new file\n");
    mkdirSync(join(workspacePath, ".build"), { recursive: true });
    writeFileSync(join(workspacePath, ".build", "empty-generated.h"), "");
    writeFileSync(join(repoPath, "packages", "other", "skip.txt"), "skip changed\n");
    runGit(repoPath, ["add", "packages/app/staged.txt"]);

    const summary = await service.getRepositorySummary({ workspacePath });
    expect(summary.repoRoot).toBe(runGit(workspacePath, ["rev-parse", "--show-toplevel"]));
    expect(summary.workspaceInRepoPath).toBe("packages/app");
    expect(summary.isDirty).toBe(true);
    expect(summary.isRepository).toBe(true);

    const identity = await service.getIdentity({ workspacePath });
    expect(identity.userName).toBe("ZCode Tester");
    expect(identity.userEmail).toBe("tester@example.com");
    expect(identity.nameSource).toContain(".git/config");
    expect(identity.scopeLabel).toBe("local");

    const unstagedChanges = await service.getChanges({
      workspacePath,
      sourceId: "unstaged",
    });
    expect(
      unstagedChanges.map((change) => `${change.section}:${change.workspaceRelativePath}`).sort(),
    ).toEqual(["unstaged:tracked.txt", "untracked:untracked.txt"]);
    expect(
      unstagedChanges.some((change) => change.repoRelativePath.includes("packages/other")),
    ).toBe(false);
    expect(
      unstagedChanges.some((change) =>
        change.repoRelativePath.endsWith(".build/empty-generated.h"),
      ),
    ).toBe(false);

    const stagedChanges = await service.getChanges({
      workspacePath,
      sourceId: "staged",
    });
    expect(stagedChanges.map((change) => change.workspaceRelativePath)).toEqual(["staged.txt"]);

    const refresh = await service.refresh({
      workspacePath,
      includeIdentity: true,
    });
    expect(refresh.summary.isDirty).toBe(true);
    expect(refresh.identity?.userName).toBe("ZCode Tester");
    expect(
      refresh.unstagedChanges
        .map((change) => `${change.section}:${change.workspaceRelativePath}`)
        .sort(),
    ).toEqual(["unstaged:tracked.txt", "untracked:untracked.txt"]);
    expect(
      refresh.unstagedChanges.some((change) =>
        change.workspaceRelativePath.endsWith(".build/empty-generated.h"),
      ),
    ).toBe(false);
    expect(refresh.stagedChanges.map((change) => change.workspaceRelativePath)).toEqual([
      "staged.txt",
    ]);
    expect(refresh.branchComparison).toBeNull();
  });

  it("supports stage, unstage, discard and commit via the Git service", async () => {
    // Bugfix: this test serially performs multiple real git CLI calls (stage/unstage/discard/commit/status).
    // Under full test parallelism, disk I/O and subprocess scheduling occasionally exceed the default
    // 5 seconds; Vitest then interrupts on timeout, and the afterEach temp-repo cleanup triggers extra
    // unhandled rejections, ultimately blocking pre-push. The timeout is relaxed here only to remove
    // environment jitter; the Git service behavior assertions are unchanged.
    const { workspacePath } = await createRepo();
    const service = createGitService();
    const trackedPath = join(workspacePath, "tracked.txt");
    const commitPath = join(workspacePath, "commit.txt");

    writeFileSync(trackedPath, "line 1\nline 2 changed\n");
    await service.stagePaths({ workspacePath, paths: [trackedPath] });

    let stagedChanges = await service.getChanges({
      workspacePath,
      sourceId: "staged",
    });
    expect(stagedChanges.map((change) => change.workspaceRelativePath)).toEqual(["tracked.txt"]);

    await service.unstagePaths({ workspacePath, paths: [trackedPath] });
    stagedChanges = await service.getChanges({
      workspacePath,
      sourceId: "staged",
    });
    expect(stagedChanges).toEqual([]);

    await service.discardPaths({ workspacePath, paths: [trackedPath] });
    expect(readFileSync(trackedPath, "utf-8")).toBe("line 1\nline 2\n");

    writeFileSync(commitPath, "commit body\n");
    await service.stagePaths({ workspacePath, paths: [commitPath] });
    const commitResult = await service.commit({
      workspacePath,
      message: "feat: add commit file",
    });

    expect(commitResult.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(commitResult.summary.isDirty).toBe(false);
  });

  it("commits only requested paths when a path scope is provided", async () => {
    const workspacePath = "/repo/packages/app";
    const selectedPath = "/repo/packages/app/selected.txt";
    const commit = vi.fn().mockResolvedValue({
      commitHash: "a".repeat(40),
    });
    const getStatus = vi.fn().mockResolvedValue({
      summary: createSummary(),
    });
    const service = createGitService({
      repo: createMockRepo({ commit, getStatus }),
    });

    const result = await service.commit({
      workspacePath,
      message: "feat: commit selected path",
      paths: [selectedPath],
    });

    expect(result.commitHash).toBe("a".repeat(40));
    expect(commit).toHaveBeenCalledWith(
      workspacePath,
      "feat: commit selected path",
      [selectedPath],
      { stagedOnly: undefined },
    );
    expect(getStatus).toHaveBeenCalledWith(workspacePath);
  });

  it("commits only selected staged entries without pulling unstaged content", async () => {
    const { repoPath, workspacePath } = await createRepo();
    const service = createGitService();

    const selectedPath = join(workspacePath, "tracked.txt");
    const selectedNewPath = join(workspacePath, "selected-new.txt");
    const unrelatedPath = join(workspacePath, "unrelated.txt");
    writeFileSync(selectedPath, "selected staged\n");
    writeFileSync(selectedNewPath, "selected new staged\n");
    writeFileSync(unrelatedPath, "unrelated staged\n");
    await service.stagePaths({
      workspacePath,
      paths: [selectedPath, selectedNewPath, unrelatedPath],
    });
    writeFileSync(selectedPath, "selected unstaged\n");

    await service.commit({
      workspacePath,
      message: "fix: commit selected staged entry",
      paths: [selectedPath, selectedNewPath],
      stagedOnly: true,
    });

    expect(runGit(repoPath, ["show", "--name-only", "--format=", "HEAD"])).toBe(
      ["packages/app/selected-new.txt", "packages/app/tracked.txt"].join("\n"),
    );
    expect(runGit(repoPath, ["show", "HEAD:packages/app/tracked.txt"])).toBe("selected staged");
    expect(runGit(repoPath, ["show", "HEAD:packages/app/selected-new.txt"])).toBe(
      "selected new staged",
    );
    expect(readFileSync(selectedPath, "utf-8")).toBe("selected unstaged\n");
    expect(runGit(repoPath, ["diff", "--cached", "--name-only"])).toBe(
      "packages/app/unrelated.txt",
    );
    expect(runGit(repoPath, ["diff", "--name-only"])).toBe("packages/app/tracked.txt");
  });

  it("generates commit messages from staged changes only when unstaged changes are excluded", async () => {
    const { repoPath, workspacePath } = await createRepo();
    let capturedFiles: readonly GitFileChange[] = [];
    const service = createGitService({
      commitMessageGenerator: {
        async generate(params) {
          capturedFiles = params.files;
          return {
            message: "fix(git): test staged generation",
            providerId: "test",
            model: "test-model",
          };
        },
      } as unknown as GitCommitMessageGenerator,
    });

    writeFileSync(join(workspacePath, "staged.txt"), "staged\n");
    writeFileSync(join(workspacePath, "unstaged.txt"), "unstaged\n");
    runGit(repoPath, ["add", "packages/app/staged.txt"]);

    await service.generateCommitMessage({
      workspacePath,
      includeUnstaged: false,
    });

    expect(capturedFiles.map((file) => file.repoRelativePath)).toEqual(["packages/app/staged.txt"]);
    expect(capturedFiles.every((file) => file.section === "staged")).toBe(true);
  });

  it("passes current session conversation context to commit message generation", async () => {
    const { repoPath, workspacePath } = await createRepo();
    let capturedContext: GitCommitMessageConversationContext | undefined;
    const service = createGitService({
      commitMessageGenerator: {
        async generate(params) {
          capturedContext = params.conversationContext;
          return {
            message: "fix(git): include conversation context",
            providerId: "test",
            model: "test-model",
          };
        },
      } as unknown as GitCommitMessageGenerator,
    });
    const conversationContext: GitCommitMessageConversationContext = {
      sessionId: "session-1",
      messages: [
        {
          role: "user",
          content: "生成提交信息的时候要携带当前会话的内容",
        },
      ],
    };

    writeFileSync(join(workspacePath, "staged.txt"), "staged\n");
    runGit(repoPath, ["add", "packages/app/staged.txt"]);

    await service.generateCommitMessage({
      workspacePath,
      conversationContext,
    });

    expect(capturedContext).toEqual(conversationContext);
  });

  it("filters commit message generation to current session files", async () => {
    const { repoPath, workspacePath } = await createRepo();
    let capturedFiles: readonly GitFileChange[] = [];
    let capturedDiffs: readonly GitDiffResult[] = [];
    const service = createGitService({
      commitMessageGenerator: {
        async generate(params) {
          capturedFiles = params.files;
          capturedDiffs = params.diffs;
          return {
            message: "fix(git): scope generation files",
            providerId: "test",
            model: "test-model",
          };
        },
      } as unknown as GitCommitMessageGenerator,
    });

    writeFileSync(join(workspacePath, "session.txt"), "session\n");
    writeFileSync(join(workspacePath, "unrelated.txt"), "unrelated\n");
    runGit(repoPath, ["add", "packages/app/session.txt", "packages/app/unrelated.txt"]);

    await service.generateCommitMessage({
      workspacePath,
      currentSessionFilePaths: [join(workspacePath, "session.txt")],
    });

    expect(capturedFiles.map((file) => file.repoRelativePath)).toEqual([
      "packages/app/session.txt",
    ]);
    expect(capturedDiffs.map((diff) => diff.path).join("\n")).toContain("session.txt");
    expect(capturedDiffs.map((diff) => diff.path).join("\n")).not.toContain("unrelated.txt");
  });

  it("pushes the current branch to its tracked upstream", async () => {
    const workspacePath = "/repo/packages/app";
    const push = vi.fn().mockResolvedValue({
      branchName: "main",
      trackingBranchName: "origin/main",
      remoteName: "origin",
      setUpstream: false,
      summary: createSummary(),
    });
    const service = createGitService({
      repo: createMockRepo({ push }),
    });

    const pushResult = await service.push({ workspacePath });

    expect(pushResult).toMatchObject({
      branchName: "main",
      trackingBranchName: "origin/main",
      remoteName: "origin",
      setUpstream: false,
    });
    expect(pushResult.summary.ahead).toBe(0);
    expect(push).toHaveBeenCalledWith(workspacePath);
  });

  it("returns untracked diffs and branch comparisons against the upstream branch", async () => {
    const { repoPath, workspacePath } = await createRepo({ withRemote: true });
    const service = createGitService();
    const untrackedPath = join(workspacePath, "scratch.txt");

    writeFileSync(untrackedPath, "alpha\nbeta\n");
    const diff = await service.getDiff({
      workspacePath,
      path: untrackedPath,
      sourceId: "unstaged",
    });
    expect(diff.availability).toBe("patch");
    expect(diff.patch).toContain("--- /dev/null");
    expect(diff.patch).toContain("+++ b/packages/app/scratch.txt");
    expect(diff.beforeContent).toBe("");
    expect(diff.afterContent).toBe("alpha\nbeta\n");
    expect(getSingularPatch(diff.patch ?? "")).toMatchObject({
      name: "b/packages/app/scratch.txt",
    });

    runGit(repoPath, ["add", "packages/app/scratch.txt"]);
    const stagedCreatedDiff = await service.getDiff({
      workspacePath,
      path: untrackedPath,
      sourceId: "staged",
    });
    expect(stagedCreatedDiff.availability).toBe("patch");
    expect(stagedCreatedDiff.patch).toContain("--- /dev/null");
    expect(stagedCreatedDiff.beforeContent).toBeNull();
    expect(stagedCreatedDiff.afterContent).toBeNull();
    runGit(repoPath, ["reset", "--", "packages/app/scratch.txt"]);

    writeFileSync(join(workspacePath, "tracked.txt"), "line 1\nline 2\nworktree change\n");
    const unstagedDiff = await service.getDiff({
      workspacePath,
      path: join(workspacePath, "tracked.txt"),
      sourceId: "unstaged",
    });
    expect(unstagedDiff.availability).toBe("patch");
    expect(unstagedDiff.beforeContent).toBe("line 1\nline 2\n");
    expect(unstagedDiff.afterContent).toBe("line 1\nline 2\nworktree change\n");

    writeFileSync(join(workspacePath, "tracked.txt"), "line 1\nline 2\nbranch change\n");
    runGit(repoPath, ["add", "packages/app/tracked.txt"]);
    runGit(repoPath, ["commit", "-m", "feat: branch change"]);

    const branchComparison = await service.getBranchComparison({
      workspacePath,
    });
    expect(branchComparison.baseRef).toBe("origin/main");
    expect(branchComparison.comparisonLabel).toBe("main -> origin/main");
    expect(branchComparison.changes.map((change) => change.workspaceRelativePath)).toContain(
      "tracked.txt",
    );
    expect(
      branchComparison.changes.some((change) => change.repoRelativePath.includes("packages/other")),
    ).toBe(false);

    const branchDiff = await service.getDiff({
      workspacePath,
      path: join(workspacePath, "tracked.txt"),
      sourceId: "branch",
    });
    expect(branchDiff.availability).toBe("patch");
    expect(branchDiff.beforeContent).toBe("line 1\nline 2\n");
    expect(branchDiff.afterContent).toBe("line 1\nline 2\nbranch change\n");
  });
});

describeIfGit("gitService.getWorktreeRemovalPreview", () => {
  it("lists every untracked file that force removal would delete, including binary and large files", async () => {
    const { repoPath } = await createRepo();
    const worktreePath = join(makeTempDir("zcode-git-wt-"), "wt");
    runGit(repoPath, ["worktree", "add", "-b", "wt", worktreePath]);
    writeFileSync(join(worktreePath, "binary.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    writeFileSync(join(worktreePath, "large.txt"), "x".repeat(2 * 1024 * 1024));
    writeFileSync(join(worktreePath, "empty.txt"), "");
    writeFileSync(join(worktreePath, "packages", "app", "tracked.txt"), "changed\n");
    const service = createGitService();

    // The review panel hides zero-stat untracked entries; the deletion preview must not.
    const reviewUntracked = (
      await service.getChanges({ workspacePath: worktreePath, sourceId: "unstaged" })
    ).filter((change) => change.isUntracked);
    expect(reviewUntracked.map((change) => change.repoRelativePath)).not.toContain("binary.dat");

    const preview = await service.getWorktreeRemovalPreview({ workspacePath: worktreePath });
    expect(preview.files).toEqual(
      expect.arrayContaining([
        { path: "binary.dat", status: "??" },
        { path: "large.txt", status: "??" },
        { path: "empty.txt", status: "??" },
        { path: "packages/app/tracked.txt", status: "M" },
      ]),
    );
    expect(preview.files).toHaveLength(4);
  });

  it("returns no files for a clean worktree", async () => {
    const { repoPath } = await createRepo();
    const worktreePath = join(makeTempDir("zcode-git-wt-"), "wt");
    runGit(repoPath, ["worktree", "add", "-b", "wt-clean", worktreePath]);
    const preview = await createGitService().getWorktreeRemovalPreview({
      workspacePath: worktreePath,
    });
    expect(preview).toEqual({ files: [] });
  });

  it("throws for a folder that is not a repository instead of reporting it clean", async () => {
    const plain = makeTempDir("zcode-not-repo-");
    writeFileSync(join(plain, "notes.txt"), "keep me\n");
    await expect(
      createGitService().getWorktreeRemovalPreview({ workspacePath: plain }),
    ).rejects.toThrow(/not a Git repository/);
  });

  it("throws for a missing folder", async () => {
    const missing = join(makeTempDir("zcode-missing-"), "gone");
    await expect(
      createGitService().getWorktreeRemovalPreview({ workspacePath: missing }),
    ).rejects.toThrow(/not a Git repository/);
  });

  it("throws when the path resolves to an enclosing repository rather than the worktree root", async () => {
    const { workspacePath } = await createRepo();
    await expect(createGitService().getWorktreeRemovalPreview({ workspacePath })).rejects.toThrow(
      /not the root/,
    );
  });
});

describe("gitService.getWorktreeRemovalPreview without Git", () => {
  it("throws when Git is unavailable instead of reporting the worktree clean", async () => {
    const resolution = {
      workspacePath: "/wt",
      repoRoot: "/wt",
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [],
      isGitAvailable: false,
      isRepository: false,
    };
    const service = createGitService({
      repo: createMockRepo({
        getStatus: vi.fn(async () => ({
          resolution,
          summary: createSummary({
            workspacePath: "/wt",
            repoRoot: "/wt",
            workspaceInRepoPath: ".",
            isGitAvailable: false,
            isRepository: false,
          }),
          entries: [],
          stagedStats: new Map(),
          unstagedStats: new Map(),
          untrackedStats: new Map(),
        })),
      }),
    });
    await expect(service.getWorktreeRemovalPreview({ workspacePath: "/wt" })).rejects.toThrow(
      /Git is unavailable/,
    );
  });
});
