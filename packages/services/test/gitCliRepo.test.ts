import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GIT_PUSH_OUTPUT_BYTES, DEFAULT_GIT_PUSH_TIMEOUT_MS } from "../src/git/config.js";
import type {
  GitCommandExecutionOptions,
  GitCommandExecutionResult,
  GitCommandProvider,
} from "../src/git/providers/gitCommandProvider.js";
import { createGitService } from "../src/git/gitService.js";
import { createGitCliRepo } from "../src/git/repo/gitCliRepo.js";

const tempDirs: string[] = [];

function createCommandResult(
  options: GitCommandExecutionOptions,
  overrides?: Partial<GitCommandExecutionResult>,
): GitCommandExecutionResult {
  return {
    binaryPath: "git",
    cwd: options.cwd,
    args: options.args,
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    outputTruncated: false,
    ...overrides,
  };
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createMockCommandProvider(): {
  commandProvider: GitCommandProvider;
  run: ReturnType<typeof vi.fn>;
} {
  const run = vi.fn(
    async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
      const command = options.args.join(" ");
      switch (command) {
        case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
          return createCommandResult(options, {
            stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
          });
        case "status --porcelain=v2 --branch --untracked-files=all -z":
          return createCommandResult(options, {
            stdout: "# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0",
          });
        case "diff --cached --numstat -z --find-renames --":
        case "diff --numstat -z --find-renames --":
          return createCommandResult(options);
        case "config --show-scope --show-origin --get user.name":
          return createCommandResult(options, {
            stdout: "local\tfile:.git/config\tZCode Tester\n",
          });
        case "config --show-scope --show-origin --get user.email":
          return createCommandResult(options, {
            stdout: "local\tfile:.git/config\ttester@example.com\n",
          });
        case "push":
          return createCommandResult(options);
        default:
          throw new Error(`Unexpected git command in test: ${command}`);
      }
    },
  );

  return {
    commandProvider: {
      resolveGitBinary: vi.fn().mockResolvedValue("git"),
      run,
    },
    run,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const describeIfGit = gitAvailable ? describe : describe.skip;
// 与 gitCheckpointService.test.ts 相同：真实临时仓库用例会执行多次 Git 子进程，
// 全量并发调度可能超过默认 5 秒，统一保留充足的调度余量。
const GIT_INTEGRATION_TEST_TIMEOUT_MS = 30_000;
const gitLocalEnvVars = gitAvailable
  ? execFileSync("git", ["rev-parse", "--local-env-vars"], {
      encoding: "utf-8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  : [];

function createDetachedGitEnv(): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
  };

  // Bugfix: 测试进程可能携带宿主仓库的 GIT_DIR/GIT_WORK_TREE 等局部变量，
  // 会让临时仓库的辅助命令“串仓”；进入子进程前先清理。
  for (const variableName of gitLocalEnvVars) {
    delete env[variableName];
  }

  return env;
}

function runGit(cwd: string | undefined, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: createDetachedGitEnv(),
  }).trim();
}

function createWorktreeTestRepo(): {
  container: string;
  repoPath: string;
  mainTip: string;
  baseTip: string;
} {
  // 每个用例一个 container：主仓库与 worktree 目标目录都在其中，afterEach 的
  // tempDirs 清理一次回收，避免 sibling worktree 目录残留。
  const container = makeTempDir("zcode-git-worktree-case-");
  const repoPath = join(container, "repo");
  mkdirSync(repoPath);
  runGit(repoPath, ["init"]);
  runGit(repoPath, ["branch", "-M", "main"]);
  runGit(repoPath, ["config", "user.name", "ZCode Tester"]);
  runGit(repoPath, ["config", "user.email", "tester@example.com"]);
  runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  runGit(repoPath, ["config", "core.autocrlf", "false"]);
  runGit(repoPath, ["commit", "--allow-empty", "-m", "chore: initial"]);
  runGit(repoPath, ["switch", "-c", "release"]);
  runGit(repoPath, ["commit", "--allow-empty", "-m", "chore: release base"]);
  runGit(repoPath, ["switch", "main"]);

  return {
    container,
    repoPath,
    mainTip: runGit(repoPath, ["rev-parse", "main"]),
    baseTip: runGit(repoPath, ["rev-parse", "release"]),
  };
}

