// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IGitService } from "@zcode/shared";
import { usePullRequestStatuses } from "@/hooks/usePullRequestStatuses.js";
import { useSessionManagerPullRequests } from "@/session-manager/useSessionManagerPullRequests.js";
import type { SessionManagerRow } from "@/session-manager/sessionManagerModel.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  buildPullRequestTaskKey,
  usePullRequestStatusStore,
} from "@/store/pullRequestStatusStore.js";

const getSessionPullRequests = vi.fn(async () => ({}));
const gitService = { getSessionPullRequests } as unknown as IGitService;

vi.mock("@/hooks/useWorkspaceServices.js", () => ({ useBaseWorkspaceServices: () => ({}) }));
vi.mock("@/lib/workspaceServiceResolver.js", () => ({
  buildWorkspaceServiceLookup: (tabs: { workspacePath: string }[]) =>
    new Map(
      tabs.map((tab) => [buildTaskWorkspaceKey(tab.workspacePath), { services: { gitService } }]),
    ),
}));

const WORKSPACE_PATH = "/repo";
const TASK_ID = "task-1";
const OTHER_TASK_ID = "task-2";
const WORKSPACE_KEY = buildTaskWorkspaceKey(WORKSPACE_PATH);
const WORKTREE = { branchName: "feat/x", path: "/repo/.worktrees/x" };

interface ViewTask {
  taskId: string;
  running: boolean;
}

const ONE_TASK: ViewTask[] = [{ taskId: TASK_ID, running: false }];

// Each driver renders the given worktree tasks of one workspace (none = no targets).
const drivers = [
  {
    name: "sidebar driver",
    render: (tasks: readonly ViewTask[]) =>
      usePullRequestStatuses(
        tasks.length > 0
          ? [
              {
                workspaceKey: WORKSPACE_KEY,
                workspacePath: WORKSPACE_PATH,
                gitService,
                tasks: tasks.map((task) => ({
                  input: {
                    taskId: task.taskId,
                    branchName: WORKTREE.branchName,
                    worktreePath: WORKTREE.path,
                  },
                  running: task.running,
                })),
              },
            ]
          : [],
      ),
  },
  {
    name: "Session manager driver",
    render: (tasks: readonly ViewTask[]) =>
      useSessionManagerPullRequests(
        tasks.map(
          (task) =>
            ({
              task: {
                taskId: task.taskId,
                workspacePath: WORKSPACE_PATH,
                executionWorktree: WORKTREE,
              },
              taskKey: buildPullRequestTaskKey(WORKSPACE_KEY, task.taskId),
              workspaceKey: WORKSPACE_KEY,
              archived: false,
              pinned: false,
              running: task.running,
              offline: false,
            }) as unknown as SessionManagerRow,
        ),
      ),
  },
];

function requestOf(call: unknown): { tasks: { taskId: string }[]; forceTaskIds?: string[] } {
  return (call as unknown[])[0] as { tasks: { taskId: string }[]; forceTaskIds?: string[] };
}

function forcedCalls(taskId = TASK_ID): unknown[][] {
  return getSessionPullRequests.mock.calls.filter((call) =>
    requestOf(call).forceTaskIds?.includes(taskId),
  );
}

beforeEach(() => {
  getSessionPullRequests.mockClear();
  usePullRequestStatusStore.setState({
    refreshVersion: 0,
    forceRefresh: { version: 0, taskKeys: [] },
  });
});

afterEach(() => {
  cleanup();
});

describe.each(drivers)("$name refresh signals", ({ render }) => {
  it("keeps a git mutation pending while there are no targets", async () => {
    const { rerender } = renderHook(({ tasks }) => render(tasks), {
      initialProps: { tasks: [] as readonly ViewTask[] },
    });
    act(() => {
      usePullRequestStatusStore.getState().requestRefresh();
    });
    await act(async () => {
      rerender({ tasks: [...ONE_TASK] });
    });
    expect(forcedCalls()).toHaveLength(1);
  });

  it("fires an explicit refresh once per version", async () => {
    const { rerender } = renderHook(({ tasks }) => render(tasks), {
      initialProps: { tasks: ONE_TASK },
    });
    await act(async () => {
      usePullRequestStatusStore
        .getState()
        .requestForceRefresh([buildPullRequestTaskKey(WORKSPACE_KEY, TASK_ID)]);
    });
    expect(forcedCalls()).toHaveLength(1);
    // A new targets identity re-runs the effects but must not replay the request.
    await act(async () => {
      rerender({ tasks: [...ONE_TASK] });
    });
    expect(forcedCalls()).toHaveLength(1);
  });

  it("issues an explicit refresh after a same-commit turn end", async () => {
    // The prober keeps only the newest response per workspace, so the explicit probe (which
    // carries every task) must be issued after the turn-end probe (finished tasks only).
    const { rerender } = renderHook(({ tasks }) => render(tasks), {
      initialProps: {
        tasks: [
          { taskId: TASK_ID, running: true },
          { taskId: OTHER_TASK_ID, running: false },
        ] as readonly ViewTask[],
      },
    });
    await act(async () => {
      usePullRequestStatusStore
        .getState()
        .requestForceRefresh([buildPullRequestTaskKey(WORKSPACE_KEY, OTHER_TASK_ID)]);
      rerender({
        tasks: [
          { taskId: TASK_ID, running: false },
          { taskId: OTHER_TASK_ID, running: false },
        ],
      });
    });
    expect(forcedCalls(TASK_ID)).toHaveLength(1);
    expect(forcedCalls(OTHER_TASK_ID)).toHaveLength(1);
    expect(requestOf(getSessionPullRequests.mock.calls.at(-1)).forceTaskIds).toEqual([
      OTHER_TASK_ID,
    ]);
  });
});
