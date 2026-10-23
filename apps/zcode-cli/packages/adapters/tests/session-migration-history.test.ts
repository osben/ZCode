import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { storageMigrationReportSchema } from "@zcode/shared/sqlite-migrations";
import { afterEach, describe, expect, it } from "vitest";
import { openStartupSqliteSessionStore } from "../src/storage/index.js";
import { SESSION_DATABASE_MIGRATIONS } from "../src/storage/session-store/fork-migrations.js";
import {
  runSqliteSessionMigrationsAsync,
} from "../src/storage/session-store/migration-runner.js";

// Real sqlite fixtures of the histories that reach this build (see specs/session-database-migrations.md):
//   fork-head-execution-worktree.sqlite  written by the pre-PR fork build (ledger has 0023_session_execution_worktree)
//   upstream-3.16.1.sqlite               written by a pure upstream 3.16.1 build
//   fork-translated-0020.sqlite          written by the fork build whose 0020 ledger row carries translated SQL comments
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/session-db/", import.meta.url));
const UPSTREAM_0020 = "681180b4fcb497e13289b6970021678f24c975efdf3538777541105c5b2b444e";
const TRANSLATED_0020 = "31fdaa50915e6ee967de3d8072a7f98bab64da0ac2864275589e4a2740eda788";
const OLD_EXECUTION_ID = "0023_session_execution_worktree";
const NEW_EXECUTION_ID = "9002_fork_session_execution_worktree";
// Fork ACP binding migrations (specs/acp-agent-runtime.md "S5", "S6"): pending on every fixture.
const ACP_BINDING_IDS = [
  "9003_fork_session_acp_binding",
  "9004_fork_session_acp_config",
  "9005_fork_session_acp_pending_choice",
];

const roots: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) if (db.isOpen) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Copies a fixture into `<root>/cli/db/db.sqlite` so the runner sees the real data layout and the fixture stays pristine. */
async function copyFixture(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-migration-history-"));
  roots.push(root);
  const dir = join(root, "cli", "db");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "db.sqlite");
  await copyFile(join(FIXTURE_DIR, name), path);
  return path;
}

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  databases.push(db);
  return db;
}

function ledger(db: DatabaseSync): Map<string, { checksum: string; time_applied: number }> {
  return new Map(
    db
      .prepare("select id, checksum, time_applied from schema_migration")
      .all()
      .map((row) => [
        String(row.id),
        { checksum: String(row.checksum), time_applied: Number(row.time_applied) },
      ]),
  );
}

function sessionColumns(db: DatabaseSync): string[] {
  return db
    .prepare("pragma table_info(session)")
    .all()
    .map((row) => String(row.name));
}

function seedRows(db: DatabaseSync) {
  return {
    sessions: db.prepare("select id, title, directory from session order by id").all(),
    messages: db.prepare("select id, data from message order by id").all(),
    parts: db.prepare("select id, data from part order by id").all(),
  };
}

describe("session database history: fork build DB before the PR opens with the new build (scenario A)", () => {
  it("applies only the upstream ids that are missing and relocates the fork execution row", async () => {
    const path = await copyFixture("fork-head-execution-worktree.sqlite");
    const probe = open(path);
    const before = ledger(probe);
    const seedBefore = seedRows(probe);
    expect(before.has(OLD_EXECUTION_ID)).toBe(true);
    expect(before.has("0023_session_soft_delete_outcome")).toBe(false);
    probe.close();

    const db = open(path);
    const result = await runSqliteSessionMigrationsAsync(db, path);
    expect(result.applied).toEqual([
      "0023_session_soft_delete_outcome",
      "0024_session_database_identity",
      ...ACP_BINDING_IDS,
    ]);
    expect(result.backupSkipped).toBe(false);

    const after = ledger(db);
    // Every row the pre-PR build wrote keeps its checksum and timestamp.
    for (const [id, row] of before) expect(after.get(id)).toEqual(row);
    // The relocated execution id is a copy of the old row: same checksum, not re-run.
    expect(after.get(NEW_EXECUTION_ID)).toEqual(before.get(OLD_EXECUTION_ID));
    // Upstream 0020 keeps its upstream checksum; the fork build wrote it from identical SQL.
    expect(after.get("0020_provider_model_selection")?.checksum).toBe(UPSTREAM_0020);

    const columns = sessionColumns(db);
    for (const column of [
      "execution_directory",
      "execution_branch",
      "fork_incognito",
      "time_deleted",
      "last_outcome",
    ]) {
      expect(columns).toContain(column);
    }
    expect(seedRows(db)).toEqual(seedBefore);
  });

  it("is idempotent on reopen", async () => {
    const path = await copyFixture("fork-head-execution-worktree.sqlite");
    const first = open(path);
    await runSqliteSessionMigrationsAsync(first, path);
    const snapshot = ledger(first);
    first.close();

    const second = open(path);
    const result = await runSqliteSessionMigrationsAsync(second, path);
    expect(result.applied).toEqual([]);
    expect(ledger(second)).toEqual(snapshot);
    second.close();
  });

  it("ignores fork ledger rows this build does not own (the fork usage rollup id)", async () => {
    const path = await copyFixture("fork-head-execution-worktree.sqlite");
    const db = open(path);
    db.prepare("insert into schema_migration (id, checksum, app_version, time_applied) values (?, ?, ?, ?)").run(
      "9001_fork_usage_rollup",
      "not-a-real-checksum",
      "0.16.9",
      1,
    );
    await expect(runSqliteSessionMigrationsAsync(db, path)).resolves.toMatchObject({
      backupSkipped: false,
    });
    expect(ledger(db).get("9001_fork_usage_rollup")?.checksum).toBe("not-a-real-checksum");
  });
});

