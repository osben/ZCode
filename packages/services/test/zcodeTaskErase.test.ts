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
  } | null;
  count?: (ids: string[]) => ReturnType<typeof counts> | null;
}) {
  const repo = {
    listDeletedTaskIds: vi.fn(async () => options.hidden),
    listLocalDeletedTaskRefs: vi.fn(async () =>
      Object.entries(options.hiddenByWorkspace ?? { "/work/a": options.hidden }).flatMap(
        ([workspacePath, taskIds]) => taskIds.map((taskId) => ({ workspacePath, taskId })),
      ),
    ),
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
  const operations = createTaskEraseOperations({ agent, taskIndexRepo: repo, provider: "glm" });
  return { operations, agent, repo };
}

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
  });

  it("retries root by root when a running session blocks the chunk", async () => {
    const { operations, agent } = setup({
      hidden: ["t1", "t2", "t3"],
      erase: (ids) =>
        ids.length > 1 || ids[0] === "t2"
          ? { erasedSessionIds: [], blockedRunningSessionIds: ["t2"], fileFailureCount: 0 }
          : { erasedSessionIds: ids, blockedRunningSessionIds: [], fileFailureCount: 2 },
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
    await expect(operations.countHiddenTaskContent()).resolves.toEqual({ sessions: 5 });
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
    await expect(operations.countHiddenTaskContent()).resolves.toEqual({ sessions: 4 });
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
    await expect(operations.countHiddenTaskContent()).resolves.toEqual({ sessions: 2 });
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
    // Both runtime-less workspaces share one started client rather than one process each.
    expect(started).toHaveLength(1);
    expect(started[0]![0].sessionIds).toEqual(["a1", "g1"]);
  });
});
