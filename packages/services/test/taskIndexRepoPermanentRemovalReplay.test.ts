// specs/session-deletion-cascade.md: the removal replay that phones and other windows read must include
// fork tombstones, because the fork erase writes no task_purge receipt.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-removal-replay-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  if (process.platform === "win32") await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(tempDir, { recursive: true, force: true });
});

function meta(taskId: string, workspacePath: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath,
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    status: "completed",
  };
}

it("replays tombstoned tasks of the workspace and nothing else", async () => {
  await repo.syncTaskMeta({ meta: meta("gone", "/work/a"), searchableText: "" });
  await repo.syncTaskMeta({ meta: meta("kept", "/work/a"), searchableText: "" });
  await repo.syncTaskMeta({ meta: meta("other", "/work/b"), searchableText: "" });
  await repo.updateTaskState({
    workspacePath: "/work/a",
    taskId: "gone",
    patch: { deleted: true },
  });
  await repo.updateTaskState({
    workspacePath: "/work/b",
    taskId: "other",
    patch: { deleted: true },
  });

  expect(await repo.listPermanentlyDeletedTaskIds({ workspacePath: "/work/a" })).toEqual(["gone"]);
});