describe("gitCliRepo", () => {
  it("reuses the in-flight status snapshot for concurrent readers", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    const [left, right] = await Promise.all([
      repo.getStatus(workspacePath),
      repo.getStatus(workspacePath),
    ]);

    expect(left.summary.repoRoot).toBe("/repo");
    expect(right.summary.workspaceInRepoPath).toBe("packages/app");
    expect(run.mock.calls.map(([options]) => options.args.join(" "))).toEqual([
      "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir",
      "status --porcelain=v2 --branch --untracked-files=all -z",
      "diff --cached --numstat -z --find-renames --",
      "diff --numstat -z --find-renames --",
    ]);
  });

  it("详细状态超限后应按 repoRoot 复用未跟踪目录折叠模式", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    run.mockImplementation(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
            });
          case "status --porcelain=v2 --branch --untracked-files=all -z":
            return createCommandResult(options, {
              stdout: "# branch.head main\0? packages/app/.npm/cache/partial-entry\0",
              outputTruncated: true,
            });
          case "status --porcelain=v2 --branch --untracked-files=normal -z":
            return createCommandResult(options, {
              stdout: "# branch.head main\0? packages/app/.npm/\0",
            });
          case "diff --cached --numstat -z --find-renames --":
          case "diff --numstat -z --find-renames --":
            return createCommandResult(options);
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({ commandProvider });
    const service = createGitService({ repo });
    const workspacePath = "/repo/packages/app";

    const first = await repo.getStatus(workspacePath);
    const second = await repo.getStatus(workspacePath);
    const changes = await service.getChanges({ workspacePath, sourceId: "unstaged" });

    expect(first.summary).toMatchObject({ branchName: "main", isDirty: true });
    expect(first.entries.map((entry) => entry.path)).toEqual(["packages/app/.npm/"]);
    expect(second.entries.map((entry) => entry.path)).toEqual(["packages/app/.npm/"]);
    expect(changes).toEqual([
      expect.objectContaining({
        workspaceRelativePath: ".npm/",
        section: "untracked",
        added: 0,
        removed: 0,
      }),
    ]);
    expect(
      run.mock.calls.filter(
        ([options]) =>
          options.args.join(" ") === "status --porcelain=v2 --branch --untracked-files=all -z",
      ),
    ).toHaveLength(1);
    expect(
      run.mock.calls.filter(
        ([options]) =>
          options.args.join(" ") === "status --porcelain=v2 --branch --untracked-files=normal -z",
      ),
    ).toHaveLength(3);
  });

  it("reuses the in-flight repository resolution across status and identity reads", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    const [status, identity] = await Promise.all([
      repo.getStatus(workspacePath),
      repo.getIdentity(workspacePath),
    ]);

    expect(status.summary.repoRoot).toBe("/repo");
    expect(identity.userName).toBe("ZCode Tester");
    expect(
      run.mock.calls.filter(
        ([options]) =>
          options.args.join(" ") ===
          "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir",
      ),
    ).toHaveLength(1);
  });

  it("identifies main-tree workspaces via repoRoot/.git directory", async () => {
    const repoRoot = makeTempDir("zcode-git-main-tree-");
    mkdirSync(join(repoRoot, ".git"));
    const workspacePath = join(repoRoot, "packages", "app");
    mkdirSync(workspacePath, { recursive: true });
    const { commandProvider } = createMockCommandProvider();
    commandProvider.run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            stdout: `${repoRoot}\npackages/app/\n${join(repoRoot, ".git")}\n.git\n`,
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );
    const repo = createGitCliRepo({ commandProvider });

    await expect(repo.getWorkspaceRepositoryInfo(workspacePath)).resolves.toEqual({
      workspacePath,
      kind: "main-tree",
      isGitAvailable: true,
    });
  });

  it("identifies linked worktree workspaces via repoRoot/.git file", async () => {
    const mainTreeRoot = makeTempDir("zcode-git-worktree-main-");
    mkdirSync(join(mainTreeRoot, ".git", "worktrees", "feature"), { recursive: true });
    const worktreeRoot = makeTempDir("zcode-git-worktree-linked-");
    writeFileSync(
      join(worktreeRoot, ".git"),
      `gitdir: ${join(mainTreeRoot, ".git", "worktrees", "feature")}\n`,
      "utf-8",
    );
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: `${worktreeRoot}\n\n${join(mainTreeRoot, ".git", "worktrees", "feature")}\n${join(mainTreeRoot, ".git")}\n`,
            });
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    await expect(repo.getWorkspaceRepositoryInfo(worktreeRoot)).resolves.toEqual({
      workspacePath: worktreeRoot,
      kind: "linked-worktree",
      isGitAvailable: true,
    });
  });

  it("includes worktree gitdir and common gitdir in status auto-refresh watch paths", async () => {
    const worktreeRoot = "/repo-linked";
    const worktreeGitDir = "/repo-main/.git/worktrees/repo-linked";
    const commonGitDir = "/repo-main/.git";
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: `${worktreeRoot}\n\n${worktreeGitDir}\n${commonGitDir}\n`,
            });
          case "status --porcelain=v2 --branch --untracked-files=all -z":
            return createCommandResult(options, {
              stdout: "# branch.head feature\0",
            });
          case "diff --cached --numstat -z --find-renames --":
          case "diff --numstat -z --find-renames --":
            return createCommandResult(options);
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    const status = await repo.getStatus(worktreeRoot);

    expect(status.summary.autoRefreshWatchPaths).toEqual([
      {
        path: worktreeGitDir,
        recursive: true,
      },
      {
        path: commonGitDir,
        recursive: true,
      },
    ]);
  });

  it("resolves a relative common git dir from the workspace command cwd", async () => {
    // Root cause: this is the only test exercising the "relative --git-common-dir + host resolve()" branch;
    // the others do literal comparisons. The assertion used to use the POSIX literal "/root/.git", but
    // resolve("/root/demo-project","../.git") yields "C:\root\.git" on win32 — the two differ, dedup
    // fails, and the watch path ends up with an extra entry. Build the fixture with the host path module
    // so the assertion expresses the same ".git under the repo root" on all three platforms.
    const repoRoot = resolve("/root");
    const workspacePath = join(repoRoot, "demo-project");
    const absoluteGitDir = join(repoRoot, ".git");
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            stdout: `${repoRoot}\ndemo-project/\n${absoluteGitDir}\n../.git\n`,
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    const resolution = await repo.resolveRepository(workspacePath);

    expect(resolution.autoRefreshWatchPaths).toEqual([
      {
        path: absoluteGitDir,
        recursive: true,
      },
    ]);
  });

  it("normalizes long Git paths with trailing separators", async () => {
    const separators = "/".repeat(100_000);
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        if (options.args[0] === "rev-parse") {
          return createCommandResult(options, {
            stdout: `/repo\n\n/repo/.git${separators}\n/repo/.git${separators}\n`,
          });
        }
        if (options.args.join(" ") === "worktree list --porcelain -z") {
          return createCommandResult(options, {
            stdout: `worktree /repo${separators}\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0`,
          });
        }
        throw new Error(`Unexpected git command in test: ${options.args.join(" ")}`);
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    const resolved = await repo.resolveRepository("/repo");
    const worktrees = await repo.listWorktrees("/repo");

    expect(resolved.autoRefreshWatchPaths).toEqual([{ path: "/repo/.git", recursive: true }]);
    expect(worktrees.worktrees[0]?.isCurrent).toBe(true);
  });

  it("treats spawn git ENOENT during repository resolution as not-repository", async () => {
    const workspacePath = "/missing/worktree-path";
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            exitCode: -2,
            stderr: "spawn git ENOENT",
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    await expect(repo.getWorkspaceRepositoryInfo(workspacePath)).resolves.toEqual({
      workspacePath,
      kind: "not-repository",
      isGitAvailable: true,
    });
  });

  it("uses the dedicated long timeout and larger output budget for push hooks", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    await repo.push(workspacePath);

    const pushCall = run.mock.calls.find(([options]) => options.args.join(" ") === "push");
    expect(pushCall?.[0].timeoutMs).toBe(DEFAULT_GIT_PUSH_TIMEOUT_MS);
    expect(pushCall?.[0].maxOutputBytes).toBe(DEFAULT_GIT_PUSH_OUTPUT_BYTES);
  });

  it("checks ignored paths from argv without using incompatible -z output", async () => {
    const { commandProvider, run } = createMockCommandProvider();
    const repo = createGitCliRepo({ commandProvider });
    const workspacePath = "/repo/packages/app";

    run.mockImplementation(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        if (
          command === "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir"
        ) {
          return createCommandResult(options, {
            stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
          });
        }
        if (command === "check-ignore -- packages/app/.env packages/app/src/index.ts") {
          return createCommandResult(options, {
            stdout: "packages/app/.env\n",
          });
        }
        throw new Error(`Unexpected git command in test: ${command}`);
      },
    );

    await expect(
      repo.getIgnoredPaths(workspacePath, [
        "/repo/packages/app/.env",
        "/repo/packages/app/src/index.ts",
      ]),
    ).resolves.toEqual(["/repo/packages/app/.env"]);
  });

  it("keeps a valid unstaged patch when the working-tree content cannot be read", async () => {
    const workspacePath = "/repo/packages/app";
    const filePath = "/repo/packages/app/index.vue";
    const patch = [
      "diff --git a/packages/app/index.vue b/packages/app/index.vue",
      "index 1111111..2222222 100644",
      "--- a/packages/app/index.vue",
      "+++ b/packages/app/index.vue",
      "@@ -1,2 +1,3 @@",
      " <template>",
      "+  <SearchSelect />",
      " </template>",
      "",
    ].join("\n");
    const run = vi.fn(
      async (options: GitCommandExecutionOptions): Promise<GitCommandExecutionResult> => {
        const command = options.args.join(" ");
        switch (command) {
          case "rev-parse --show-toplevel --show-prefix --absolute-git-dir --git-common-dir":
            return createCommandResult(options, {
              stdout: "/repo\npackages/app/\n/repo/.git\n.git\n",
            });
          case "diff --no-ext-diff --no-color --binary -- packages/app/index.vue":
            return createCommandResult(options, { stdout: patch });
          case "show :packages/app/index.vue":
            return createCommandResult(options, {
              stdout: "<template>\n</template>\n",
            });
          default:
            throw new Error(`Unexpected git command in test: ${command}`);
        }
      },
    );
    const repo = createGitCliRepo({
      commandProvider: {
        resolveGitBinary: vi.fn().mockResolvedValue("git"),
        run,
      },
    });

    await expect(
      repo.getDiff({
        workspacePath,
        path: filePath,
        sourceId: "unstaged",
      }),
    ).resolves.toEqual({
      path: filePath,
      availability: "patch",
      patch,
      beforeContent: null,
      afterContent: null,
      summary: null,
    });
  });
});

