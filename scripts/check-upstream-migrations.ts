#!/usr/bin/env -S pnpm exec tsx
// Collects the migration ledger checksums each runner writes on a fresh :memory: database and gates
// them against fork-upstream-migrations.json (specs/upstream-migration-freeze.md). The fork shares
// ~/.zcode/cli/db/db.sqlite and ~/.zcode/v2/tasks-index.sqlite with the upstream app; a changed
// upstream checksum makes the other build reject the shared database.
// Run with pnpm db:migrations:check (or db:migrations:baseline:update).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  appendBaseline,
  checkBaseline,
  effectivePin,
  parseBaseline,
  serializeBaseline,
} from "./upstream-migration-baseline.mjs";
import { sqliteMigrations } from "../packages/shared/src/sqlite-migrations/index.js";
import { FORK_LEDGER_SQL_VARIANTS } from "../apps/zcode-cli/packages/adapters/src/storage/session-store/fork-migrations.js";
import { runSqliteSessionMigrationsAsync } from "../apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.js";
import { runTasksDatabaseMigrations } from "../packages/services/src/session/tasksDatabase/migrations.js";
import { projectStorage } from "../packages/services/src/project-storage/index.js";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const BASELINE_PATH = "fork-upstream-migrations.json";
const PIN_PATH = "fork-upstream-base.json";

/** Ledger row; rowid order is insertion order, which is the application order the gate compares. */
interface LedgerEntry {
  id: string;
  checksum: string;
}

/** Minimal migration shape the shared runner needs; override entries must carry real touchedTables. */
interface MigrationLike {
  id: string;
  sql: string;
  touchedTables: readonly string[];
  appVersion?: string;
  apply?: (db: DatabaseSync) => void;
}

type TasksScope = "base" | "controller-remote" | "source-server";

/**
 * Test hook: per-set migration-list replacement. When provided, the set runs through the shared
 * runner with the options its real entry point passes, so an edited sql goes through the real
 * sha256(sql.trim()) ledger write. Without an override the production entry points are used.
 */
export type MigrationOverrides = Partial<
  Record<
    | "cli"
    | "tasks_index:base"
    | "tasks_index:projects"
    | "tasks_index:controller-remote"
    | "tasks_index:source-server",
    readonly MigrationLike[]
  >
>;

function readLedger(db: DatabaseSync, table: string): LedgerEntry[] {
  // Copy to plain objects: node:sqlite rows carry a null prototype, which breaks deepStrictEqual
  // against JSON.parse'd baseline entries in tests.
  return (
    db.prepare(`SELECT id, checksum FROM ${table} ORDER BY rowid`).all() as unknown as LedgerEntry[]
  ).map((row) => ({ id: row.id, checksum: row.checksum }));
}

async function withTempDirectory<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-upstream-migration-check-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** tasks scopes: runTasksDatabaseMigrations needs a dbPath so migration backups land in the temp dir. */
async function collectTasksScope(
  scope: TasksScope,
  directory: string,
  override: readonly MigrationLike[] | undefined,
): Promise<LedgerEntry[]> {
  const db = new DatabaseSync(":memory:");
  try {
    if (override) {
      // Options mirror runTasksDatabaseMigrations' migrate call: tasks_schema journal in the same DB.
      await sqliteMigrations.migrate(db, override, {
        database: "tasks_schema",
        journalTable: "tasks_schema_migration",
        backupDirectories: [join(directory, "backup")],
      });
    } else {
      await runTasksDatabaseMigrations(db, {
        scope,
        dbPath: join(directory, "v2", "tasks-index.sqlite"),
      });
    }
    return readLedger(db, "tasks_schema_migration");
  } finally {
    db.close();
  }
}

