import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { mapSessionSummaryToTaskMeta } from "@/v4/mapSessionSummaryToTaskMeta.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

type TestSessionSummary = SessionSummary & {
  titleSource?: "default" | "generated" | "custom";
};

function summary(overrides: Partial<TestSessionSummary> = {}): TestSessionSummary {
  return {
    sessionId: "s1",
    workspaceId: "ws-1",
    title: "标题",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 200,
    createdAt: 100,
    ...overrides,
  };
}

describe("mapSessionSummaryToTaskMeta", () => {
  it("基础映射：taskId/title/时间/status/mode 默认", () => {
    const meta = mapSessionSummaryToTaskMeta(summary(), {
      workspacePath: "/ws",
    });
    expect(meta.taskId).toBe("s1");
    expect(meta.title).toBe("标题");
    expect(meta.createdAt).toBe(100);
    expect(meta.updatedAt).toBe(200);
    expect(meta.status).toBe("completed");
    expect(meta.mode).toBe("default");
    expect(meta.workspacePath).toBe("/ws");
    expect(meta.traceId).toBe("session-s1");
    expect(getTaskListRowActivity(meta)).toEqual({
      phase: "completedSuccess",
      lastActivityAt: 200,
      hasBackgroundWork: false,
    });
  });

  it("executionWorktree passes through when present and stays absent otherwise", () => {
    const withWorktree = mapSessionSummaryToTaskMeta(
      summary({
        executionWorktree: {
          path: "/repo/../worktrees/zcode-sleepy-capybara",
          branchName: "zcode/sleepy-capybara",
        },
      }),
      { workspacePath: "/ws" },
    );
    expect(withWorktree.executionWorktree).toEqual({
      path: "/repo/../worktrees/zcode-sleepy-capybara",
      branchName: "zcode/sleepy-capybara",
    });
    expect(
      "executionWorktree" in mapSessionSummaryToTaskMeta(summary(), { workspacePath: "/ws" }),
    ).toBe(false);
  });

  it("executionWorktreeMissing maps through when true and stays absent otherwise", () => {
    const meta = mapSessionSummaryToTaskMeta(
      summary({
        executionWorktree: { path: "/repo/../worktrees/zcode-sleepy-capybara" },
        executionWorktreeMissing: true,
      }),
      { workspacePath: "/ws" },
    );
    expect(meta.executionWorktreeMissing).toBe(true);
    // Healthy worktree summary: the flag must not create a key (absent ≈ false).
    expect(
      "executionWorktreeMissing" in
        mapSessionSummaryToTaskMeta(
          summary({ executionWorktree: { path: "/repo/../worktrees/zcode-sleepy-capybara" } }),
          { workspacePath: "/ws" },
        ),
    ).toBe(false);
  });

  it("incognito maps through when true and stays absent otherwise", () => {
    expect(
      mapSessionSummaryToTaskMeta(summary({ incognito: true }), { workspacePath: "/ws" }).incognito,
    ).toBe(true);
    expect("incognito" in mapSessionSummaryToTaskMeta(summary({}), { workspacePath: "/ws" })).toBe(
      false,
    );
  });

  it("workflowActivity 原样搬进 sidecar（侧栏运行行的数据），缺席时不建键", () => {
    const workflowActivity: SessionSummary["workflowActivity"] = {
      runs: [
        {
          runId: "run-1",
          toolCallId: "tool-1",
          name: "Deep research",
          status: "running",
          phases: [
            { name: "Research", status: "running" },
            { name: "Write", status: "pending" },
          ],
          currentPhase: "Research",
          agentsWorking: 2,
        },
      ],
    };
    const meta = mapSessionSummaryToTaskMeta(summary({ workflowActivity }), {
      workspacePath: "/ws",
    });
    expect(getTaskListRowActivity(meta)?.workflowActivity).toEqual(workflowActivity);
    expect(
      getTaskListRowActivity(mapSessionSummaryToTaskMeta(summary(), { workspacePath: "/ws" })),
    ).not.toHaveProperty("workflowActivity");
  });

  it("phase → status 映射", () => {
    expect(
      mapSessionSummaryToTaskMeta(summary({ phase: "running" }), { workspacePath: "/ws" }).status,
    ).toBe("running");
    expect(
      mapSessionSummaryToTaskMeta(summary({ phase: "error" }), { workspacePath: "/ws" }).status,
    ).toBe("error");
    // draft 无 status
    expect(
      mapSessionSummaryToTaskMeta(summary({ phase: "draft" }), { workspacePath: "/ws" }).status,
    ).toBeUndefined();
  });

  it("fork：parentSessionId → forkedFromTaskId", () => {
    const meta = mapSessionSummaryToTaskMeta(summary({ parentSessionId: "parent" }), {
      workspacePath: "/ws",
    });
    expect(meta.forkedFromTaskId).toBe("parent");
  });

  it("previous 的 mode/provider 沿用；旧 titleOverridden 在 summary 非 custom 时保留", () => {
    const previous = {
      taskId: "s1",
      title: "重命名了",
      titleOverridden: true,
      provider: "claude",
      mode: "plan",
    } as unknown as ZCodeTaskMeta;
    const meta = mapSessionSummaryToTaskMeta(
      summary({ title: "Fork of 项目代码Bug排查", titleSource: "generated" }),
      { workspacePath: "/ws", previous },
    );
    expect(meta.title).toBe("重命名了");
    expect(meta.titleOverridden).toBe(true);
    expect(meta.mode).toBe("plan");
    expect(meta.provider).toBe("claude");
  });

  it("summary.titleSource=custom 时使用 session store 的权威自定义标题", () => {
    const previous = {
      taskId: "s1",
      title: "旧 task-index 标题",
      titleOverridden: true,
      mode: "plan",
    } as unknown as ZCodeTaskMeta;
    const meta = mapSessionSummaryToTaskMeta(
      summary({ title: "新的自定义标题", titleSource: "custom" }),
      { workspacePath: "/ws", previous },
    );
    expect(meta.title).toBe("新的自定义标题");
    expect(meta.titleOverridden).toBe(true);
  });

  it("workspaceIdentity 透传", () => {
    const meta = mapSessionSummaryToTaskMeta(summary(), {
      workspacePath: "/ws",
      workspaceIdentity: "remote::/ws",
    });
    expect(meta.workspaceIdentity).toBe("remote::/ws");
  });

  it("preserves the sessions-index pending interaction for background sidebar rows", () => {
    const pendingInteraction = {
      interactionId: "ask-1",
      kind: "userInput" as const,
      toolName: "AskUserQuestion",
      autoResolution: {
        state: "hiddenGrace" as const,
        startedAt: 1_000,
        visibleAt: 61_000,
        deadlineAt: 301_000,
      },
    };
    const meta = mapSessionSummaryToTaskMeta(summary({ pendingInteraction }), {
      workspacePath: "/ws",
    });

    expect(meta.pendingInteraction).toEqual(pendingInteraction);
  });

  it("透传侧栏需要的 pending interaction kind/count", () => {
    const meta = mapSessionSummaryToTaskMeta(
      summary({
        phase: "running",
        pendingInteractionSummary: {
          permissionCount: 1,
          userInputCount: 2,
        },
      }),
      { workspacePath: "/ws" },
    );

    expect(getTaskListRowActivity(meta)?.pendingInteractions).toEqual({
      permissionCount: 1,
      userInputCount: 2,
    });
  });
});

