import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("grouped worktree task marker", () => {
  it("renders the marker in both drag-overlay and interactive row metadata", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/ui/src/workspace-grouped-tasks/task-row.tsx"),
      "utf8",
    );
    const interactiveRow = source.slice(source.indexOf("const interactiveTaskRow = ("));

    expect(source.match(/data-worktree-task-icon="true"/gu)).toHaveLength(2);
    expect(interactiveRow).toContain("task.executionWorktree");
    expect(interactiveRow).toContain("taskList.worktreeTaskLabel");
  });
});
