import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

// Mirrors the row the fork child leaves in tasks-index.sqlite: the organization writer (syncTaskMeta) inserts
// it with created_at set but no host, root, or project, and no CLI admission has run yet.
function insertLegacyForkRow(db: import("node:sqlite").DatabaseSync, taskId: string, path: string) {
  db.prepare(
    "INSERT INTO tasks(workspace_key,workspace_path,task_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  ).run(path, path, taskId, "Fork of parent", 1792652926080, 1792652926082);
}

describe("forked session ownership", () => {
  it("claims a legacy fork row for the parent's project, cwd and frozen directories", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const project = repo.saveProject({ roots: ["/repo", "/extra"] });
    const parent = { workspacePath: "/repo", taskId: "parent" };
    repo.reserveCreatedTask({ task: parent, projectId: project.id });
    insertLegacyForkRow(db, "child", "/repo");
    const child = { workspacePath: "/repo", taskId: "child" };
    expect(() => repo.resolveSessionDirectories(child)).toThrow("project.host-mismatch");

    expect(repo.reserveCreatedTask({ task: child, forkOf: parent })).toEqual({
      workspacePath: "/repo",
      projectId: project.id,
      additionalDirectories: ["/extra"],
    });
    expect(
      db.prepare("SELECT host_id, project_id, root_path FROM tasks WHERE task_id='child'").get(),
    ).toEqual({ host_id: "local", project_id: project.id, root_path: "/repo" });

    // Later project edits must not move a fork that already froze its directories.
    repo.saveProject({ id: project.id, roots: ["/repo", "/other"] });
    expect(repo.resolveSessionDirectories(child)).toEqual({
      workspacePath: "/repo",
      projectId: project.id,
      additionalDirectories: ["/extra"],
    });
  });

  it("does not re-claim a fork row that already has an owner", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const first = repo.saveProject({ roots: ["/repo"] });
    const second = repo.saveProject({ roots: ["/repo", "/second"] });
    const parent = { workspacePath: "/repo", taskId: "parent" };
    repo.reserveCreatedTask({ task: parent, projectId: first.id });
    const child = { workspacePath: "/repo", taskId: "child" };
    repo.reserveCreatedTask({ task: child, forkOf: parent });
    db.prepare("UPDATE tasks SET project_id=? WHERE task_id='child'").run(second.id);
    expect(repo.reserveCreatedTask({ task: child, forkOf: parent }).projectId).toBe(second.id);
  });

  it("rejects a fork in a foreign-host workspace and leaves the child unowned", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    db.exec("INSERT INTO hosts(host_id,kind) VALUES ('remote:server:s','server')");
    const foreign = port.repository(db, "remote:server:s");
    const remoteProject = foreign.saveProject({ roots: ["/remote"] });
    const parent = {
      workspacePath: "/remote",
      workspaceIdentity: "remote:server:s:/remote",
      taskId: "parent",
    };
    foreign.reserveCreatedTask({ task: parent, projectId: remoteProject.id });
    const child = { ...parent, taskId: "child" };
    db.prepare(
      "INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(parent.workspaceIdentity, "/remote", parent.workspaceIdentity, "child", "Fork", 1, 1);
    // The child shares the remote workspace key, so the local writer refuses it at the key guard before any claim.
    expect(() => port.repository(db).reserveCreatedTask({ task: child, forkOf: parent })).toThrow(
      "project.cross-host-move",
    );
    expect(db.prepare("SELECT host_id FROM tasks WHERE task_id='child'").get()).toEqual({
      host_id: null,
    });
  });

  it("refuses to fork from a parent that the host has never reserved", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    expect(() =>
      repo.reserveCreatedTask({
        task: { workspacePath: "/repo", taskId: "child" },
        forkOf: { workspacePath: "/repo", taskId: "missing-parent" },
      }),
    ).toThrow("project.fork-parent-missing");
  });
});
