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
const WORKSPACE_KEY = buildTaskWorkspaceKey(WORKSPACE_PATH);
const WORKTREE = { branchName: "feat/x", path: "/repo/.worktrees/x" };

// Each driver renders with or without one worktree task in view.
const drivers = [
  {
    name: "sidebar driver",
    render: (withTarget: boolean) =>
      usePullRequestStatuses(
        withTarget
          ? [
              {
                workspaceKey: WORKSPACE_KEY,
                workspacePath: WORKSPACE_PATH,
                gitService,
                tasks: [
                  {
                    input: {
                      taskId: TASK_ID,
                      branchName: WORKTREE.branchName,
                      worktreePath: WORKTREE.path,
                    },
                    running: false,
                  },
                ],
              },
            ]
          : [],
      ),
  },
  {
    name: "Session manager driver",
    render: (withTarget: boolean) =>
      useSessionManagerPullRequests(
        withTarget
          ? [
              {
                task: {
                  taskId: TASK_ID,
                  workspacePath: WORKSPACE_PATH,
                  executionWorktree: WORKTREE,
                },
                taskKey: buildPullRequestTaskKey(WORKSPACE_KEY, TASK_ID),
                workspaceKey: WORKSPACE_KEY,
                archived: false,
                pinned: false,
                running: false,
                offline: false,
              } as unknown as SessionManagerRow,
            ]
          : [],
      ),
  },
];

function forcedCalls(): unknown[][] {
  return getSessionPullRequests.mock.calls.filter((call) => {
    const request = (call as unknown[])[0] as { forceTaskIds?: string[] };
    return request.forceTaskIds?.includes(TASK_ID);
  });
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
    const { rerender } = renderHook(({ withTarget }) => render(withTarget), {
      initialProps: { withTarget: false },
    });
    act(() => {
      usePullRequestStatusStore.getState().requestRefresh();
    });
    await act(async () => {
      rerender({ withTarget: true });
    });
    expect(forcedCalls()).toHaveLength(1);
  });

  it("fires an explicit refresh once per version", async () => {
    const { rerender } = renderHook(({ withTarget }) => render(withTarget), {
      initialProps: { withTarget: true },
    });
    await act(async () => {
      usePullRequestStatusStore
        .getState()
        .requestForceRefresh([buildPullRequestTaskKey(WORKSPACE_KEY, TASK_ID)]);
    });
    expect(forcedCalls()).toHaveLength(1);
    // A new targets identity re-runs the effects but must not replay the request.
    await act(async () => {
      rerender({ withTarget: true });
    });
    expect(forcedCalls()).toHaveLength(1);
  });
});