export async function collectLedgers(
  overrides: MigrationOverrides = {},
): Promise<Record<string, LedgerEntry[]>> {
  return withTempDirectory(async (directory) => {
    // cli: the production startup path (WAL/lock scaffolding plus the shared runner) on a fresh database.
    const cli = new DatabaseSync(":memory:");
    let cliEntries: LedgerEntry[];
    try {
      if (overrides.cli) {
        // Options mirror runSqliteSessionMigrationsAsync's migrate call (migration-runner.ts).
        await sqliteMigrations.migrate(cli, overrides.cli, {
          database: "cli",
          appliedAtColumn: "time_applied",
          backupDirectories: [join(directory, "backup")],
        });
      } else {
        await runSqliteSessionMigrationsAsync(cli, ":memory:");
      }
      cliEntries = readLedger(cli, "schema_migration");
    } finally {
      cli.close();
    }

    const base = await collectTasksScope("base", directory, overrides["tasks_index:base"]);
    const controllerRemote = await collectTasksScope(
      "controller-remote",
      directory,
      overrides["tasks_index:controller-remote"],
    );
    const sourceServer = await collectTasksScope(
      "source-server",
      directory,
      overrides["tasks_index:source-server"],
    );

    // projects: runs on a database that already has the base tasks schema, like the real tasks index.
    const projects = new DatabaseSync(":memory:");
    let projectEntries: LedgerEntry[];
    try {
      if (overrides["tasks_index:projects"]) {
        // Options mirror projectStorage.migrate's migrate call (project-storage/index.ts).
        await sqliteMigrations.migrate(projects, overrides["tasks_index:projects"], {
          database: "tasks_index",
          backupDirectories: [join(directory, "backup")],
          now: () => 10,
        });
      } else {
        await runTasksDatabaseMigrations(projects, {
          scope: "base",
          dbPath: join(directory, "v2", "tasks-index.sqlite"),
        });
        await projectStorage.migrate(projects, {
          backupDirectories: [join(directory, "backup")],
          now: () => 10,
          settings: { recentProjects: [], lastWorkspaceSession: [] },
        });
      }
      projectEntries = readLedger(projects, "schema_migration");
    } finally {
      projects.close();
    }

    return {
      cli: cliEntries,
      "tasks_index:base": base,
      "tasks_index:controller-remote": controllerRemote,
      "tasks_index:source-server": sourceServer,
      "tasks_index:projects": projectEntries,
    };
  });
}

interface Baseline {
  upstreamCommit: string;
  sets: Record<string, { id: string; checksum: string }[]>;
  acceptedVariants: Record<string, Record<string, string[]>>;
}

async function readPin(): Promise<string> {
  return effectivePin(JSON.parse(await readFile(PIN_PATH, "utf8"))) as string;
}

async function readBaseline(): Promise<Baseline | null> {
  try {
    return parseBaseline(await readFile(BASELINE_PATH, "utf8"), BASELINE_PATH) as Baseline;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** acceptedVariants are the historical fork-written checksums recorded in FORK_LEDGER_SQL_VARIANTS. */
function deriveAcceptedVariants(variants: readonly { id: string; acceptedChecksum: string }[]) {
  const accepted: Record<string, Record<string, string[]>> = {};
  for (const variant of variants) (accepted.cli ??= {})[variant.id] = [variant.acceptedChecksum];
  return accepted;
}

async function main(): Promise<number> {
  const update = process.argv.includes("--update");
  const dump = process.argv.includes("--json");
  const collected = await collectLedgers();
  if (dump) {
    console.log(JSON.stringify(collected, null, 2));
    return 0;
  }
  const pin = await readPin();
  const baseline = await readBaseline();
  if (update) {
    if (!baseline)
      console.log(`[db:migrations] No baseline at ${BASELINE_PATH}; generating one for ${pin}.`);
    let appended: Baseline;
    try {
      appended = appendBaseline({ baseline: baseline ?? undefined, pin, collected }) as Baseline;
    } catch (error) {
      console.error((error as Error).message);
      return 1;
    }
    appended.acceptedVariants = deriveAcceptedVariants(FORK_LEDGER_SQL_VARIANTS);
    await writeFile(BASELINE_PATH, serializeBaseline(appended));
    const summary = Object.entries(appended.sets)
      .map(([set, entries]) => `${set}: ${entries.length} ids`)
      .join(", ");
    console.log(`[db:migrations] Baseline written for ${pin} (${summary}).`);
    return 0;
  }
  if (!baseline) {
    console.error(
      `[db:migrations] ${BASELINE_PATH} is missing; generate it with ` +
        `pnpm db:migrations:baseline:update. ` +
        `See specs/upstream-migration-freeze.md.`,
    );
    return 1;
  }
  const errors: string[] = checkBaseline({ baseline, pin, collected });
  for (const error of errors) console.error(error);
  if (errors.length) return 1;
  console.log(`[db:migrations] Frozen upstream migrations match the ${pin} baseline (5 sets).`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) process.exitCode = await main();
