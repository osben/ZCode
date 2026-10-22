import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta, ZCodeWorkspaceEvent } from "@zcode/shared";
import { createWindowHostControllerRuntime } from "@zcode/services/window-controller";

function createSource(count: number, workspacePath = "/isolated/probe") {
  const events = new Emitter<ZCodeWorkspaceEvent>();
  const rows = new Map<string, ZCodeTaskMeta>(
    Array.from({ length: count }, (_, index) => {
      const task: ZCodeTaskMeta = {
        taskId: `task-${index}`,
        traceId: `trace-${index}`,
        title: `task-${index}`,
        workspacePath,
        createdAt: 1,
        updatedAt: 1,
        mode: "default",
      };
      return [task.taskId, task];
    }),
  );
  const emitDeleted = () =>
    events.fire({
      type: "workspace_task_list_changed",
      workspacePath,
      reason: "task_deleted",
    });
  const source = {
    getDeletionCapability: vi.fn(async () => ({ supported: true })),
    countTaskTrees: vi.fn(async ({ taskIds }: { taskIds: string[] }) => ({
      total: taskIds.length,
      sideChats: 0,
      subagents: 0,
      workflowSessions: 0,
      workflowRuns: 0,
      running: 0,
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
    listTasks: vi.fn(async () => []),
    listPinnedTasks: vi.fn(async () => []),
    listArchivedTasks: vi.fn(async () => [...rows.values()]),
    onDynamicWorkspaceEvent: () => events.event,
    deleteArchivedTask: vi.fn(async ({ taskId }: { taskId: string }) => {
      const deleted = rows.delete(taskId);
      if (deleted) emitDeleted();
      return deleted;
    }),
    deleteArchivedTasks: vi.fn(async ({ taskIds }: { taskIds: string[] }) => {
      const deletedTaskIds = taskIds.filter((taskId) => rows.delete(taskId));
      if (deletedTaskIds.length) emitDeleted();
      return { deletedTaskIds, skippedTaskIds: [], failedTaskIds: [] };
    }),
  };
  return { source, rows };
}

describe("归档批次跨 UI / Controller 的刷新边界", () => {
  it("批次持久化成功后，列表读取失败不得改报删除失败", async () => {
    const workspacePath = "/isolated/probe";
    const { source, rows } = createSource(2);
    const onSourceError = vi.fn();
    const runtime = createWindowHostControllerRuntime({
      createId: () => "probe",
      onSourceError,
      resolveSource: () => ({
        scope: { kind: "local", workspacePath },
        sourceAvailability: "online",
        taskService: source as unknown as IZCodeTaskService,
      }),
    });
    try {
      const address = await runtime.resolveTaskAddress({ workspacePath, taskId: "task-0" });
      source.listTasks.mockRejectedValue(new Error("refresh failed"));
      expect(
        await runtime.service.deleteArchivedTasks({ address, taskIds: ["task-0", "task-1"] }),
      ).toEqual({ deletedTaskIds: ["task-0", "task-1"], skippedTaskIds: [], failedTaskIds: [] });
      expect(rows.size).toBe(0);
      expect(onSourceError).toHaveBeenCalledWith(expect.anything(), "refresh", expect.any(Error));
    } finally {
      runtime.dispose();
    }
  });

  it("远端批次保留完整地址；离线与已被替换的 remoteSessionId 禁止写入", async () => {
    const workspacePath = "/isolated/probe";
    const workspaceIdentity = "remote:ssh:host:/isolated/probe";
    const { source } = createSource(2);
    let online = true;
    let remoteSessionId = "remote-1";
    const runtime = createWindowHostControllerRuntime({
      createId: () => "probe",
      resolveSource: () => ({
        scope: { kind: "remote", workspacePath, workspaceIdentity, remoteSessionId },
        sourceAvailability: online ? "online" : "offline",
        taskService: source as unknown as IZCodeTaskService,
      }),
    });
    try {
      const address = await runtime.resolveTaskAddress({
        workspacePath,
        workspaceIdentity,
        taskId: "task-0",
      });
      expect(await runtime.service.deleteArchivedTasks({ address, taskIds: ["task-0"] })).toEqual({
        deletedTaskIds: ["task-0"],
        skippedTaskIds: [],
        failedTaskIds: [],
      });
      expect(source.deleteArchivedTasks).toHaveBeenCalledExactlyOnceWith({
        workspacePath,
        workspaceIdentity,
        taskIds: ["task-0"],
      });
      online = false;
      await expect(
        runtime.service.deleteArchivedTasks({ address, taskIds: ["task-1"] }),
      ).rejects.toThrow("离线");
      online = true;
      remoteSessionId = "remote-2";
      await expect(
        runtime.service.deleteArchivedTasks({ address, taskIds: ["task-1"] }),
      ).rejects.toThrow();
      expect(source.deleteArchivedTasks).toHaveBeenCalledTimes(1);
    } finally {
      runtime.dispose();
    }
  });
});