describeIfGit("gitCliRepo worktree operations", () => {
  it(
    "resolves worktree path identities across symlink and trailing-separator aliases",
    async () => {
      const { container, repoPath } = createWorktreeTestRepo();
      const aliasPath = join(container, "repo-alias");
      symlinkSync(repoPath, aliasPath, process.platform === "win32" ? "junction" : "dir");
      const repo = createGitCliRepo();

      const identities = await repo.resolveWorktreePathIdentities([
        repoPath,
        aliasPath,
        `${repoPath}${process.platform === "win32" ? "\\" : "/"}`,
      ]);

      expect(identities[1]).toBe(identities[0]);
      expect(identities[2]).toBe(identities[0]);
      await expect(repo.resolveWorktreePathIdentities(["relative/path"])).rejects.toThrow(
        "Worktree path identity requires an absolute path",
      );
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "lists the main worktree only for a plain repository",
    async () => {
      const { repoPath, mainTip } = createWorktreeTestRepo();
      const repo = createGitCliRepo();

      const result = await repo.listWorktrees(repoPath);

      expect(result.isGitAvailable).toBe(true);
      expect(result.isRepository).toBe(true);
      expect(result.worktrees).toHaveLength(1);
      expect(result.worktrees[0]).toMatchObject({
        // porcelain 输出的是规范化后的绝对路径（macOS 上 /var -> /private/var）。
        path: realpathSync(repoPath),
        headCommitHash: mainTip,
        branchName: "main",
        isMain: true,
        isBare: false,
        isDetached: false,
        isCurrent: true,
      });
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "lists linked worktrees with path and branch after creation",
    async () => {
      const { container, repoPath, baseTip } = createWorktreeTestRepo();
      const repo = createGitCliRepo();
      const linkedPath = join(container, "linked");

      const created = await repo.createWorktree(repoPath, "feature", linkedPath, "release");
      expect(created).toEqual({
        ok: true,
        worktreePath: linkedPath,
        branchName: "feature",
        issues: [],
      });

      // 直接经 Git 创建 detached worktree，覆盖解析器的 detached 分支。
      runGit(repoPath, ["worktree", "add", "--detach", join(container, "detached")]);

      const result = await repo.listWorktrees(repoPath);
      expect(result.worktrees).toHaveLength(3);
      // 主工作树固定排在首位，但关联 worktree 的顺序没有契约；按路径查找条目。
      const findByPath = (path: string) =>
        result.worktrees.find((entry) => entry.path === realpathSync(path));
      const main = findByPath(repoPath);
      const linked = findByPath(linkedPath);
      const detached = findByPath(join(container, "detached"));
      expect(main).toMatchObject({
        path: realpathSync(repoPath),
        branchName: "main",
        isMain: true,
        isCurrent: true,
        isDetached: false,
      });
      expect(linked).toMatchObject({
        path: realpathSync(linkedPath),
        headCommitHash: baseTip,
        branchName: "feature",
        isMain: false,
        isCurrent: false,
        isDetached: false,
      });
      expect(detached).toMatchObject({
        path: realpathSync(join(container, "detached")),
        branchName: null,
        isDetached: true,
        isCurrent: false,
      });

      // isCurrent 跟随发起请求的 workspace 所在的 worktree。
      const fromLinked = await repo.listWorktrees(linkedPath);
      expect(fromLinked.worktrees.find((entry) => entry.branchName === "feature")?.isCurrent).toBe(
        true,
      );
      expect(fromLinked.worktrees.find((entry) => entry.branchName === "main")?.isCurrent).toBe(
        false,
      );
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "preserves worktree paths containing non-ASCII characters and newlines",
    async () => {
      const { container, repoPath } = createWorktreeTestRepo();
      const repo = createGitCliRepo();
      const linkedPath = join(container, "linked café\nworktree");

      const created = await repo.createWorktree(
        repoPath,
        "feature/path-record",
        linkedPath,
        "release",
      );
      expect(created.ok).toBe(true);

      const result = await repo.listWorktrees(repoPath);
      expect(
        result.worktrees.find((entry) => entry.branchName === "feature/path-record")?.path,
      ).toBe(realpathSync(linkedPath));
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "creates the worktree directory and branch from the base branch",
    async () => {
      const { container, repoPath, mainTip, baseTip } = createWorktreeTestRepo();
      const repo = createGitCliRepo();
      const worktreePath = join(container, "wt-feature");

      const created = await repo.createWorktree(repoPath, "feature", worktreePath, "release");

      expect(created.ok).toBe(true);
      expect(statSync(worktreePath).isDirectory()).toBe(true);
      expect(runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature");
      expect(runGit(worktreePath, ["rev-parse", "HEAD"])).toBe(baseTip);
      runGit(repoPath, ["show-ref", "--verify", "refs/heads/feature"]);

      // 缺省 base 时从当前 HEAD（main）创建。
      const defaultBasePath = join(container, "wt-default");
      const defaultCreated = await repo.createWorktree(repoPath, "no-base", defaultBasePath);
      expect(defaultCreated.ok).toBe(true);
      expect(runGit(defaultBasePath, ["rev-parse", "HEAD"])).toBe(mainTip);
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "classifies a branch already checked out in another worktree",
    async () => {
      const { container, repoPath } = createWorktreeTestRepo();
      const repo = createGitCliRepo();
      await repo.createWorktree(repoPath, "feature", join(container, "wt-a"), "release");

      const blocked = await repo.createWorktree(
        repoPath,
        "feature",
        join(container, "wt-b"),
        "release",
      );

      expect(blocked.ok).toBe(false);
      expect(blocked.worktreePath).toBeNull();
      expect(blocked.issues).toEqual([
        expect.objectContaining({ code: "branch-in-other-worktree" }),
      ]);
      expect(existsSync(join(container, "wt-b"))).toBe(false);
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "rejects an existing target path",
    async () => {
      const { container, repoPath } = createWorktreeTestRepo();
      const existingPath = join(container, "existing");
      mkdirSync(existingPath);
      const repo = createGitCliRepo();

      const blocked = await repo.createWorktree(repoPath, "fresh", existingPath);

      expect(blocked.ok).toBe(false);
      expect(blocked.issues).toEqual([expect.objectContaining({ code: "target-path-exists" })]);
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "rejects invalid branch names and non-absolute target paths",
    async () => {
      const { container, repoPath } = createWorktreeTestRepo();
      const repo = createGitCliRepo();

      const invalidBranch = await repo.createWorktree(
        repoPath,
        "bad..name",
        join(container, "wt-invalid"),
      );
      expect(invalidBranch.ok).toBe(false);
      expect(invalidBranch.issues).toEqual([
        expect.objectContaining({ code: "invalid-branch-name" }),
      ]);

      const emptyBranch = await repo.createWorktree(repoPath, "  ", join(container, "wt-empty"));
      expect(emptyBranch.issues[0]?.code).toBe("invalid-branch-name");

      const relativeTarget = await repo.createWorktree(repoPath, "valid-name", "relative/path");
      expect(relativeTarget.issues[0]?.code).toBe("target-path-invalid");
      expect(existsSync(join(container, "wt-invalid"))).toBe(false);
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "returns an empty result outside a repository",
    async () => {
      const container = makeTempDir("zcode-git-worktree-norepo-");
      const repo = createGitCliRepo();

      const list = await repo.listWorktrees(container);
      expect(list).toEqual({
        isGitAvailable: true,
        isRepository: false,
        worktrees: [],
      });

      const blocked = await repo.createWorktree(container, "feature", join(container, "wt"));
      expect(blocked.ok).toBe(false);
      expect(blocked.issues).toEqual([expect.objectContaining({ code: "not-a-repository" })]);

      const removeBlocked = await repo.removeWorktree(container, join(container, "wt"));
      expect(removeBlocked.ok).toBe(false);
      expect(removeBlocked.issues).toEqual([expect.objectContaining({ code: "not-a-repository" })]);

      const pruneBlocked = await repo.pruneWorktrees(container);
      expect(pruneBlocked.ok).toBe(false);
      expect(pruneBlocked.prunedCount).toBe(0);
      expect(pruneBlocked.issues).toEqual([expect.objectContaining({ code: "not-a-repository" })]);
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "removes a clean linked worktree and rejects main/foreign paths",
    async () => {
      const { container, repoPath } = createWorktreeTestRepo();
      const repo = createGitCliRepo();
      const linkedPath = join(container, "linked");
      expect((await repo.createWorktree(repoPath, "feature", linkedPath, "release")).ok).toBe(true);

      // The main worktree path is refused even though it is a valid worktree of the repo.
      const mainRemove = await repo.removeWorktree(repoPath, repoPath);
      expect(mainRemove.ok).toBe(false);
      expect(mainRemove.issues[0]?.code).toBe("worktree-not-found");

      // A path outside the repository's worktrees is refused as well.
      const foreignRemove = await repo.removeWorktree(repoPath, join(container, "foreign"));
      expect(foreignRemove.ok).toBe(false);
      expect(foreignRemove.issues[0]?.code).toBe("worktree-not-found");

      const removed = await repo.removeWorktree(repoPath, linkedPath);
      expect(removed).toEqual({ ok: true, issues: [] });
      expect(existsSync(linkedPath)).toBe(false);

      const list = await repo.listWorktrees(repoPath);
      expect(list.worktrees).toHaveLength(1);
      expect(list.worktrees[0]?.isMain).toBe(true);
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "reports worktree-dirty without force and removes with force",
    async () => {
      const { container, repoPath } = createWorktreeTestRepo();
      const repo = createGitCliRepo();
      const linkedPath = join(container, "dirty");
      expect((await repo.createWorktree(repoPath, "feature", linkedPath, "release")).ok).toBe(true);
      writeFileSync(join(linkedPath, "scratch.txt"), "uncommitted\n");

      const dirtyRemove = await repo.removeWorktree(repoPath, linkedPath);
      expect(dirtyRemove.ok).toBe(false);
      expect(dirtyRemove.issues[0]?.code).toBe("worktree-dirty");
      expect(existsSync(linkedPath)).toBe(true);

      const forcedRemove = await repo.removeWorktree(repoPath, linkedPath, true);
      expect(forcedRemove.ok).toBe(true);
      expect(existsSync(linkedPath)).toBe(false);
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "classifies locked worktrees and removes them with two force flags",
    async () => {
      const { container, repoPath } = createWorktreeTestRepo();
      const repo = createGitCliRepo();
      const linkedPath = join(container, "locked");
      expect((await repo.createWorktree(repoPath, "feature", linkedPath, "release")).ok).toBe(true);
      runGit(repoPath, ["worktree", "lock", "--reason", "test lock", linkedPath]);

      const lockedRemove = await repo.removeWorktree(repoPath, linkedPath);
      expect(lockedRemove.ok).toBe(false);
      expect(lockedRemove.issues[0]?.code).toBe("worktree-locked");

      const forcedRemove = await repo.removeWorktree(repoPath, linkedPath, true);
      expect(forcedRemove).toEqual({ ok: true, issues: [] });
      expect(existsSync(linkedPath)).toBe(false);
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "prunes stale records after the worktree directory is deleted by hand",
    async () => {
      const { container, repoPath } = createWorktreeTestRepo();
      const repo = createGitCliRepo();
      const linkedPath = join(container, "linked");
      expect((await repo.createWorktree(repoPath, "feature", linkedPath, "release")).ok).toBe(true);
      rmSync(linkedPath, { recursive: true, force: true });

      // Before the prune the stale record is still listed…
      const staleList = await repo.listWorktrees(repoPath);
      expect(staleList.worktrees.find((entry) => entry.branchName === "feature")).toBeDefined();

      const pruned = await repo.pruneWorktrees(repoPath);
      expect(pruned.ok).toBe(true);
      expect(pruned.prunedCount).toBeGreaterThanOrEqual(1);

      // …and gone after it.
      const cleanList = await repo.listWorktrees(repoPath);
      expect(cleanList.worktrees).toHaveLength(1);

      // A clean repository reports zero pruned records.
      const idle = await repo.pruneWorktrees(repoPath);
      expect(idle).toEqual({ ok: true, prunedCount: 0, issues: [] });
    },
    GIT_INTEGRATION_TEST_TIMEOUT_MS,
  );
});
