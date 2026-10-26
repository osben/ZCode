import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

// Upstream (zai-org/ZCode) ledger checksums, frozen in the repo-root baseline so every gate reads
// one source. The fork shares ~/.zcode/v2/tasks-index.sqlite with the upstream app, so any change
// to these migrations' checksumInput makes the other build reject the database. Only checksumInput
// is pinned: 0001/0002 hash semantic markers rather than their backfill/conversion SQL, so edits
// there are not caught here. Never update these values; restore the upstream input instead.
// See specs/upstream-migration-freeze.md.
const baseline = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../fork-upstream-migrations.json", import.meta.url)),
    "utf8",
  ),
);
const UPSTREAM_CHECKSUMS: Record<string, string> = Object.fromEntries(
  baseline.sets["tasks_index:base"].map((entry: { id: string; checksum: string }) => [
    entry.id,
    entry.checksum,
  ]),
);
// Fork ids are 9NNN_fork_* (specs/upstream-migration-freeze.md); everything else is upstream.
const FORK_ID = /^9\d{3}_fork_[a-z0-9_]+$/;

describe("upstream tasks index migration checksum pin", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("pins upstream ids only", () => {
    expect(Object.keys(UPSTREAM_CHECKSUMS).filter((id) => FORK_ID.test(id))).toEqual([]);
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
