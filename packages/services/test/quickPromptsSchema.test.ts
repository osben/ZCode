import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureQuickPromptSchema,
  FORK_QUICK_PROMPTS_MIGRATION_ID,
  FORK_QUICK_PROMPTS_SCHEMA,
} from "../src/quick-prompts/migration.js";
import {
  areTasksDatabaseMigrationsApplied,
  runTasksDatabaseMigrations,
} from "../src/session/tasksDatabase/migrations.js";

// Spec: specs/composer-quick-prompts.md (Storage). Migration 9003_fork_quick_prompts shares the
// tasks-index ledger with upstream; the upstream checksum pin test must not list it.

const FORK_QUICK_PROMPTS_CHECKSUM =
  "ad278f8a8b0916baf9875a0a92702478ba77d3dd34a6d9516cf8d22410eddb02";

function ledger(db: DatabaseSync): Array<{ id: string; checksum: string }> {
  return db
    .prepare("SELECT id, checksum FROM tasks_schema_migration ORDER BY id")
    .all()
    .map((row) => ({ id: String(row.id), checksum: String(row.checksum) }));
}

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fork_quick_prompt%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
}

describe("fork quick prompts schema migration", () => {
  let root: string;
  let path: string;
  const open: DatabaseSync[] = [];

  function connect(): DatabaseSync {
    const db = new DatabaseSync(path);
    open.push(db);
    return db;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-quick-prompts-schema-"));
    path = join(root, "tasks-index.sqlite");
  });

  afterEach(async () => {
    for (const db of open.splice(0)) {
      try {
        db.close();
      } catch {
        // Connections already closed by the test body.
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it("creates both fork tables on a fresh file and records the ledger row with the DDL checksum", () => {
    const db = connect();
    ensureQuickPromptSchema(db);

    expect(tableNames(db)).toEqual(["fork_quick_prompt_hidden", "fork_quick_prompts"]);
    const rows = ledger(db).filter((row) => row.id === FORK_QUICK_PROMPTS_MIGRATION_ID);
    expect(rows).toEqual([
      {
        id: "9003_fork_quick_prompts",
        checksum: createHash("sha256").update(FORK_QUICK_PROMPTS_SCHEMA).digest("hex"),
      },
    ]);
  });

  it("pins the checksum of the shipped DDL string", () => {
    expect(FORK_QUICK_PROMPTS_MIGRATION_ID).toBe("9003_fork_quick_prompts");
    expect(createHash("sha256").update(FORK_QUICK_PROMPTS_SCHEMA).digest("hex")).toBe(
      FORK_QUICK_PROMPTS_CHECKSUM,
    );
  });

  it("is idempotent on the same connection and on a reopened connection", () => {
    const db = connect();
    ensureQuickPromptSchema(db);
    ensureQuickPromptSchema(db);
    db.close();

    const reopened = connect();
    ensureQuickPromptSchema(reopened);
    expect(
      ledger(reopened).filter((row) => row.id === FORK_QUICK_PROMPTS_MIGRATION_ID),
    ).toHaveLength(1);
  });

  it("coexists with the upstream ledger: upstream still reports applied and keeps its rows", async () => {
    const db = connect();
    await runTasksDatabaseMigrations(db, path);
    const upstreamBefore = ledger(db).map((row) => row.id);

    ensureQuickPromptSchema(db);

    expect(areTasksDatabaseMigrationsApplied(db)).toBe(true);
    const after = ledger(db).map((row) => row.id);
    expect(after).toEqual(expect.arrayContaining(upstreamBefore));
    expect(after).toContain(FORK_QUICK_PROMPTS_MIGRATION_ID);
  });

  it("lets the upstream runner keep starting when the fork row is present", async () => {
    const db = connect();
    ensureQuickPromptSchema(db);
    await expect(runTasksDatabaseMigrations(db, path)).resolves.not.toThrow();
    expect(ledger(db).map((row) => row.id)).toContain(FORK_QUICK_PROMPTS_MIGRATION_ID);
  });

  it("applies on a second connection to a file already migrated by another connection", async () => {
    const first = connect();
    await runTasksDatabaseMigrations(first, path);
    ensureQuickPromptSchema(first);

    const second = connect();
    expect(() => ensureQuickPromptSchema(second)).not.toThrow();
    expect(ledger(second).filter((row) => row.id === FORK_QUICK_PROMPTS_MIGRATION_ID)).toHaveLength(
      1,
    );
  });

  it("rejects a tampered ledger checksum instead of reusing the table", () => {
    const db = connect();
    ensureQuickPromptSchema(db);
    db.prepare("UPDATE tasks_schema_migration SET checksum='deadbeef' WHERE id=?").run(
      FORK_QUICK_PROMPTS_MIGRATION_ID,
    );

    const other = connect();
    expect(() => ensureQuickPromptSchema(other)).toThrow(/checksum mismatch/);
  });

  it("takes the write lock with BEGIN IMMEDIATE: a concurrent writer fails busy instead of racing", () => {
    const holder = connect();
    holder.exec(
      "CREATE TABLE IF NOT EXISTS tasks_schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL)",
    );
    holder.exec("BEGIN IMMEDIATE");
    try {
      const contender = connect();
      contender.exec("PRAGMA busy_timeout = 0");
      expect(() => ensureQuickPromptSchema(contender)).toThrow(/locked|busy/i);
    } finally {
      holder.exec("COMMIT");
    }

    const retry = connect();
    ensureQuickPromptSchema(retry);
    expect(ledger(retry).map((row) => row.id)).toContain(FORK_QUICK_PROMPTS_MIGRATION_ID);
  });
});
