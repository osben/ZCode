import { describe, expect, it, vi } from "vitest";
import type { IZCodeTaskService } from "@zcode/services";
import {
  collectArchivedTaskDeletion,
  deleteArchivedTaskSelection,
  type ArchivedTaskDeletionWorkspace,
} from "@/lib/archivedTaskDeletion.js";

function workspace(path = "/repo", count = 25, identity?: string): ArchivedTaskDeletionWorkspace {
  return {
    workspacePath: path,
    workspaceIdentity: identity,
    label: identity ?? path,
    gitService: { getChanges: vi.fn(async () => []) },
    service: {
      getDeletionCapability: vi.fn(async () => ({ supported: !identity })),
      listArchivedTasks: vi.fn(async () =>
        Array.from({ length: count }, (_, i) => ({
          taskId: `task-${i}`,
          title: `Task ${i}`,
          workspacePath: path,
        })),
      ) as unknown as IZCodeTaskService["listArchivedTasks"],
      countTaskTrees: vi.fn(async ({ taskIds }) => ({
        total: taskIds.length,
        sideChats: 0,
        subagents: 0,
        workflowSessions: 0,
        workflowRuns: 0,
        running: 0,
      })),
      deleteArchivedTasks: vi.fn(async ({ taskIds }) => ({
        deletedTaskIds: taskIds,
        skippedTaskIds: [],
        failedTaskIds: [],
      })),
      eraseTasks: vi.fn(async ({ taskIds }) => ({
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
    },
  };
}

describe("archived permanent deletion", () => {
  it("collects complete local sets without mutations, deduplicating workspaces", async () => {
    const local = workspace();
    const other = workspace("/other", 2);
    const selection = await collectArchivedTaskDeletion([local, local, other]);
    expect(selection.count).toBe(27);
    expect(local.service!.listArchivedTasks).toHaveBeenCalledTimes(1);
    expect(local.service!.deleteArchivedTasks).not.toHaveBeenCalled();
    expect(local.service!.eraseTasks).not.toHaveBeenCalled();
  });

  it("excludes unsupported remote and unavailable workspaces", async () => {
    const remote = workspace("/repo", 2, "remote:ssh:host:/repo");
    const offline = { ...workspace("/offline"), service: undefined };
    const selection = await collectArchivedTaskDeletion([workspace(), remote, offline]);
    expect(selection.count).toBe(25);
    expect(selection.unavailableWorkspaces).toEqual([remote.label, offline.label]);
    expect(remote.service!.deleteArchivedTasks).not.toHaveBeenCalled();
  });

  it("erases only successfully tombstoned IDs, preserving restored/skipped and failed rows", async () => {
    const local = workspace("/repo", 4);
    const selection = await collectArchivedTaskDeletion([local]);
    vi.mocked(local.service!.listArchivedTasks).mockResolvedValue([]);
    vi.mocked(local.service!.deleteArchivedTasks).mockResolvedValueOnce({
      deletedTaskIds: ["task-0", "task-3"],
      skippedTaskIds: ["task-1"],
      failedTaskIds: ["task-2"],
    });
    const onDeleted = vi.fn();
    const result = await deleteArchivedTaskSelection(selection, onDeleted);
    expect(result).toMatchObject({ tombstoned: 2, erased: 2, skipped: 1, failed: 1 });
    expect(onDeleted.mock.calls.map(([target]) => target.taskId)).toEqual(["task-0", "task-3"]);
    expect(local.service!.eraseTasks).toHaveBeenCalledWith({
      workspacePath: "/repo",
      taskIds: ["task-0", "task-3"],
    });
    expect(local.service!.listArchivedTasks).toHaveBeenCalledTimes(1);
  });

  it("batches per workspace and isolates a failed workspace", async () => {
    const local = workspace("/repo", 72);
    const failed = workspace("/other", 8);
    vi.mocked(failed.service!.deleteArchivedTasks).mockRejectedValueOnce(new Error("offline"));
    const selection = await collectArchivedTaskDeletion([local, failed]);
    expect(await deleteArchivedTaskSelection(selection, vi.fn())).toMatchObject({
      erased: 72,
      failed: 8,
    });
    expect(local.service!.deleteArchivedTasks).toHaveBeenCalledTimes(1);
    expect(failed.service!.eraseTasks).not.toHaveBeenCalled();
  });

  it("blocks running trees before tombstoning", async () => {
    const local = workspace();
    const selection = await collectArchivedTaskDeletion([local]);
    vi.mocked(local.service!.countTaskTrees!).mockResolvedValueOnce({
      total: 25,
      sideChats: 0,
      subagents: 0,
      workflowSessions: 0,
      workflowRuns: 0,
      running: 1,
    });
    expect(await deleteArchivedTaskSelection(selection, vi.fn())).toMatchObject({
      running: 25,
      tombstoned: 0,
    });
    expect(local.service!.deleteArchivedTasks).not.toHaveBeenCalled();
  });

  it("makes no mutation for an empty selection", async () => {
    const empty = workspace("/repo", 0);
    const selection = await collectArchivedTaskDeletion([empty]);
    expect(await deleteArchivedTaskSelection(selection, vi.fn())).toMatchObject({
      erased: 0,
      failed: 0,
    });
    expect(empty.service!.deleteArchivedTasks).not.toHaveBeenCalled();
  });
});
