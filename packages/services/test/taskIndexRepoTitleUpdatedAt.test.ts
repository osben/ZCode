import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "zcode-task-index-title-recency-"));
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
  await rm(tempDir, { recursive: true, force: true });
});

const workspacePath = "/workspace/title-recency";

function baseMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-title-recency",
    traceId: "trace-title-recency",
    title: "Initial",
    workspacePath,
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    model: "model-under-test",
    status: "running",
    ...overrides,
  };
}

describe("applyCliFacts titleUpdatedAt on an admitted row", () => {
  it("updates titleUpdatedAt through later CLI facts and keeps other meta keys", async () => {
    // Seed the row first so the CLI fact takes the existing-row UPDATE path, not the reservation/first-admission write.
    await repo.syncTaskMeta({ meta: baseMeta() });

    await repo.applyCliFacts({
      meta: baseMeta({ title: "First rename", titleUpdatedAt: 100, updatedAt: 30 }),
      titleSource: "custom",
    });
    const second = await repo.applyCliFacts({
      meta: baseMeta({ title: "Second rename", titleUpdatedAt: 200, updatedAt: 30 }),
      titleSource: "custom",
    });

    expect(second).toMatchObject({
      title: "Second rename",
      titleUpdatedAt: 200,
      model: "model-under-test",
      mode: "default",
      traceId: "trace-title-recency",
      createdAt: 10,
      updatedAt: 30,
    });
    expect(await repo.getTaskMeta({ workspacePath, taskId: "task-title-recency" })).toMatchObject({
      titleUpdatedAt: 200,
      model: "model-under-test",
    });
  });

  it("keeps the stored value when a later fact omits it, and never writes invalid values", async () => {
    await repo.syncTaskMeta({ meta: baseMeta() });
    await repo.applyCliFacts({
      meta: baseMeta({ title: "Stored", titleUpdatedAt: 500 }),
      titleSource: "custom",
    });

    await repo.applyCliFacts({ meta: baseMeta({ title: "Stored" }), titleSource: "custom" });
    const invalid = [-1, 1.5, Number.NaN] as const;
    for (const titleUpdatedAt of invalid) {
      await repo.applyCliFacts({
        meta: baseMeta({ title: "Stored", titleUpdatedAt }),
        titleSource: "custom",
      });
    }

    expect(await repo.getTaskMeta({ workspacePath, taskId: "task-title-recency" })).toMatchObject({
      titleUpdatedAt: 500,
      model: "model-under-test",
    });
  });
});