describe("session database history: pure upstream 3.16.1 DB opens with the fork build (scenario B)", () => {
  it("applies the fork-owned ids and keeps every upstream ledger row untouched", async () => {
    const path = await copyFixture("upstream-3.16.1.sqlite");
    const db = open(path);
    const before = ledger(db);
    const seedBefore = seedRows(db);
    const result = await runSqliteSessionMigrationsAsync(db, path);
    expect(result.applied).toEqual(["9001_fork_session_incognito", NEW_EXECUTION_ID, ...ACP_BINDING_IDS]);
    const after = ledger(db);
    for (const [id, row] of before) expect(after.get(id)).toEqual(row);
    // The upstream soft-delete columns already exist; the fork build must not re-add them.
    expect(sessionColumns(db)).toEqual(expect.arrayContaining(["time_deleted", "last_outcome", "fork_incognito", "execution_directory"]));
    expect(seedRows(db)).toEqual(seedBefore);
  });
});

describe("session database history: fork build DB with translated 0020 SQL comments (scenario C)", () => {
  it("accepts the translated ledger row without rerunning or rewriting it", async () => {
    const path = await copyFixture("fork-translated-0020.sqlite");
    const db = open(path);
    const before = ledger(db);
    expect(before.get("0020_provider_model_selection")?.checksum).toBe(TRANSLATED_0020);
    const seedBefore = seedRows(db);
    const result = await runSqliteSessionMigrationsAsync(db, path);
    expect(result.applied).toEqual([
      "0023_session_soft_delete_outcome",
      "0024_session_database_identity",
      ...ACP_BINDING_IDS,
    ]);
    const after = ledger(db);
    expect(after.get("0020_provider_model_selection")).toEqual(before.get("0020_provider_model_selection"));
    expect(seedRows(db)).toEqual(seedBefore);
  });

  it("keeps the translated variant accepted by the runner's preflight for every reopen", async () => {
    const path = await copyFixture("fork-translated-0020.sqlite");
    const db = open(path);
    await runSqliteSessionMigrationsAsync(db, path);
    expect(ledger(db).get("0020_provider_model_selection")?.checksum).toBe(TRANSLATED_0020);
  });
});

describe("session database history: fresh database (scenario D)", () => {
  it("writes every session migration exactly once in list order", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-migration-fresh-"));
    roots.push(root);
    const path = join(root, "cli", "db", "db.sqlite");
    await mkdir(join(root, "cli", "db"), { recursive: true });
    const db = open(path);
    const result = await runSqliteSessionMigrationsAsync(db, path);
    expect(result.applied).toEqual(SESSION_DATABASE_MIGRATIONS.map((migration) => migration.id));
    expect([...ledger(db).keys()].sort()).toEqual(SESSION_DATABASE_MIGRATIONS.map((migration) => migration.id).sort());
  });
});

describe("session database history: rollback to the pre-PR fork build (scenario E)", () => {
  it("leaves every ledger row the pre-PR build knows with the checksum that build computes", async () => {
    const path = await copyFixture("fork-head-execution-worktree.sqlite");
    const headFixture = open(path);
    const preRow = ledger(headFixture);
    headFixture.close();

    const db = open(path);
    await runSqliteSessionMigrationsAsync(db, path);
    const after = ledger(db);
    // Ids the pre-PR build lists (its runner raises on any checksum mismatch for these ids).
    const preIds = [...preRow.keys()];
    for (const id of preIds) expect(after.get(id)?.checksum).toBe(preRow.get(id)?.checksum);
    // The columns the pre-PR build reads and writes are still present.
    expect(sessionColumns(db)).toEqual(expect.arrayContaining(["execution_directory", "execution_branch", "fork_incognito"]));
  });
});

// Regression: the fork's synchronous startup open ran pending migrations with no table backup and reported
// `backupSkipped: true`. The startup entry point must take the backup for a pending upgrade and report it.
describe("session database startup open takes the backup for a pending upgrade", () => {
  it("reports a backup directory with the table snapshot and the storage-migrated report shape", async () => {
    const path = await copyFixture("upstream-3.16.1.sqlite");
    const root = join(path, "..", "..", "..");
    const store = await openStartupSqliteSessionStore({ dbPath: path });
    try {
      const result = store.migrationResult;
      expect(result.applied).toContain(NEW_EXECUTION_ID);
      expect(result.backupSkipped).toBe(false);
      expect(result.backupPath).toBeDefined();
      expect(result.backupPath?.startsWith(join(root, "backup"))).toBe(true);
      expect(existsSync(join(result.backupPath!, "tables.sqlite"))).toBe(true);
      expect(existsSync(join(result.backupPath!, "backup.json"))).toBe(true);
      expect(
        storageMigrationReportSchema.parse({ version: 1, kind: "storage-migrated", ...result }),
      ).toEqual({ version: 1, kind: "storage-migrated", ...result });
    } finally {
      store.close();
    }
  });
});
