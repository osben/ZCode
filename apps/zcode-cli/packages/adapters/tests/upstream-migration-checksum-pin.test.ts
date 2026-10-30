import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { FORK_LEDGER_SQL_VARIANTS } from "../src/storage/session-store/fork-migrations.js";
import { runSqliteSessionMigrationsAsync } from "../src/storage/session-store/migration-runner.js";

// Upstream (zai-org/ZCode) ledger checksums, frozen in the repo-root baseline so every gate reads
// one source. The fork shares ~/.zcode/cli/db/db.sqlite with the upstream app, so any change to
// these migrations' SQL text, comments included, makes the other build reject the database. Never
// update these values; restore the upstream SQL instead. See specs/upstream-migration-freeze.md.
const baseline = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../../fork-upstream-migrations.json", import.meta.url)),
    "utf8",
  ),
);
const UPSTREAM_CHECKSUMS: Record<string, string> = Object.fromEntries(
  baseline.sets.cli.map((entry: { id: string; checksum: string }) => [entry.id, entry.checksum]),
);
// Fork ids are 9NNN_fork_* (specs/upstream-migration-freeze.md); everything else is upstream.
const FORK_ID = /^9\d{3}_fork_[a-z0-9_]+$/;

describe("upstream session migration checksum pin", () => {
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
    await runSqliteSessionMigrationsAsync(db, ":memory:");
    const ledger = Object.fromEntries(
      db
        .prepare("SELECT id, checksum FROM schema_migration")
        .all()
        .map((row) => [row.id, row.checksum]),
    );
    for (const [id, checksum] of Object.entries(UPSTREAM_CHECKSUMS)) {
      expect({ id, checksum: ledger[id] }).toEqual({ id, checksum });
    }
  });

  it("pins the fork-written translated 0020 checksum to its historical SQL variant", () => {
    const variant = FORK_LEDGER_SQL_VARIANTS.find((entry) => entry.id === "0020_provider_model_selection");
    expect(variant?.acceptedChecksum).toBe("31fdaa50915e6ee967de3d8072a7f98bab64da0ac2864275589e4a2740eda788");
    expect(createHash("sha256").update(variant!.sql.trim()).digest("hex")).toBe(variant?.acceptedChecksum);
  });
});
