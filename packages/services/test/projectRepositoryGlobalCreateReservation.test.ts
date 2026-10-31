import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

describe("global create reservation (projectId = null)", () => {
  it("reserves an outside-project task with NULL ownership and never invents a project", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    repo.saveProject({ roots: ["/sandbox"] });
    const task = { workspacePath: "/workspace/uuid", taskId: "global-ok" };
    // The plain create result also carries the Host-allocated taskId (upstream creation receipts).
    expect(repo.reserveCreatedTask({ task, projectId: null })).toEqual({
      workspacePath: "/workspace/uuid",
      projectId: null,
      additionalDirectories: [],
      taskId: "global-ok",
    });
    expect(db.prepare("SELECT project_id FROM tasks WHERE task_id='global-ok'").get()).toEqual({
      project_id: null,
    });
  });

  it("rejects a create that names a project the host does not know, without writing a row", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const task = { workspacePath: "/workspace/uuid", taskId: "ghost-project" };
    expect(() => repo.reserveCreatedTask({ task, projectId: "stale-project-id" })).toThrow(
      "project.not-found",
    );
    expect(db.prepare("SELECT 1 FROM tasks WHERE task_id='ghost-project'").get()).toBeUndefined();
  });
});
