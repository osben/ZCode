// specs/session-deletion-cascade.md §4: a tombstoned row keeps identity and the deletion marker but no
// conversation text, and a late syncer write cannot bring the text back.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-tombstone-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  if (process.platform === "win32") await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(tempDir, { recursive: true, force: true });
});

const target = { workspacePath: "/workspace/project", taskId: "t1" };

function meta(title: string): ZCodeTaskMeta {
  return {
    taskId: "t1",
    traceId: "trace-t1",
    title,
    workspacePath: "/workspace/project",
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    status: "running",
  };
}

function rowText(): { title: string; searchable_text: string; deleted: number } {
  const database = (
    repo as unknown as {
      getDatabase(): { prepare(sql: string): { get(...params: unknown[]): unknown } };
    }
  ).getDatabase();
  return database
    .prepare("SELECT title, searchable_text, deleted FROM tasks WHERE task_id = ?")
    .get("t1") as { title: string; searchable_text: string; deleted: number };
}

describe("tombstoned task rows", () => {
  it("keep no conversation text once hidden, and a late sync does not restore it", async () => {
    await repo.syncTaskMeta({ meta: meta("secret title"), searchableText: "secret body" });
    expect(rowText()).toMatchObject({ title: "secret title", searchable_text: "secret body" });

    await repo.updateTaskState({ ...target, patch: { deleted: true } });
    expect(rowText()).toEqual({ title: "", searchable_text: "", deleted: 1 });

    await repo.syncTaskMeta({
      meta: meta("late title"),
      searchableText: "late body",
      deleted: true,
    });
    expect(rowText()).toEqual({ title: "", searchable_text: "", deleted: 1 });
    await expect(repo.listDeletedTaskIds(target)).resolves.toEqual(["t1"]);
  });

  it("scrubDeletedTaskContent clears text in rows hidden before the guard existed", async () => {
    await repo.syncTaskMeta({ meta: meta("old title"), searchableText: "old body" });
    const database = (
      repo as unknown as {
        getDatabase(): { prepare(sql: string): { run(...params: unknown[]): unknown } };
      }
    ).getDatabase();
    // Simulate a legacy tombstone: the flag set directly, text left in place.
    database.prepare("UPDATE tasks SET deleted = 1 WHERE task_id = ?").run("t1");
    expect(rowText().searchable_text).toBe("old body");

    await repo.scrubDeletedTaskContent({ ...target, taskIds: ["t1"] });
    expect(rowText()).toEqual({ title: "", searchable_text: "", deleted: 1 });
  });

  it("scrubDeletedTaskContent leaves visible rows alone", async () => {
    await repo.syncTaskMeta({ meta: meta("visible"), searchableText: "visible body" });
    await repo.scrubDeletedTaskContent({ ...target, taskIds: ["t1"] });
    expect(rowText()).toEqual({ title: "visible", searchable_text: "visible body", deleted: 0 });
  });

  it("clears completed cleanup facts so historical maintenance no longer counts that worktree", async () => {
    await repo.syncTaskMeta({
      meta: { ...meta("deleted"), executionWorktree: { path: "/worktrees/t1", branchName: "t1" } },
      searchableText: "body",
      deleted: true,
    });
    expect(
      (await repo.listTaskMetas({ workspacePath: target.workspacePath, includeDeleted: true }))[0]
        ?.executionWorktree,
    ).toEqual({
      path: "/worktrees/t1",
      branchName: "t1",
    });

    await repo.scrubDeletedTaskContent({
      ...target,
      taskIds: ["t1"],
      clearExecutionWorktree: true,
    });
    const [remaining] = await repo.listTaskMetas({
      workspacePath: target.workspacePath,
      includeDeleted: true,
    });
    expect(remaining?.taskId).toBe("t1");
    expect(remaining?.executionWorktree).toBeUndefined();
    await expect(repo.listDeletedTaskIds(target)).resolves.toEqual(["t1"]);
  });
});
