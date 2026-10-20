import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { storageMigrationReportSchema } from "@zcode/shared/sqlite-migrations";
import { openStartupSqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

// TEMPORARY compat path coverage (specs/session-database-migrations.md): the sync open must expose the
// shared MigrationResult shape, because `storage-migrate` feeds it straight into the report schema.
describe("sync compat migrationResult", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  const freshDatabase = async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-sync-compat-result-"));
    directories.push(directory);
    return join(directory, "nested", "sessions.sqlite");
  };

  it("reports applied migrations on a fresh database with backupSkipped true", async () => {
    const path = await freshDatabase();
    const store = openStartupSqliteSessionStore({ dbPath: path });
    try {
      const result = store.migrationResult;
      expect(result).toBeDefined();
      expect(result?.backupSkipped).toBe(true);
      expect(result?.applied).toContain("0023_session_soft_delete_outcome");
      expect(
        storageMigrationReportSchema.safeParse({
          version: 1,
          kind: "storage-migrated",
          ...result,
        }).success,
      ).toBe(true);
    } finally {
      store.close();
    }
  });

  it("reports no applied migrations when the database is reopened", async () => {
    const path = await freshDatabase();
    openStartupSqliteSessionStore({ dbPath: path }).close();
    const store = openStartupSqliteSessionStore({ dbPath: path });
    try {
      expect(store.migrationResult).toEqual({ applied: [], backupSkipped: true });
    } finally {
      store.close();
    }
  });
});
