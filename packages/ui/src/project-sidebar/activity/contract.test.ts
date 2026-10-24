import { expect, it } from "vitest";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import { applyProjectTaskOverlays } from "@/project-sidebar/view.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

it("远端 phase 只叠加完整身份匹配的现有行，不改标题/排序时间/归属或增加行", () => {
  const local: ProjectTask = {
    taskId: "same",
    workspacePath: "/repo",
    hostId: "local",
    projectId: null,
    title: "Local",
    traceId: "t",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    pinned: false,
    archived: false,
  };
  const remote = {
    ...local,
    title: "Remote custom",
    hostId: "remote:server:s",
    workspaceIdentity: "remote:server:s:/repo",
    projectId: "project",
  };
  const tree = { projects: [], tasks: [local, remote] };
  const activity = { phase: "running" as const, lastActivityAt: 99, hasBackgroundWork: false };
  const result = applyProjectTaskOverlays(tree, [
    {
      address: {
        taskId: "same",
        workspacePath: "/repo",
        workspaceIdentity: remote.workspaceIdentity,
      },
      activity,
    },
    {
      address: {
        taskId: "unknown",
        workspacePath: "/repo",
        workspaceIdentity: remote.workspaceIdentity,
      },
      activity,
    },
  ]);
  expect(result.tasks).toHaveLength(2);
  expect(result.tasks[0]).toBe(local);
  expect(result.tasks[1]).toMatchObject({
    title: "Remote custom",
    updatedAt: 2,
    projectId: "project",
  });
  expect(getTaskListRowActivity(result.tasks[1]!)).toEqual(activity);
  expect(getTaskListRowActivity(applyProjectTaskOverlays(tree, []).tasks[1]!)).toBeNull();
});

it("child-conversation facts overlay the matching row even without live activity (spec §7)", () => {
  const parent: ProjectTask = {
    taskId: "parent",
    workspacePath: "/repo",
    hostId: "local",
    projectId: null,
    title: "Parent",
    traceId: "t",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    pinned: false,
    archived: false,
  };
  const tree = { projects: [], tasks: [parent] };
  const childFacts = {
    subagentCount: 3,
    runningSubagentCount: 1,
    childSessions: [
      {
        sessionId: "child",
        title: "Child",
        taskType: "subagent_child" as const,
        lastActivityAt: 1,
        running: true,
      },
    ],
  };
  const [row] = applyProjectTaskOverlays(tree, [
    { address: { taskId: "parent", workspacePath: "/repo" }, childFacts },
  ]).tasks;
  expect(row).toMatchObject({ title: "Parent", updatedAt: 2, ...childFacts });
  expect(getTaskListRowActivity(row!)).toBeNull();
  expect(applyProjectTaskOverlays(tree, []).tasks[0]).toBe(parent);
});
