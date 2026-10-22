import { describe, expect, it } from "vitest";
import {
  createTaskNavigationHistory,
  goBack,
  goForward,
  pushAutomationsNavEntry,
  pushPluginStoreNavEntry,
  pushNavEntry,
  removeTaskFromHistory,
  stepTaskNavigationHistory,
} from "@/lib/taskNavigationHistory.js";

describe("workspace navigation history", () => {
  it("将插件市场作为独立 workspace 目标记录", () => {
    const history = pushPluginStoreNavEntry(
      createTaskNavigationHistory(),
      "/repo",
      "ssh://dev/repo",
    );
    expect(history.entries).toEqual([
      { kind: "plugin-store", workspacePath: "/repo", workspaceIdentity: "ssh://dev/repo" },
    ]);
  });

  it("将 Automations 作为独立目标记录，并支持返回会话后再次前进", () => {
    const taskHistory = pushNavEntry(
      createTaskNavigationHistory(),
      "/workspace",
      "task-a",
      "local:/workspace",
    );
    const automationsHistory = pushAutomationsNavEntry(
      taskHistory,
      "/workspace",
      "local:/workspace",
      "automation-a",
      "idle",
    );

    const back = goBack(automationsHistory);
    expect(back?.entry).toMatchObject({
      kind: "task",
      taskId: "task-a",
      workspaceIdentity: "local:/workspace",
    });

    const forward = back ? goForward(back.history) : null;
    expect(forward?.entry).toEqual({
      kind: "automations",
      workspacePath: "/workspace",
      workspaceIdentity: "local:/workspace",
      automationId: "automation-a",
      automationTab: "idle",
    });
  });

  it("将 Automations tab intent 纳入相邻去重和前进恢复", () => {
    const scheduled = pushAutomationsNavEntry(createTaskNavigationHistory(), "/workspace");
    const idle = pushAutomationsNavEntry(scheduled, "/workspace", undefined, undefined, "idle");

    expect(idle.entries).toEqual([
      { kind: "automations", workspacePath: "/workspace" },
      { kind: "automations", workspacePath: "/workspace", automationTab: "idle" },
    ]);
    expect(pushAutomationsNavEntry(idle, "/workspace", undefined, undefined, "idle")).toBe(idle);
  });

  it("回放同一 Automations 目标不会重复入栈，删除 task 也不会误删 Automations", () => {
    const taskHistory = pushNavEntry(createTaskNavigationHistory(), "/workspace", "task-a");
    const automationsHistory = pushAutomationsNavEntry(
      taskHistory,
      "/workspace",
      undefined,
      "automation-a",
    );

    expect(
      pushAutomationsNavEntry(automationsHistory, "/workspace", undefined, "automation-a"),
    ).toBe(automationsHistory);

    expect(removeTaskFromHistory(automationsHistory, "task-a")).toEqual({
      entries: [
        {
          kind: "automations",
          workspacePath: "/workspace",
          automationId: "automation-a",
        },
      ],
      cursor: 0,
    });
  });

  it("ISSUE-033: 前进遇到已失效 task 时清除它，并继续到下一个有效条目", () => {
    let history = createTaskNavigationHistory();
    history = pushAutomationsNavEntry(history, "/workspace");
    history = pushPluginStoreNavEntry(history, "/workspace");
    history = pushNavEntry(history, "/workspace", "task-a");
    history = pushNavEntry(history, "/workspace", "task-b");
    history = { ...history, cursor: 1 };

    const step = stepTaskNavigationHistory(
      history,
      "forward",
      (entry) => entry.taskId !== "task-a",
    );

    expect(step.entry).toMatchObject({ kind: "task", taskId: "task-b" });
    expect(step.history.entries.map((entry) => entry.kind)).toEqual([
      "automations",
      "plugin-store",
      "task",
    ]);
    expect(step.history.entries[step.history.cursor]).toMatchObject({ taskId: "task-b" });
  });

  it("ISSUE-033: 后退到头时只清除失效条目，cursor 留在当前条目", () => {
    let history = pushNavEntry(createTaskNavigationHistory(), "/workspace", "task-a");
    history = pushNavEntry(history, "/workspace", "task-b");

    const step = stepTaskNavigationHistory(history, "back", (entry) => entry.taskId !== "task-a");

    expect(step.entry).toBeNull();
    expect(step.history.entries).toEqual([
      { kind: "task", workspacePath: "/workspace", taskId: "task-b" },
    ]);
    expect(step.history.cursor).toBe(0);
  });

  it("ISSUE-033: 删除当前 task 时 cursor 按保留条目计数，不因前面已删条目越界", () => {
    // Built literally: pushNavEntry would dedupe the adjacent task-a entries.
    const history = {
      entries: ["task-a", "task-a", "task-x", "task-a", "task-y", "task-z"].map((taskId) => ({
        kind: "task" as const,
        workspacePath: "/workspace",
        taskId,
      })),
      cursor: 3,
    };

    const removed = removeTaskFromHistory(history, "task-a");

    expect(
      removed.entries.map((entry) => (entry.kind === "task" ? entry.taskId : entry.kind)),
    ).toEqual(["task-x", "task-y", "task-z"]);
    expect(removed.cursor).toBe(1);
  });
});
