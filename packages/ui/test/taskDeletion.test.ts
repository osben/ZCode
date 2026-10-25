import { afterEach, describe, expect, it, vi } from "vitest";
import type { IZCodeTaskService, ZCodeTaskTreeCounts } from "@zcode/services";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import {
  loadTaskDeletionWorktreePreview,
  permanentlyDeleteTasks,
  taskDeletionSupported,
} from "@/task-deletion/taskDeletion.js";
import type { TaskDeleteTarget } from "@/task-deletion/taskDeletion.js";

vi.mock("@/lib/taskListMetaSync.js", () => ({
  removeTaskFromTaskCaches: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

const treeCounts = (patch: Partial<ZCodeTaskTreeCounts> = {}): ZCodeTaskTreeCounts => ({
  total: 1,
  sideChats: 0,
  subagents: 0,
  workflowSessions: 0,
  workflowRuns: 0,
  running: 0,
  ...patch,
});

function target(taskId: string, patch: Partial<TaskDeleteTarget> = {}): TaskDeleteTarget {
  return {
    id: taskId,
    taskId,
    title: taskId,
    workspacePath: "/repo",
    archived: false,
    pinned: false,
    ...patch,
  };
}

function mockServices(overrides: Partial<IZCodeTaskService> = {}) {
  const taskService = {
    getDeletionCapability: vi.fn(async () => ({ supported: true })),
    countTaskTrees: vi.fn(async () => treeCounts()),
    deleteTask: vi.fn(async () => ({})),
    deleteArchivedTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      deletedTaskIds: taskIds,
      skippedTaskIds: [],
      failedTaskIds: [],
    })),
    eraseTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      erasedTaskIds: taskIds,
      skippedTaskIds: [],
      blockedRunningTaskIds: [],
      failedTaskIds: [],
      fileFailureCount: 0,
      filesRetainedCount: 0,
      worktreeCleanup: {
        removed: [],
        retained: [],
        failed: [],
        removedCount: 0,
        retainedCount: 0,
        failedCount: 0,
      },
    })),
    ...overrides,
  } as unknown as IZCodeTaskService;
  const gitService = {
    getWorktreeRemovalPreview: vi.fn(async () => ({ files: [] })),
  } as never;
  return { taskService, gitService };
}

describe("task deletion", () => {
  it("requires explicit capability and does not infer support from proxy methods", async () => {
    const services = mockServices({
      getDeletionCapability: vi.fn(async () => ({ supported: false })),
    });
    const resolve = () => services;
    expect(await taskDeletionSupported([target("a")], resolve)).toBe(false);
    const result = await permanentlyDeleteTasks([target("a")], resolve);
    expect(result.unsupported).toBe(1);
    expect(services.taskService.deleteTask).not.toHaveBeenCalled();
    expect(services.taskService.eraseTasks).not.toHaveBeenCalled();
  });

  it("blocks known running trees before tombstoning", async () => {
    const services = mockServices({
      countTaskTrees: vi.fn(async () => treeCounts({ running: 1 })),
    });
    const result = await permanentlyDeleteTasks([target("a")], () => services);
    expect(result.running).toBe(1);
    expect(services.taskService.deleteTask).not.toHaveBeenCalled();
    expect(removeTaskFromTaskCaches).not.toHaveBeenCalled();
  });

  it("tombstones and removes cached membership before erasing content", async () => {
    const order: string[] = [];
    const services = mockServices({
      deleteTask: vi.fn(async () => {
        order.push("tombstone");
        return {};
      }),
      eraseTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => {
        order.push("erase");
        expect(taskIds).toEqual(["a"]);
        return {
          erasedTaskIds: taskIds,
          skippedTaskIds: [],
          blockedRunningTaskIds: [],
          failedTaskIds: [],
          fileFailureCount: 0,
          filesRetainedCount: 0,
          worktreeCleanup: {
            removed: ["/repo/.worktrees/a"],
            retained: [],
            failed: [],
            removedCount: 1,
            retainedCount: 0,
            failedCount: 0,
          },
        };
      }),
    });
    vi.mocked(removeTaskFromTaskCaches).mockImplementation(() => {
      order.push("cache");
    });
    const result = await permanentlyDeleteTasks([target("a")], () => services);
    expect(order).toEqual(["tombstone", "cache", "erase"]);
    expect(result.worktreeCleanup.removed).toEqual(["/repo/.worktrees/a"]);
  });

  it("uses archived batch tombstones and counts restored-elsewhere tasks as skipped", async () => {
    const services = mockServices({
      deleteArchivedTasks: vi.fn(async () => ({
        deletedTaskIds: ["a"],
        skippedTaskIds: ["b"],
        failedTaskIds: [],
      })),
    });
    const result = await permanentlyDeleteTasks(
      [target("a", { archived: true }), target("b", { archived: true })],
      () => services,
    );
    expect(services.taskService.deleteArchivedTasks).toHaveBeenCalledWith({
      workspacePath: "/repo",
      taskIds: ["a", "b"],
    });
    expect(result.tombstoned).toBe(1);
    expect(result.skipped).toBe(1);
    expect(services.taskService.eraseTasks).toHaveBeenCalledWith({
      workspacePath: "/repo",
      taskIds: ["a"],
    });
  });

  it("previews worktree removal through the dedicated Git query and keeps every reported file", async () => {
    const services = mockServices();
    const files = [
      { path: "a.ts", status: "M" },
      { path: "binary.dat", status: "??" },
      { path: "large.txt", status: "??" },
    ];
    services.gitService.getWorktreeRemovalPreview = vi.fn(async () => ({ files })) as never;
    const preview = await loadTaskDeletionWorktreePreview(
      [target("a", { executionWorktree: { path: "/repo/.worktrees/a", branchName: "a" } })],
      () => services,
    );
    expect(services.gitService.getWorktreeRemovalPreview).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/repo/.worktrees/a",
    });
    expect(preview).toEqual([{ path: "/repo/.worktrees/a", branchName: "a", files }]);
  });

  it("reports unknown (null) when the Git query rejects", async () => {
    const services = mockServices();
    services.gitService.getWorktreeRemovalPreview = vi.fn(async () => {
      throw new Error("not a git repository");
    }) as never;
    const preview = await loadTaskDeletionWorktreePreview(
      [target("a", { executionWorktree: { path: "/repo/.worktrees/a" } })],
      () => services,
    );
    expect(preview).toBeNull();
  });

  it("reports unknown (null) when a peer returns no files array instead of treating it as clean", async () => {
    const services = mockServices();
    services.gitService.getWorktreeRemovalPreview = vi.fn(async () => undefined) as never;
    const preview = await loadTaskDeletionWorktreePreview(
      [target("a", { executionWorktree: { path: "/repo/.worktrees/a" } })],
      () => services,
    );
    expect(preview).toBeNull();
  });

  it("reports unknown (null) when the peer has no worktree removal preview method", async () => {
    const services = { ...mockServices(), gitService: {} as never };
    const preview = await loadTaskDeletionWorktreePreview(
      [target("a", { executionWorktree: { path: "/repo/.worktrees/a" } })],
      () => services,
    );
    expect(preview).toBeNull();
  });
});
