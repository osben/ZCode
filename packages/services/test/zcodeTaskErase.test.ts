import { describe, expect, it, vi } from "vitest";
import type { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import { createTaskEraseOperations } from "../src/zcode-agent/zcodeTaskErase.js";

// specs/session-deletion-cascade.md §3-§4: erase acts only on hidden tasks, never writes the task index,
// and degrades to "unsupported" (null) instead of failing.

const counts = (total: number) => ({
  total,
  sideChats: 0,
  subagents: 0,
  workflowSessions: 0,
  workflowRuns: 0,
  running: 0,
});

function setup(options: {
  hidden: string[];
  /** Hidden tasks per workspace; overrides `hidden` (which maps to /work/a). */
  hiddenByWorkspace?: Record<string, string[]>;
  /** Workspaces that already have a runtime; a call with existing-only for any other one rejects. */
  runtimes?: string[];
  erase?: (ids: string[]) => {
    erasedSessionIds: string[];
    blockedRunningSessionIds: string[];
    fileFailureCount: number;
    filesRetainedCount: number;
  } | null;
  count?: (ids: string[]) => ReturnType<typeof counts> | null;
  taskMetas?: Array<{
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    deleted: boolean;
    executionWorktree?: { path: string; branchName?: string };
  }>;
  openPaths?: string[];
  openInventoryFails?: boolean;
  preparations?: Array<{ targetPath: string; status: "preparing" | "failed" | "cancelled" }>;
  removeWorktree?: (workspacePath: string, targetPath: string) => { ok: boolean };
  repoRoots?: Record<string, string>;
}) {
  const repo = {
    listDeletedTaskIds: vi.fn(async () => options.hidden),
    scrubDeletedTaskContent: vi.fn(async () => undefined),
    listLocalDeletedTaskRefs: vi.fn(async () =>
      Object.entries(options.hiddenByWorkspace ?? { "/work/a": options.hidden }).flatMap(
        ([workspacePath, taskIds]) => taskIds.map((taskId) => ({ workspacePath, taskId })),
      ),
    ),
    listLocalWorktreeOwnerFacts: vi.fn(async () => options.taskMetas ?? []),
  } as unknown as TaskIndexRepo;
  const requireRuntime = (params: { workspacePath: string; runtimePolicy?: string }) => {
    if (
      params.runtimePolicy === "existing-only" &&
      options.runtimes &&
      !options.runtimes.includes(params.workspacePath)
    ) {
      throw new Error("runtime unavailable");
    }
  };
  const agent = {
    eraseSessionTrees: vi.fn(
      async (params: { sessionIds: string[]; workspacePath: string; runtimePolicy?: string }) => {
        requireRuntime(params);
        return options.erase
          ? options.erase(params.sessionIds)
          : {
              erasedSessionIds: params.sessionIds,
              blockedRunningSessionIds: [],
              fileFailureCount: 0,
              filesRetainedCount: 0,
            };
      },
    ),
    countSessionTrees: vi.fn(
      async (params: { sessionIds: string[]; workspacePath: string; runtimePolicy?: string }) => {
        requireRuntime(params);
        return options.count ? options.count(params.sessionIds) : counts(params.sessionIds.length);
      },
    ),
  } as unknown as IZCodeAgentService;
  const gitService = {
    resolveWorktreePathIdentities: vi.fn(async ({ paths }: { paths: string[] }) => paths),
    getRepositorySummary: vi.fn(async ({ workspacePath }: { workspacePath: string }) => ({
      workspacePath,
      repoRoot: options.repoRoots?.[workspacePath] ?? "/repo",
      isRepository: true,
    })),
    removeWorktree: vi.fn(
      async ({ workspacePath, targetPath }: { workspacePath: string; targetPath: string }) =>
        options.removeWorktree?.(workspacePath, targetPath) ?? { ok: true },
    ),
  };
  const taskIndexSyncer = {
    listWorktreePreparations: vi.fn(async () => options.preparations ?? []),
  };
  const operations = createTaskEraseOperations({
    agent,
    taskIndexRepo: repo,
    provider: "glm",
    gitService: gitService as never,
    getOpenWorkspacePaths: async () => {
      if (options.openInventoryFails) throw new Error("inventory unavailable");
      return options.openPaths ?? [];
    },
    taskIndexSyncer: taskIndexSyncer as never,
  });
  return { operations, agent, repo, gitService };
}

const emptyWorktreeCleanup = {
  removed: [],
  retained: [],
  failed: [],
  removedCount: 0,
  retainedCount: 0,
  failedCount: 0,
};

const workspace = { workspacePath: "/work/a" };

describe("createTaskEraseOperations", () => {
  it("erases only tasks that already carry a tombstone and reports the rest as skipped", async () => {
    const { operations, agent } = setup({ hidden: ["t1", "t2"] });
    const result = await operations.eraseTasks({ ...workspace, taskIds: ["t1", "visible", "t2"] });
    expect(result).toEqual({
      erasedTaskIds: ["t1", "t2"],
      skippedTaskIds: ["visible"],
      blockedRunningTaskIds: [],
      failedTaskIds: [],
      fileFailureCount: 0,
      filesRetainedCount: 0,
      worktreeCleanup: emptyWorktreeCleanup,
    });
    expect(agent.eraseSessionTrees).toHaveBeenCalledTimes(1);
    expect(agent.eraseSessionTrees).toHaveBeenCalledWith({
      workspacePath: "/work/a",
      sessionIds: ["t1", "t2"],
      runtimePolicy: "start-if-needed",
    });
  });

  it("never reaches the agent for remote workspaces", async () => {
    const { operations, agent } = setup({ hidden: ["t1"] });
    await expect(
      operations.eraseTasks({ ...workspace, workspaceIdentity: "ssh://host", taskIds: ["t1"] }),
    ).resolves.toBeNull();
    await expect(
      operations.countTaskTrees({ ...workspace, workspaceIdentity: "ssh://host", taskIds: ["t1"] }),
    ).resolves.toBeNull();
    expect(agent.eraseSessionTrees).not.toHaveBeenCalled();
    expect(agent.countSessionTrees).not.toHaveBeenCalled();
    await expect(
      operations.getDeletionCapability({ ...workspace, workspaceIdentity: "ssh://host" }),
    ).resolves.toEqual({
      supported: false,
    });
  });

  it("probes peer support instead of treating method presence as capability", async () => {
    const { operations, agent } = setup({ hidden: [] });
    await expect(operations.getDeletionCapability(workspace)).resolves.toEqual({ supported: true });
    expect(agent.countSessionTrees).toHaveBeenCalledWith({
      workspacePath: workspace.workspacePath,
      sessionIds: ["__zcode_deletion_capability_probe__"],
      runtimePolicy: "existing-only",
    });

    // No live runtime: existing-only rejects, so the probe retries once with start-if-needed.
    vi.mocked(agent.countSessionTrees!).mockRejectedValueOnce(new Error("no runtime"));
    await expect(operations.getDeletionCapability(workspace)).resolves.toEqual({ supported: true });
    expect(agent.countSessionTrees).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimePolicy: "start-if-needed" }),
    );

    vi.mocked(agent.countSessionTrees!).mockResolvedValueOnce(null);
    await expect(operations.getDeletionCapability(workspace)).resolves.toEqual({
      supported: false,
    });
  });

  it("retries root by root when a running session blocks the chunk", async () => {
    const { operations, agent } = setup({
      hidden: ["t1", "t2", "t3"],
      erase: (ids) =>
        ids.length > 1 || ids[0] === "t2"
          ? {
              erasedSessionIds: [],
              blockedRunningSessionIds: ["t2"],
              fileFailureCount: 0,
              filesRetainedCount: 0,
            }
          : {
              erasedSessionIds: ids,
              blockedRunningSessionIds: [],
              fileFailureCount: 2,
              filesRetainedCount: 1,
            },
    });
    const result = await operations.eraseTasks({ ...workspace, taskIds: ["t1", "t2", "t3"] });
    expect(result).toMatchObject({
      erasedTaskIds: ["t1", "t3"],
      blockedRunningTaskIds: ["t2"],
      fileFailureCount: 4,
    });
    expect(agent.eraseSessionTrees).toHaveBeenCalledTimes(4);
  });

  it("returns null when the connected CLI does not support the method", async () => {
    const { operations } = setup({ hidden: ["t1"], erase: () => null, count: () => null });
    await expect(operations.eraseTasks({ ...workspace, taskIds: ["t1"] })).resolves.toBeNull();
    await expect(operations.countTaskTrees({ ...workspace, taskIds: ["t1"] })).resolves.toBeNull();
    await expect(operations.countHiddenTaskContent()).resolves.toBeNull();
    await expect(operations.eraseHiddenTaskContent()).resolves.toBeNull();
  });

  it("marks a failed request's tasks as failed without losing the rest of the batch", async () => {
    const { operations, agent } = setup({ hidden: ["t1"] });
    vi.mocked(agent.eraseSessionTrees!).mockRejectedValueOnce(new Error("agent exited"));
    const result = await operations.eraseTasks({ ...workspace, taskIds: ["t1"] });
    expect(result).toMatchObject({ erasedTaskIds: [], failedTaskIds: ["t1"] });
  });

  it("counts and erases the hidden content of local workspaces", async () => {
    const { operations, agent } = setup({
      hidden: ["t1", "t2"],
      count: (ids) => counts(ids.length + 3),
    });
    await expect(operations.countHiddenTaskContent()).resolves.toEqual({
      sessions: 5,
      worktrees: 0,
    });
    const result = await operations.eraseHiddenTaskContent();
    expect(result).toMatchObject({ erasedTaskIds: ["t1", "t2"], failedTaskIds: [] });
    expect(agent.eraseSessionTrees).toHaveBeenCalledWith({
      workspacePath: "/work/a",
      sessionIds: ["t1", "t2"],
      runtimePolicy: "existing-only",
    });
  });

  it("sums tree counts across id chunks", async () => {
    const ids = Array.from({ length: 1500 }, (_, index) => `t${index}`);
    const { operations, agent } = setup({ hidden: ids });
    await expect(operations.countTaskTrees({ ...workspace, taskIds: ids })).resolves.toMatchObject({
      total: 1500,
    });
    expect(agent.countSessionTrees).toHaveBeenCalledTimes(2);
  });

  it("counts hidden content through one existing runtime instead of starting one per workspace", async () => {
    const { operations, agent } = setup({
      hidden: [],
      hiddenByWorkspace: { "/work/a": ["a1"], "/work/b": ["b1", "b2"], "/work/gone": ["g1"] },
      runtimes: ["/work/b"],
    });
    await expect(operations.countHiddenTaskContent()).resolves.toEqual({
      sessions: 4,
      worktrees: 0,
    });
    const calls = vi.mocked(agent.countSessionTrees!).mock.calls.map(([params]) => params);
    // /work/a has no runtime (existing-only rejects), /work/b has one and answers for every id.
    expect(calls.map((params) => params.workspacePath)).toEqual(["/work/a", "/work/b"]);
    expect(calls.every((params) => params.runtimePolicy === "existing-only")).toBe(true);
    expect(calls[1]!.sessionIds).toEqual(["a1", "b1", "b2", "g1"]);
  });

  it("starts exactly one agent when no workspace has a runtime, and counts every tombstone", async () => {
    const { operations, agent } = setup({
      hidden: [],
      hiddenByWorkspace: { "/work/a": ["a1"], "/work/gone": ["g1"] },
      runtimes: [],
    });
    await expect(operations.countHiddenTaskContent()).resolves.toEqual({
      sessions: 2,
      worktrees: 0,
    });
    const started = vi
      .mocked(agent.countSessionTrees!)
      .mock.calls.filter(([params]) => params.runtimePolicy !== "existing-only");
    expect(started).toHaveLength(1);
    expect(started[0]![0].sessionIds).toEqual(["a1", "g1"]);
  });

  it("erases hidden content with live runtimes first and one shared client for the rest", async () => {
    const { operations, agent } = setup({
      hidden: [],
      hiddenByWorkspace: { "/work/a": ["a1"], "/work/b": ["b1"], "/work/gone": ["g1"] },
      runtimes: ["/work/b"],
    });
    const result = await operations.eraseHiddenTaskContent();
    expect(result).toMatchObject({
      erasedTaskIds: expect.arrayContaining(["a1", "b1", "g1"]),
      failedTaskIds: [],
    });
    const started = vi
      .mocked(agent.eraseSessionTrees!)
      .mock.calls.filter(([params]) => params.runtimePolicy !== "existing-only");
    // Both runtime-less workspaces are served by one started client (one workspace scope), not one each.
    expect(new Set(started.map(([params]) => params.workspacePath)).size).toBe(1);
    expect(started.flatMap(([params]) => params.sessionIds)).toEqual(["a1", "g1"]);
  });

  it("scrubs the task-index text of every erased task, under the task's own workspace", async () => {
    const { operations, repo } = setup({ hidden: ["t1", "t2"] });
    await operations.eraseTasks({ ...workspace, taskIds: ["t1", "t2"] });
    expect(repo.scrubDeletedTaskContent).toHaveBeenCalledWith({
      workspacePath: "/work/a",
      workspaceIdentity: undefined,
      taskIds: ["t1", "t2"],
    });
  });

  it("scrubs hidden content under the owning workspace even when a shared client answered", async () => {
    const { operations, repo } = setup({
      hidden: [],
      hiddenByWorkspace: { "/work/a": ["a1"], "/work/gone": ["g1"] },
      runtimes: [],
    });
    await operations.eraseHiddenTaskContent();
    const scrubbed = vi
      .mocked(repo.scrubDeletedTaskContent)
      .mock.calls.map(([params]) => [params.workspacePath, params.taskIds]);
    expect(scrubbed).toEqual([
      ["/work/a", ["a1"]],
      ["/work/gone", ["g1"]],
    ]);
  });

  it("treats a file-removal failure as a retryable failure and scrubs nothing", async () => {
    const { operations, repo } = setup({
      hidden: ["t1"],
      erase: () => ({
        erasedSessionIds: [],
        blockedRunningSessionIds: [],
        fileFailureCount: 2,
        filesRetainedCount: 0,
      }),
    });
    const result = await operations.eraseTasks({ ...workspace, taskIds: ["t1"] });
    expect(result).toMatchObject({
      erasedTaskIds: [],
      failedTaskIds: ["t1"],
      fileFailureCount: 2,
    });
    expect(repo.scrubDeletedTaskContent).not.toHaveBeenCalled();
  });

  it("retries root by root after a file failure and keeps the clean roots erased", async () => {
    const { operations } = setup({
      hidden: ["t1", "t2"],
      erase: (ids) =>
        ids.length > 1 || ids[0] === "t2"
          ? {
              erasedSessionIds: [],
              blockedRunningSessionIds: [],
              fileFailureCount: 1,
              filesRetainedCount: 0,
            }
          : {
              erasedSessionIds: ids,
              blockedRunningSessionIds: [],
              fileFailureCount: 0,
              filesRetainedCount: 0,
            },
    });
    const result = await operations.eraseTasks({ ...workspace, taskIds: ["t1", "t2"] });
    expect(result).toMatchObject({ erasedTaskIds: ["t1"], failedTaskIds: ["t2"] });
  });

  it("removes a deleted task's registered execution worktree after its content is erased", async () => {
    const { operations, gitService } = setup({
      hidden: ["t1"],
      count: () => counts(0),
      taskMetas: [
        {
          taskId: "t1",
          workspacePath: "/repo",
          deleted: true,
          executionWorktree: { path: "/repo/.worktrees/task-1", branchName: "task-1" },
        },
      ],
    });
    const result = await operations.eraseTasks({ ...workspace, taskIds: ["t1"] });
    expect(result?.worktreeCleanup).toEqual({
      removed: ["/repo/.worktrees/task-1"],
      retained: [],
      failed: [],
      removedCount: 1,
      retainedCount: 0,
      failedCount: 0,
    });
    expect(gitService.removeWorktree).toHaveBeenCalledWith({
      workspacePath: "/repo",
      targetPath: "/repo/.worktrees/task-1",
      force: true,
    });
  });

  it.each([
    [
      "surviving archived task",
      {
        taskId: "owner",
        workspacePath: "/repo",
        deleted: false,
        executionWorktree: { path: "/repo/.worktrees/shared" },
      },
    ],
    ["noncancelled preparation", null],
  ])("retains a shared worktree with a %s", async (label, survivingTask) => {
    const taskMetas = [
      {
        taskId: "deleted",
        workspacePath: "/repo",
        deleted: true,
        executionWorktree: { path: "/repo/.worktrees/shared" },
      },
      ...(survivingTask ? [survivingTask] : []),
    ];
    const { operations, gitService } = setup({
      hidden: ["deleted"],
      taskMetas,
      preparations:
        label === "noncancelled preparation"
          ? [{ targetPath: "/repo/.worktrees/shared", status: "preparing" }]
          : [],
    });
    const result = await operations.eraseTasks({ ...workspace, taskIds: ["deleted"] });
    expect(result?.worktreeCleanup.retained).toHaveLength(1);
    expect(gitService.removeWorktree).not.toHaveBeenCalled();
  });

  it("retains a target open in another window and fails closed when the inventory is unavailable", async () => {
    const facts = [
      {
        taskId: "deleted",
        workspacePath: "/repo",
        deleted: true,
        executionWorktree: { path: "/repo/.worktrees/task-1" },
      },
    ];
    const open = setup({
      hidden: ["deleted"],
      taskMetas: facts,
      openPaths: ["/repo/.worktrees/task-1"],
    });
    expect(
      (await open.operations.eraseTasks({ ...workspace, taskIds: ["deleted"] }))?.worktreeCleanup
        .retained,
    ).toHaveLength(1);
    expect(open.gitService.removeWorktree).not.toHaveBeenCalled();

    const unavailable = setup({ hidden: ["deleted"], taskMetas: facts, openInventoryFails: true });
    const result = await unavailable.operations.eraseTasks({ ...workspace, taskIds: ["deleted"] });
    expect(result?.worktreeCleanup.retained).toHaveLength(1);
    expect(unavailable.gitService.removeWorktree).not.toHaveBeenCalled();
  });

  it("protects a surviving branch owner in the same repository but ignores equal names elsewhere", async () => {
    const candidate = {
      taskId: "deleted",
      workspacePath: "/repo",
      deleted: true,
      executionWorktree: { path: "/repo/.worktrees/deleted", branchName: "feature/shared" },
    };
    const owner = {
      taskId: "survivor",
      workspacePath: "/repo/.worktrees/other",
      deleted: false,
      executionWorktree: { path: "/repo/.worktrees/other", branchName: "feature/shared" },
    };
    const sameRepo = setup({
      hidden: ["deleted"],
      count: () => counts(0),
      taskMetas: [candidate, owner],
    });
    const retained = await sameRepo.operations.eraseTasks({ ...workspace, taskIds: ["deleted"] });
    expect(retained?.worktreeCleanup.retained).toHaveLength(1);
    expect(sameRepo.gitService.removeWorktree).not.toHaveBeenCalled();

    const otherRepo = setup({
      hidden: ["deleted"],
      count: () => counts(0),
      taskMetas: [
        candidate,
        {
          ...owner,
          workspacePath: "/other",
          executionWorktree: { path: "/other/worktrees/other", branchName: "feature/shared" },
        },
      ],
      repoRoots: { "/other": "/other" },
    });
    const removed = await otherRepo.operations.eraseTasks({ ...workspace, taskIds: ["deleted"] });
    expect(removed?.worktreeCleanup.removed).toEqual(["/repo/.worktrees/deleted"]);
  });

  it("retries worktree-only maintenance after the session row is already gone", async () => {
    const { operations, gitService } = setup({
      hidden: ["t1"],
      count: () => counts(0),
      taskMetas: [
        {
          taskId: "t1",
          workspacePath: "/repo",
          deleted: true,
          executionWorktree: { path: "/repo/.worktrees/t1" },
        },
      ],
    });
    const result = await operations.eraseHiddenTaskContent();
    expect(result?.worktreeCleanup.removed).toEqual(["/repo/.worktrees/t1"]);
    expect(gitService.removeWorktree).toHaveBeenCalledOnce();
  });
});
