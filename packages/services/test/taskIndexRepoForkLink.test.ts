import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkspaceKey, type ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const WORKSPACE = "/workspace/fork-link";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-fork-link-"));
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

function rawRow(taskId: string): Record<string, unknown> | undefined {
  const database = (
    repo as unknown as {
      getDatabase(): { prepare(sql: string): { get(...args: unknown[]): unknown } };
    }
  ).getDatabase();
  return database
    .prepare(
      "SELECT host_id, project_id, forked_from_task_id FROM tasks WHERE workspace_key=? AND task_id=?",
    )
    .get(resolveWorkspaceKey({ workspacePath: WORKSPACE }), taskId) as
    | Record<string, unknown>
    | undefined;
}

describe("TaskIndexRepo fork link", () => {
  it("keeps the first stored fork link when a later upsert names another parent", async () => {
    await repo.syncTaskMeta({ meta: task("child", { forkedFromTaskId: "parent-a" }) });
    await repo.syncTaskMeta({
      meta: task("child", { forkedFromTaskId: "parent-b", title: "Renamed fork" }),
    });

    expect(rawRow("child")?.forked_from_task_id).toBe("parent-a");
    expect(await repo.getTaskMeta({ workspacePath: WORKSPACE, taskId: "child" })).toMatchObject({
      forkedFromTaskId: "parent-a",
      title: "Renamed fork",
    });
  });

  it("fills an empty fork link on a later upsert and then keeps it", async () => {
    await repo.syncTaskMeta({ meta: task("child") });
    expect(rawRow("child")?.forked_from_task_id).toBeNull();

    await repo.syncTaskMeta({ meta: task("child", { forkedFromTaskId: "parent-a" }) });
    await repo.syncTaskMeta({ meta: task("child", { forkedFromTaskId: "parent-b" }) });
    expect(rawRow("child")?.forked_from_task_id).toBe("parent-a");
  });
});

describe("TaskIndexRepo fork admission with an unowned parent", () => {
  it("leaves the ACK unclaimed, then claims the child in admitForkSummary once the parent is owned", async () => {
    const projects = await repo.getProjectRepository();
    const project = projects.saveProject({ roots: [WORKSPACE] });
    // The organization writer inserts the parent without an owner, as before its first CLI admission.
    const parent = task("parent");
    await repo.syncTaskMeta({ meta: parent });
    expect(rawRow("parent")?.host_id).toBeNull();

    // The forkAssistant ACK path: an unowned parent gives no claim and writes no child row.
    const child = { workspacePath: WORKSPACE, taskId: "child" };
    expect(
      projects.reserveCreatedTask({
        task: child,
        forkOf: { workspacePath: WORKSPACE, taskId: "parent" },
      }),
    ).toBeNull();
    expect(rawRow("child")).toBeUndefined();

    // The CLI admission of the parent summary gives the parent its owner and project.
    await repo.applyCliFacts({ meta: parent });
    expect(rawRow("parent")).toMatchObject({ host_id: "local", project_id: project.id });

    const admitted = await repo.admitForkSummary({
      meta: task("child", { forkedFromTaskId: "parent" }),
    });
    expect(admitted.changed).toBe(true);
    expect(rawRow("child")).toMatchObject({
      host_id: "local",
      project_id: project.id,
      forked_from_task_id: "parent",
    });
  });
});
