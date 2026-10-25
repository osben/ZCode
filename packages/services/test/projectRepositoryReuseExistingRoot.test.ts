import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

// reuseExistingRoot (desktop open-directory intent): one local root resolves to the project already bound to it.
describe("project repository reuseExistingRoot", () => {
  it("returns the local project already bound to the directory instead of creating a duplicate", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const first = repo.saveProject({ roots: ["/a"] });

    expect(repo.saveProject({ roots: ["/a"], reuseExistingRoot: true }).id).toBe(first.id);
    expect(repo.readTree().projects).toHaveLength(1);

    const fresh = repo.saveProject({ roots: ["/b"], reuseExistingRoot: true });
    expect(fresh.id).not.toBe(first.id);
    expect(repo.readTree().projects).toHaveLength(2);
  });

  it("is rejected for multi-root, existing-project and remote-host saves", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const project = repo.saveProject({ roots: ["/a"] });

    expect(() => repo.saveProject({ roots: ["/a", "/b"], reuseExistingRoot: true })).toThrow(
      "project.invalid-directory-open",
    );
    expect(() =>
      repo.saveProject({ id: project.id, roots: ["/a"], reuseExistingRoot: true }),
    ).toThrow("project.invalid-directory-open");

    db.exec("INSERT INTO hosts(host_id,kind) VALUES ('remote:server:s','server')");
    const remote = port.repository(db, "remote:server:s");
    expect(() => remote.saveProject({ roots: ["/remote"], reuseExistingRoot: true })).toThrow(
      "project.invalid-directory-open",
    );
  });
});
