import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteMigrations } from "@zcode/shared/sqlite-migrations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FORK_WORKSPACE_PINS_MIGRATION_ID,
  FORK_WORKSPACE_PINS_SCHEMA,
  ForkWorkspacePinRepo,
} from "../src/session/forkWorkspacePinRepo.js";
import {
  areTasksDatabaseMigrationsApplied,
  runTasksDatabaseMigrations,
} from "../src/session/tasksDatabase/migrations.js";

// Coexistence between the upstream tasks-index ledger and the fork's 9001_fork_* migration.
// Spec: specs/tasks-database-upstream-sync.md (acceptance scenarios 1 and 2).

const UPSTREAM_IDS_AFTER_3_15 = ["0004_project_execution_scopes", "0006_task_group_admissions"];

function ledgerIds(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT id FROM tasks_schema_migration ORDER BY id")
    .all()
    .map((row) => String(row.id));
}

function pinnedKeys(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT workspace_key FROM fork_workspace_pins ORDER BY workspace_key")
    .all()
    .map((row) => String(row.workspace_key));
}

describe("tasks database coexistence: upstream ledger and fork 9001 migration", () => {
  let root: string;
  let path: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-fork-coexist-"));
    // The migration backup directory is derived from the parent of a "v2" folder, as in the app data layout.
    await mkdir(join(root, "v2"));
    path = join(root, "v2", "tasks-index.sqlite");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // Simulates a database last written by the pre-3.16.1 fork build: upstream 0001-0003 applied,
  // the fork 9001 row and fork_workspace_pins table written the way the fork repo writes them, and
  // none of the 3.16.1 migrations. The fork state is written with raw SQL because opening
  // ForkWorkspacePinRepo runs the upstream runner, which would apply the missing migrations first.
  async function createOldForkDatabase(): Promise<void> {
    const db = new DatabaseSync(path);
    await runTasksDatabaseMigrations(db, path);
    db.exec(
      `DELETE FROM tasks_schema_migration WHERE id IN (${UPSTREAM_IDS_AFTER_3_15.map((id) => `'${id}'`).join(",")})`,
    );
    db.exec("DROP TABLE task_group_admissions");
    db.exec(FORK_WORKSPACE_PINS_SCHEMA);
    db.prepare(
      "INSERT INTO tasks_schema_migration (id, checksum, time_applied) VALUES (?,?,?)",
    ).run(
      FORK_WORKSPACE_PINS_MIGRATION_ID,
      createHash("sha256").update(FORK_WORKSPACE_PINS_SCHEMA).digest("hex"),
      Date.now(),
    );
    db.prepare("INSERT INTO fork_workspace_pins (workspace_key, pinned_at) VALUES (?,?)").run(
      "/old/fork/project",
      Date.now(),
    );
    db.close();
  }

  it("opens a database written by the old fork build with the new runner", async () => {
    await createOldForkDatabase();
    const db = new DatabaseSync(path);
    try {
      expect(areTasksDatabaseMigrationsApplied(db)).toBe(false);
      const result = await runTasksDatabaseMigrations(db, path);
      expect(result.applied).toEqual(UPSTREAM_IDS_AFTER_3_15);
      expect(ledgerIds(db)).toEqual(
        expect.arrayContaining([
          "0001_adopt_task_schema",
          "0002_provider_selection",
          "0003_official_glm_selection",
          "9001_fork_workspace_pins",
          ...UPSTREAM_IDS_AFTER_3_15,
        ]),
      );
      // The fork row is ignored by the upstream checks and its checksum is not rewritten.
      expect(
        db
          .prepare(
            "SELECT checksum FROM tasks_schema_migration WHERE id='9001_fork_workspace_pins'",
          )
          .get(),
      ).toBeDefined();
      expect(pinnedKeys(db)).toEqual(["/old/fork/project"]);
      expect(areTasksDatabaseMigrationsApplied(db)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("keeps fork_workspace_pins and the 9001 row through an upstream backup and restore", async () => {
    await createOldForkDatabase();
    const db = new DatabaseSync(path);
    try {
      const result = await runTasksDatabaseMigrations(db, path);
      expect(result.backupPath).toBeDefined();
      const pins = new ForkWorkspacePinRepo(path);
      await pins.setWorkspacePinned({ workspaceKey: "/written/after/upgrade", pinned: true });
      pins.close();

      await sqliteMigrations.restore(db, result.backupPath!);

      // Restore deletes only the ledger rows of the migrations it restores and only touches their tables.
      expect(ledgerIds(db)).toContain("9001_fork_workspace_pins");
      for (const id of UPSTREAM_IDS_AFTER_3_15) expect(ledgerIds(db)).not.toContain(id);
      expect(pinnedKeys(db)).toEqual(["/old/fork/project", "/written/after/upgrade"]);

      // The restored database upgrades again and the fork table is still intact.
      await runTasksDatabaseMigrations(db, path);
      expect(areTasksDatabaseMigrationsApplied(db)).toBe(true);
      expect(pinnedKeys(db)).toEqual(["/old/fork/project", "/written/after/upgrade"]);
    } finally {
      db.close();
    }
  });
});