describe("mapSessionSummaryToTaskMeta child-conversation facts", () => {
  it("maps counters and the capped child list; zero/absent stay absent", () => {
    const withChildren = mapSessionSummaryToTaskMeta(
      summary({
        sideChatCount: 1,
        subagentCount: 3,
        runningSubagentCount: 1,
        childSessions: [
          {
            sessionId: "child-sub",
            title: "research adapters",
            taskType: "subagent_child",
            lastActivityAt: 50,
            running: true,
          },
          {
            sessionId: "child-chat",
            title: "side chat",
            taskType: "selection_side_chat",
            lastActivityAt: 40,
            running: false,
          },
        ],
      }),
      { workspacePath: "/ws" },
    );
    expect(withChildren.sideChatCount).toBe(1);
    expect(withChildren.subagentCount).toBe(3);
    expect(withChildren.runningSubagentCount).toBe(1);
    expect(withChildren.childSessions).toEqual([
      {
        sessionId: "child-sub",
        title: "research adapters",
        taskType: "subagent_child",
        lastActivityAt: 50,
        running: true,
      },
      {
        sessionId: "child-chat",
        title: "side chat",
        taskType: "selection_side_chat",
        lastActivityAt: 40,
        running: false,
      },
    ]);

    const withoutChildren = mapSessionSummaryToTaskMeta(
      summary({
        sideChatCount: 0,
        subagentCount: 0,
        runningSubagentCount: 0,
        childSessions: [],
      }),
      { workspacePath: "/ws" },
    );
    expect(withoutChildren.sideChatCount).toBeUndefined();
    expect(withoutChildren.subagentCount).toBeUndefined();
    expect(withoutChildren.runningSubagentCount).toBeUndefined();
    expect(withoutChildren.childSessions).toBeUndefined();
  });
});
