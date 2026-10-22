import { describe, expect, it } from "vitest";
import {
  buildDeletedTaskKeySet,
  isTaskNavigationTargetDeleted,
} from "@/lib/taskNavigationTarget.js";

const entry = {
  kind: "task" as const,
  workspacePath: "/draft/aa49",
  taskId: "task-from-tree",
};

describe("isTaskNavigationTargetDeleted", () => {
  it("does not treat a missing query cache or visible list entry as deletion", () => {
    expect(isTaskNavigationTargetDeleted({ entry, deletedTaskKeys: new Set() })).toBe(false);
  });

  it("treats a task listed as deleted by the project tree as deleted", () => {
    const deletedTaskKeys = buildDeletedTaskKeySet([
      { taskId: "task-from-tree", workspacePath: "/draft/aa49" },
    ]);
    expect(isTaskNavigationTargetDeleted({ entry, deletedTaskKeys })).toBe(true);
  });

  it("matches tombstones by the workspace identity key, not by path alone", () => {
    const deletedTaskKeys = buildDeletedTaskKeySet([
      {
        taskId: "task-from-tree",
        workspacePath: "/draft/aa49",
        workspaceIdentity: "remote:ssh:dev",
      },
    ]);
    expect(isTaskNavigationTargetDeleted({ entry, deletedTaskKeys })).toBe(false);
    expect(
      isTaskNavigationTargetDeleted({
        entry: { ...entry, workspaceIdentity: "remote:ssh:dev" },
        deletedTaskKeys,
      }),
    ).toBe(true);
  });
});
