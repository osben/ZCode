import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

// Upstream (zai-org/ZCode) ledger checksums. The fork shares ~/.zcode/v2/tasks-index.sqlite with
// the upstream app, so any change to these migrations' checksumInput makes the other build reject
// the database. Only checksumInput is pinned: 0001/0002 hash semantic markers rather than their
// backfill/conversion SQL, so edits there are not caught here. Never update these values; restore
// the upstream input instead.
const UPSTREAM_CHECKSUMS: Record<string, string> = {
  "0001_adopt_task_schema": "3e8337b015d94b05dd31a6003f3acc649e821794cfa288bc0af3022698bd4d17",
  "0002_provider_selection": "7244ef7c351f8d02750ab1953fff09f493a71befbf1b6e2d4bab726b0c6b48fc",
  "0003_official_glm_selection": "8987adb50ae412a46c294141c1af89ccfc252f22d41351bdf4c7528f56edc8b4",
};

describe("upstream tasks index migration checksum pin", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("pins upstream ids only", () => {
    expect(Object.keys(UPSTREAM_CHECKSUMS).filter((id) => id.startsWith("9001_fork_"))).toEqual([]);
  });

  it("a fresh database writes exactly the upstream checksum for every upstream migration", async () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    // Only await was added: the shared runner is async since the upstream 3.16.1 sync. Pinned constants are unchanged.
    await runTasksDatabaseMigrations(db);
    const ledger = Object.fromEntries(
      db
        .prepare("SELECT id, checksum FROM tasks_schema_migration")
        .all()
        .map((row) => [row.id, row.checksum]),
    );
    for (const [id, checksum] of Object.entries(UPSTREAM_CHECKSUMS)) {
      expect({ id, checksum: ledger[id] }).toEqual({ id, checksum });
    }
  });
});
