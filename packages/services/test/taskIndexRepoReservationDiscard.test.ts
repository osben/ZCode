import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspaceKey, type ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const WORKSPACE = "/workspace/project";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-discard-"));
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
    updatedAt: 20,
    mode: "default",
    status: "completed",
    ...overrides,
  };
}

function countRows(taskId: string): number {
  const database = (
    repo as unknown as {
      getDatabase(): { prepare(sql: string): { get(...args: unknown[]): unknown } };
    }
  ).getDatabase();
  const row = database
    .prepare("SELECT count(*) AS n FROM tasks WHERE workspace_key=? AND task_id=?")
    .get(resolveWorkspaceKey({ workspacePath: WORKSPACE }), taskId) as { n: number };
  return row.n;
}

async function reserve(taskId: string): Promise<void> {
  const projects = await repo.getProjectRepository();
  projects.reserveCreatedTask({ task: { workspacePath: WORKSPACE, taskId }, projectId: null });
}

describe("TaskIndexRepo reservation discard", () => {
  it("deletes the placeholder of an abandoned create so no row remains", async () => {
    await reserve("abandoned");
    expect(countRows("abandoned")).toBe(1);

    const projects = await repo.getProjectRepository();
    expect(
      projects.discardCreatedTaskReservation({
        task: { workspacePath: WORKSPACE, taskId: "abandoned" },
      }),
    ).toBe(true);

    expect(countRows("abandoned")).toBe(0);
    expect(await repo.hasTaskMetas({ includeDeleted: true })).toBe(false);
  });

  it("is an idempotent no-op for a task that has no placeholder", async () => {
    await repo.syncTaskMeta({ meta: task("live") });
    const projects = await repo.getProjectRepository();

    expect(
      projects.discardCreatedTaskReservation({
        task: { workspacePath: WORKSPACE, taskId: "missing" },
      }),
    ).toBe(false);
    expect(
      projects.discardCreatedTaskReservation({
        task: { workspacePath: WORKSPACE, taskId: "live" },
      }),
    ).toBe(false);
    expect(countRows("live")).toBe(1);
    expect(await repo.listTaskMetas({})).toEqual([expect.objectContaining({ taskId: "live" })]);
  });

  it("keeps a reservation that already carries CLI facts", async () => {
    await reserve("admitted");
    await repo.applyCliFacts({
      meta: task("admitted", { title: "CLI title", createdAt: 10, updatedAt: 20 }),
      titleSource: "generated",
      lastOutcome: "completed",
    });
    const projects = await repo.getProjectRepository();

    expect(
      projects.discardCreatedTaskReservation({
        task: { workspacePath: WORKSPACE, taskId: "admitted" },
      }),
    ).toBe(false);
    expect(countRows("admitted")).toBe(1);
    expect(await repo.listTaskMetas({})).toEqual([
      expect.objectContaining({ taskId: "admitted", title: "CLI title" }),
    ]);
  });

  it("keeps a zero-time row written by another writer with a real meta_json", async () => {
    await repo.syncTaskMeta({
      meta: task("zero-created", { createdAt: 0, updatedAt: 0, title: "Zero" }),
    });
    const projects = await repo.getProjectRepository();

    expect(
      projects.discardCreatedTaskReservation({
        task: { workspacePath: WORKSPACE, taskId: "zero-created" },
      }),
    ).toBe(false);
    expect((await repo.listTaskMetas({})).map((meta) => meta.taskId)).toEqual(["zero-created"]);
  });
});
