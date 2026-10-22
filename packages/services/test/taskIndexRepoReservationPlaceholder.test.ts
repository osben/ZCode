import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceKey, type ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const WORKSPACE = "/workspace/project";
const META_WARN = "读取 task index meta_json 非法";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-reservation-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  vi.restoreAllMocks();
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

/**
 * Inserts a reservation placeholder the way project-repository does: same column list, created_at and updated_at 0,
 * no meta_json (column default '{}') and no CLI facts.
 */
async function insertReservationPlaceholder(taskId: string): Promise<void> {
  await repo.hasTaskMetas();
  const database = (
    repo as unknown as {
      getDatabase(): { prepare(sql: string): { run(...args: unknown[]): unknown } };
    }
  ).getDatabase();
  database
    .prepare(
      `INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,project_id,handoff_pending,execution_directories)
      VALUES(?,?,?,?,0,0,?,?,?,?,?)`,
    )
    .run(
      resolveWorkspaceKey({ workspacePath: WORKSPACE }),
      WORKSPACE,
      null,
      taskId,
      "local-host",
      WORKSPACE,
      null,
      8,
      null,
    );
}

describe("TaskIndexRepo reservation placeholders", () => {
  it("hides a placeholder from list, queryTaskList and onboarding reads without warning", async () => {
    await repo.syncTaskMeta({ meta: task("live", { updatedAt: 30 }) });
    await insertReservationPlaceholder("reserved");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect((await repo.listTaskMetas({})).map((meta) => meta.taskId)).toEqual(["live"]);
    expect(
      (await repo.listTaskMetas({ workspacePath: WORKSPACE })).map((meta) => meta.taskId),
    ).toEqual(["live"]);
    const page = await repo.queryTaskList({
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      kind: "active",
    });
    expect(page.items.map((item) => item.taskId)).toEqual(["live"]);
    expect(page.total).toBe(1);
    const grouped = await repo.queryGroupedTaskView({
      workspaceScopes: [{ workspacePath: WORKSPACE }],
    });
    expect(JSON.stringify(grouped)).toContain('"taskId":"live"');
    expect(JSON.stringify(grouped)).not.toContain('"reserved"');

    expect(JSON.stringify(warn.mock.calls)).not.toContain(META_WARN);
  });

  it("does not warn when a per-task read reaches a placeholder row", async () => {
    await insertReservationPlaceholder("reserved");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await repo.seedTaskMetaIfMissing(task("reserved"));

    expect(JSON.stringify(warn.mock.calls)).not.toContain(META_WARN);
  });

  it("does not count a placeholder-only index as having tasks", async () => {
    await insertReservationPlaceholder("reserved");

    expect(await repo.hasTaskMetas()).toBe(false);
    expect(await repo.hasTaskMetas({ includeDeleted: true })).toBe(false);
    expect(await repo.listTaskMetas({})).toEqual([]);
  });

  it("lists a placeholder only after CLI facts arrive, with the CLI title", async () => {
    await insertReservationPlaceholder("reserved");

    await repo.applyCliFacts({
      meta: task("reserved", { title: "CLI title", createdAt: 10, updatedAt: 20 }),
      titleSource: "generated",
      lastOutcome: "completed",
    });

    expect(await repo.listTaskMetas({ workspacePath: WORKSPACE })).toEqual([
      expect.objectContaining({ taskId: "reserved", title: "CLI title", createdAt: 10 }),
    ]);
    expect(await repo.hasTaskMetas()).toBe(true);
  });

  it("keeps a normal organization-written row without CLI facts listed", async () => {
    await repo.syncTaskMeta({
      meta: task("draft", { createdAt: 5, updatedAt: 6, title: "Draft" }),
    });

    const listed = await repo.listTaskMetas({});
    expect(listed.map((meta) => meta.taskId)).toEqual(["draft"]);
    expect(listed[0]?.title).toBe("Draft");
  });

  it("keeps a row whose createdAt is 0 listed when its meta_json is real", async () => {
    await repo.syncTaskMeta({
      meta: task("zero-created", { createdAt: 0, updatedAt: 0, title: "Zero" }),
    });

    expect((await repo.listTaskMetas({})).map((meta) => meta.taskId)).toEqual(["zero-created"]);
  });
});
