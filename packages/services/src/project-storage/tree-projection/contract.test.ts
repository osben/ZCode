import { constants } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

describe("project tree read projection", () => {
  it("builds the project tree without reading the full-text search body", async () => {
    const { db, add, context } = await fixture();
    add("searchable", "/repo");
    db.exec(`ALTER TABLE tasks ADD COLUMN meta_json TEXT;
      ALTER TABLE tasks ADD COLUMN searchable_text TEXT;
      UPDATE tasks SET meta_json='{"mode":"plan"}',searchable_text='large body'`);
    await port.migrate(db, context);
    const repo = port.repository(db);
    const reads: string[] = [];
    db.setAuthorizer((action, table, column) => {
      if (action === constants.SQLITE_READ) reads.push(`${table}.${column}`);
      return constants.SQLITE_OK;
    });
    const tasks = repo.readTree().tasks;
    db.setAuthorizer(null);
    expect(tasks.map((task) => [task.taskId, task.mode])).toEqual([["searchable", "plan"]]);
    expect(reads).toContain("tasks.meta_json");
    expect(reads).not.toContain("tasks.searchable_text");
  });
});
