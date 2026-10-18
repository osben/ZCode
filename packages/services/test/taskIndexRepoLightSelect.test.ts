import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const WORKSPACE = "/workspace/project";
const BODY_TEXT = "needle-in-the-body discussion about retry budgets";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-light-select-"));
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

/** Captures every SQL string the repo prepares while `run` executes. */
async function capturePreparedSql(run: () => Promise<unknown>): Promise<string[]> {
  const database = (
    repo as unknown as { getDatabase(): { prepare(sql: string): unknown } }
  ).getDatabase();
  const original = database.prepare.bind(database);
  const sql: string[] = [];
  vi.spyOn(database, "prepare").mockImplementation((statement: string) => {
    sql.push(statement);
    return original(statement);
  });
  await run();
  return sql;
}

describe("TaskIndexRepo light selects (ZCO-39 stage 1)", () => {
  beforeEach(async () => {
    await repo.syncTaskMeta({
      meta: task("alpha", { updatedAt: 30 }),
      searchableText: BODY_TEXT,
    });
    await repo.syncTaskMeta({
      meta: task("beta", { updatedAt: 20, cronAutomationId: "auto-1" }),
      pinned: true,
    });
    await repo.syncTaskMeta({ meta: task("gamma", { updatedAt: 10 }), archived: true });
    await repo.syncTaskMeta({ meta: task("gone", { updatedAt: 5 }), deleted: true });
  });

  it("listTaskMetas keeps filters and ordering without selecting search text", async () => {
    let all: ZCodeTaskMeta[] = [];
    const sql = await capturePreparedSql(async () => {
      all = await repo.listTaskMetas({});
    });

    expect(all.map((meta) => meta.taskId)).toEqual(["alpha", "beta", "gamma"]);
    expect(sql.join("\n")).not.toContain("searchable_text");
    expect((await repo.listTaskMetas({ pinned: true })).map((meta) => meta.taskId)).toEqual([
      "beta",
    ]);
    expect((await repo.listTaskMetas({ archived: true })).map((meta) => meta.taskId)).toEqual([
      "gamma",
    ]);
    expect(
      (await repo.listTaskMetas({ workspacePath: WORKSPACE, includeDeleted: true })).map(
        (meta) => meta.taskId,
      ),
    ).toEqual(["alpha", "beta", "gamma", "gone"]);
  });

  it("listSessionsByAutomation returns the same metas without selecting search text", async () => {
    let sessions: ZCodeTaskMeta[] = [];
    const sql = await capturePreparedSql(async () => {
      sessions = await repo.listSessionsByAutomation("auto-1");
    });

    expect(sessions.map((meta) => meta.taskId)).toEqual(["beta"]);
    expect(sql.join("\n")).not.toContain("searchable_text");
  });

  it("queryTaskList skips search text without a term and still builds snippets with one", async () => {
    let active: Awaited<ReturnType<TaskIndexRepo["queryTaskList"]>> | undefined;
    const sql = await capturePreparedSql(async () => {
      active = await repo.queryTaskList({
        workspaceScopes: [{ workspacePath: WORKSPACE }],
        kind: "active",
      });
    });

    expect(active?.items.map((item) => item.taskId)).toEqual(["alpha"]);
    expect(active?.items[0]?.searchSnippet).toBeUndefined();
    expect(active?.total).toBe(1);
    expect(sql.join("\n")).not.toContain("searchable_text");

    const searched = await repo.queryTaskList({
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      kind: "active",
      search: "needle-in-the-body",
    });
    expect(searched.items.map((item) => item.taskId)).toEqual(["alpha"]);
    expect(searched.items[0]?.searchSnippet).toContain("needle-in-the-body");
  });

  it("keeps stored search text when a task is updated after light reads", async () => {
    await repo.listTaskMetas({});
    await repo.syncTaskMeta({ meta: task("alpha", { updatedAt: 40, title: "renamed" }) });

    const searched = await repo.queryTaskList({
      workspaceScopes: [{ workspacePath: WORKSPACE }],
      kind: "active",
      search: "retry budgets",
    });
    expect(searched.items.map((item) => item.taskId)).toEqual(["alpha"]);
  });
});

describe("TaskIndexRepo.hasTaskMetas", () => {
  it("is false on an empty index", async () => {
    expect(await repo.hasTaskMetas()).toBe(false);
  });

  it("is true with a live task and issues an EXISTS statement", async () => {
    await repo.syncTaskMeta({ meta: task("alpha") });

    let result = false;
    const sql = await capturePreparedSql(async () => {
      result = await repo.hasTaskMetas();
    });

    expect(result).toBe(true);
    expect(sql.join("\n")).toMatch(/EXISTS/i);
  });

  it("ignores deleted tasks unless includeDeleted is set", async () => {
    await repo.syncTaskMeta({ meta: task("gone"), deleted: true });

    expect(await repo.hasTaskMetas()).toBe(false);
    expect(await repo.hasTaskMetas({ includeDeleted: true })).toBe(true);
  });

  it("agrees with listTaskMetas for the onboarding check", async () => {
    for (const deleted of [true, false]) {
      await repo.syncTaskMeta({ meta: task(deleted ? "gone" : "live"), deleted });
      expect(await repo.hasTaskMetas()).toBe((await repo.listTaskMetas({})).length > 0);
    }
  });
});
