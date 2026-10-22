import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspaceKey, type ZCodeTaskMeta } from "@zcode/shared";
import { getTasksIndexDatabasePath, setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ZCodeTaskListQuery } from "#src/session/zcodeTaskListTypes.js";
import { seedTaskIndex } from "./helpers/taskIndexFixture.js";

const OPEN_WORKSPACE = "/workspace/open";
const CLOSED_WORKSPACE = "/workspace/closed-project";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-search-scope-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  if (process.platform === "win32") {
    // Windows needs to wait for SQLite to release the file handle, avoiding EPERM during temp dir cleanup.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function task(workspacePath: string, taskId: string, title: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title,
    workspacePath,
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    status: "completed",
  };
}

function search(scopes: string[], text: string) {
  const query: ZCodeTaskListQuery = {
    kind: "active",
    workspaceScopes: scopes.map((workspacePath) => ({ workspacePath })),
    sortBy: "updated",
    search: text,
  };
  return repo.queryTaskList(query);
}

/**
 * Inserts a reservation placeholder the way project-repository does (no CLI facts, created_at 0), then gives it the
 * search text so only the placeholder predicate can keep it out of results.
 */
function insertPlaceholderWithTitle(taskId: string, title: string): void {
  const database = new DatabaseSync(getTasksIndexDatabasePath());
  try {
    database
      .prepare(
        `INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title,searchable_text,created_at,updated_at,host_id,root_path,project_id,handoff_pending,execution_directories)
        VALUES(?,?,?,?,?,?,0,0,?,?,?,?,?)`,
      )
      .run(
        resolveWorkspaceKey({ workspacePath: CLOSED_WORKSPACE }),
        CLOSED_WORKSPACE,
        null,
        taskId,
        title,
        title,
        "local-host",
        CLOSED_WORKSPACE,
        null,
        8,
        null,
      );
  } finally {
    database.close();
  }
}

describe("TaskIndexRepo search across workspaces", () => {
  it("finds a task in a workspace that is not open when that workspace is in the scope", async () => {
    await seedTaskIndex(repo, { meta: task(OPEN_WORKSPACE, "open-task", "Open needle") });
    await seedTaskIndex(repo, { meta: task(CLOSED_WORKSPACE, "closed-task", "Closed needle") });

    const result = await search([OPEN_WORKSPACE, CLOSED_WORKSPACE], "needle");

    expect(result.items.map((item) => item.taskId).sort()).toEqual(["closed-task", "open-task"]);
    const closed = result.items.find((item) => item.taskId === "closed-task");
    expect(closed?.workspacePath).toBe(CLOSED_WORKSPACE);
  });

  it("does not find a task whose workspace is outside the scope", async () => {
    await seedTaskIndex(repo, { meta: task(CLOSED_WORKSPACE, "closed-task", "Closed needle") });

    const result = await search([OPEN_WORKSPACE], "needle");

    expect(result.items).toEqual([]);
  });

  it("excludes deleted rows and reservation placeholders even when they match the text", async () => {
    await seedTaskIndex(repo, {
      meta: task(CLOSED_WORKSPACE, "deleted-task", "Deleted needle"),
      deleted: true,
    });
    await seedTaskIndex(repo, { meta: task(CLOSED_WORKSPACE, "live-task", "Live needle") });
    insertPlaceholderWithTitle("placeholder-task", "Placeholder needle");

    const result = await search([CLOSED_WORKSPACE], "needle");

    expect(result.items.map((item) => item.taskId)).toEqual(["live-task"]);
  });
});
