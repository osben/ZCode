import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspaceKey, type ZCodeTaskMeta } from "@zcode/shared";
import { getTasksIndexDatabasePath, setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { seedTaskIndex } from "./helpers/taskIndexFixture.js";

const WORKSPACE = "/workspace/project";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-cli-updated-at-"));
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

function task(taskId: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: WORKSPACE,
    createdAt: 10,
    updatedAt: 1000,
    mode: "default",
    status: "completed",
    ...overrides,
  };
}

interface CliTimeRow {
  cli_updated_at: number | null;
  updated_at: number;
}

/** Reads the two time columns straight from SQLite; the repo's read projection hides the difference. */
function readTimeColumns(taskId: string): CliTimeRow {
  const database = new DatabaseSync(getTasksIndexDatabasePath());
  try {
    return database
      .prepare(
        "SELECT cli_updated_at, updated_at FROM tasks WHERE workspace_key = ? AND task_id = ?",
      )
      .get(resolveWorkspaceKey({ workspacePath: WORKSPACE }), taskId) as unknown as CliTimeRow;
  } finally {
    database.close();
  }
}

describe("TaskIndexRepo cli_updated_at single writer", () => {
  it("keeps the CLI activity time when a renamed or pinned task is written", async () => {
    await seedTaskIndex(repo, { meta: task("admitted", { updatedAt: 1000 }) });
    const current = await repo.getTaskMeta({ workspacePath: WORKSPACE, taskId: "admitted" });
    expect(current?.updatedAt).toBe(1000);

    // Organization write whose record carries a Host-side updatedAt that differs from the CLI fact.
    // Renames and pins never change CLI time, so the CLI column must keep 1000.
    const writeRecord = (
      repo as unknown as { writeRecord(input: unknown): unknown }
    ).writeRecord.bind(repo);
    writeRecord({
      meta: { ...current, title: "Renamed", titleOverridden: true, updatedAt: 9999 },
      pinned: true,
      archived: false,
      deleted: false,
      titleOverridden: true,
    });

    expect(readTimeColumns("admitted")).toEqual({ cli_updated_at: 1000, updated_at: 9999 });
  });

  it("leaves a row written on the UI path without CLI activity time until applyCliFacts", async () => {
    await repo.syncTaskMeta({ meta: task("ui-created", { updatedAt: 500 }) });
    expect(readTimeColumns("ui-created").cli_updated_at).toBeNull();

    await repo.applyCliFacts({
      meta: task("ui-created", { updatedAt: 500 }),
      lastOutcome: "completed",
    });
    expect(readTimeColumns("ui-created").cli_updated_at).toBe(500);
  });

  it("still advances the CLI activity time through the CLI-time writers and never moves it backwards", async () => {
    await seedTaskIndex(repo, { meta: task("active", { updatedAt: 1000, status: "running" }) });

    // Terminal transition from the syncer: applyAgentPatch carries the CLI lastActivityAt.
    await repo.applyAgentPatch({
      workspacePath: WORKSPACE,
      taskId: "active",
      patch: { status: "completed", updatedAt: 2000 },
    });
    expect(readTimeColumns("active").cli_updated_at).toBe(2000);

    // Runtime snapshot from the CLI: syncTaskMeta carries the snapshot updatedAt.
    await repo.syncTaskMeta({ meta: task("active", { updatedAt: 3000, status: "completed" }) });
    expect(readTimeColumns("active").cli_updated_at).toBe(3000);

    // A stale CLI time cannot pull the activity time back.
    await repo.applyAgentPatch({
      workspacePath: WORKSPACE,
      taskId: "active",
      patch: { status: "completed", updatedAt: 500 },
    });
    expect(readTimeColumns("active").cli_updated_at).toBe(3000);
  });

  it("does not treat a title echo as activity", async () => {
    await seedTaskIndex(repo, { meta: task("echo", { updatedAt: 1000 }) });

    await repo.applyAgentPatch({
      workspacePath: WORKSPACE,
      taskId: "echo",
      patch: { title: "Echoed title" },
    });

    expect(readTimeColumns("echo").cli_updated_at).toBe(1000);
  });
});
