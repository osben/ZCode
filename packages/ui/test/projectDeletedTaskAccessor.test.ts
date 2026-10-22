// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";

const REMOTE = "remote:ssh:dev";

const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  tabs: [],
  read: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({ useTabStore: () => mocks.tabs }));
vi.mock("@/v4/useWorkspaceSessionsIndexItems.js", () => ({
  useWorkspaceSessionsIndexItems: () => ({ items: [] }),
}));
vi.mock("@/project-sidebar/useProjectUnreadSignals.js", () => ({
  useProjectUnreadSignals: () => {},
}));
vi.mock("@/project-sidebar/project-tree-reader.js", () => ({
  readProjectSidebarTree: (...args: unknown[]) => mocks.read(...args),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const deletedRemoteTask = {
  taskId: "task-r",
  workspacePath: "/home/dev/app",
  workspaceIdentity: "remote:ssh:dev:app",
  hostId: REMOTE,
};

it("ISSUE-033: 远端 Host 读取失败时，目录 owner 保留其已知删除事实，回放访问器仍报告已删除", async () => {
  mocks.services = {
    projectService: { owner: "source" },
    remoteProjectService: { owner: "source" },
    broadcastService: { onMessage: vi.fn(() => ({ dispose: vi.fn() })) },
  };
  const directory = { hosts: [{ id: REMOTE, membershipId: "m1" }], entries: [] };

  // Round 1: the remote host answers and reports the task as deleted.
  mocks.read.mockResolvedValueOnce({
    tree: { projects: [], tasks: [], deletedTasks: [deletedRemoteTask] },
    directory,
    availability: new Map(),
    errors: new Map(),
  });
  const { result, unmount } = renderHook(() => useProjectTree());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(
    result.current.isTaskKnownDeleted({
      taskId: "task-r",
      workspacePath: "/home/dev/app",
      workspaceIdentity: "remote:ssh:dev:app",
    }),
  ).toBe(true);

  // Round 2: the same remote host fails to read (offline); its tree rows are absent.
  mocks.read.mockResolvedValueOnce({
    tree: { projects: [], tasks: [] },
    directory,
    availability: new Map(),
    errors: new Map([[REMOTE, "host offline"]]),
  });
  await act(async () => {
    await result.current.refresh();
  });
  expect(mocks.read).toHaveBeenCalledTimes(2);

  expect(
    result.current.isTaskKnownDeleted({
      taskId: "task-r",
      workspacePath: "/home/dev/app",
      workspaceIdentity: "remote:ssh:dev:app",
    }),
  ).toBe(true);
  unmount();
});
