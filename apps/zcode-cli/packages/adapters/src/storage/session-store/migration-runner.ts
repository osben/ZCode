import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  classifyDatabaseStartupError,
  databaseMigrationIdSchema,
  databaseStartupErrorDetails,
  type DatabaseMigrationFacts,
} from "@zcode/shared";
import {
  MigrationChecksumError,
  ensureSqliteSchemaMigrationTable,
  SqliteSchemaMigrationChecksumError,
  sqliteMigrations,
} from "@zcode/shared/sqlite-migrations";
import type { MigrationResult, SqliteMigration } from "@zcode/shared/sqlite-migrations";
import { SqliteSessionMigrationError } from "./errors.js";
import { resolveSessionDatabaseMigrations } from "./fork-migrations.js";
import type { SchemaMigrationRow } from "./rows.js";

export const DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS = 5_000;

const SQLITE_BUSY = 5;
const WAL_RETRY_INITIAL_DELAY_MS = 10;
const WAL_RETRY_MAX_DELAY_MS = 200;
const ASYNC_NATIVE_BUSY_TIMEOUT_MS = 25;
export const DEFAULT_SQLITE_MIGRATION_WAIT_MS = 60 * 60_000;
const waitBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type SqliteMigrationPhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "committing"
  | "ready"
  | "failed";

export interface SqliteMigrationProgress {
  phase: SqliteMigrationPhase;
  migration?: DatabaseMigrationFacts;
  elapsedMs: number;
  migrationId?: string;
  completed?: number;
  total?: number;
  errorCode?: string;
  sqliteCode?: number;
  systemCode?: string;
}

export interface AsyncSqliteMigrationOptions {
  lockWaitTimeoutMs?: number;
  onProgress?: (progress: SqliteMigrationProgress) => Promise<void>;
}

/**
 * Production startup path. Order: WAL check, fix-up of fork ledger aliases, preflight (display only),
 * then `BEGIN IMMEDIATE` and the shared migrate runner (checksums, table backup, one transaction).
 */
export async function runSqliteSessionMigrations(
  db: DatabaseSync,
  dbPath: string,
  lockTimeoutMs = DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
): Promise<MigrationResult> {
  return runSqliteSessionMigrationsAsync(db, dbPath, { lockWaitTimeoutMs: lockTimeoutMs });
}

export async function runSqliteSessionMigrationsAsync(
  db: DatabaseSync,
  dbPath: string,
  options: AsyncSqliteMigrationOptions = {},
): Promise<MigrationResult> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.lockWaitTimeoutMs ?? DEFAULT_SQLITE_MIGRATION_WAIT_MS);
  let migration: DatabaseMigrationFacts | undefined;
  let migrationId: string | undefined;
  let progressError: unknown;
  const progress = async (
    phase: SqliteMigrationPhase,
    extra: Partial<SqliteMigrationProgress> = {},
  ) => {
    try {
      await options.onProgress?.({
        phase,
        elapsedMs: Date.now() - startedAt,
        ...(migration ? { migration: { ...migration } } : {}),
        ...extra,
      });
    } catch (error) {
      progressError = error;
      throw error;
    }
  };
  const acquire = async (operation: () => void) => {
    let waiting = false;
    let delay = WAL_RETRY_INITIAL_DELAY_MS;
    for (;;) {
      try {
        operation();
        return;
      } catch (error) {
        if (!isSqliteBusyError(error)) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw lockTimeoutError(error, dbPath);
        if (!waiting) {
          waiting = true;
          await progress("waiting_for_lock");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
        delay = Math.min(WAL_RETRY_MAX_DELAY_MS, delay * 2);
      }
    }
  };
  db.exec(`pragma busy_timeout = ${ASYNC_NATIVE_BUSY_TIMEOUT_MS}`);
  try {
    await progress("checking");
    db.exec("pragma foreign_keys = on");
    await acquire(() => {
      const current = readJournalMode(db);
      if (current === "wal" || isMemoryJournalMode(dbPath, current)) return;
      const mode = readJournalMode(db, true);
      if (mode !== "wal" && !isMemoryJournalMode(dbPath, mode))
        throw new SqliteSessionMigrationError(
          `SQLite refused WAL journal mode for ${dbPath}; received ${mode}`,
          { dbPath, kind: "sql_failed" },
        );
    });
    await acquire(() => {
      migration = {
        kind: inspectMigrationKind(db, dbPath),
        executedCount: 0,
        committedCount: 0,
      };
    });
    await progress("checking");
    await acquire(() => db.exec("begin immediate"));
    ensureSqliteSchemaMigrationTable(db);
    const baseline = db.prepare("SELECT id FROM schema_migration ORDER BY id DESC LIMIT 1").get();
    migration!.lastAppliedMigrationId = baseline
      ? databaseMigrationIdSchema.safeParse(baseline.id).data
      : null;
    const directory = dirname(dbPath);
    const dataRoot =
      basename(directory) === "db" && basename(dirname(directory)) === "cli"
        ? dirname(dirname(directory))
        : directory;
    // Resolved inside the write transaction: the ledger read here is the one the runner migrates.
    const migrations = resolveSessionDatabaseMigrations(db);
    const result = await sqliteMigrations.migrate(db, migrations, {
      database: "cli",
      transactionOpen: true,
      appliedAtColumn: "time_applied",
      backupDirectories: [
        dbPath === ":memory:"
          ? join(tmpdir(), "zcode-memory-migration-backup")
          : join(dataRoot, "backup"),
      ],
      onBeforeApply: async (id) => {
        migrationId = id;
        if (migration!.kind === "none") migration!.kind = "upgrade";
        await progress("migrating", {
          migrationId: id,
          completed: migration!.executedCount,
          total: migrations.length,
        });
      },
      onApplied: () => {
        migration!.executedCount++;
      },
      onCommitting: () => progress("committing"),
      onBackupSkipped: () =>
        process.emitWarning(`SQLite migration backup skipped: ${dbPath}`, {
          code: "ZCODE_MIGRATION_BACKUP_SKIPPED",
        }),
    });
    migration!.committedCount = migration!.executedCount;
    await progress("ready");
    return result;
  } catch (error) {
    if (db.isOpen && db.isTransaction) {
      try {
        db.exec("rollback");
      } catch {
        /* Keep the first error. */
      }
    }
    const normalized =
      error instanceof MigrationChecksumError
        ? new SqliteSessionMigrationError(error.message, {
            cause: error,
            dbPath,
            kind: "checksum_mismatch",
            migrationId: error.migrationId,
          })
        : normalizeMigrationError(error, dbPath, migrationId);
    try {
      await progress("failed", {
        errorCode: normalized.kind,
        ...databaseStartupErrorDetails(normalized),
        migrationId: normalized.migrationId,
      });
    } catch {
      /* A failed notification must not hide the database error. */
    }
    // A notification port error keeps its original object and is not wrapped by the database error.
    throw error === progressError ? error : normalized;
  } finally {
    if (db.isOpen) db.exec(`pragma busy_timeout = ${DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS}`);
  }
}

/**
 * Compatibility path for the synchronous factories (`createSqliteSessionStore`,
 * `openStartupSqliteSessionStore`). It applies the same ledger rules as the async runner but takes
 * no table backup and cannot yield. Remove together with the sync factories (see the spec).
 */
export function runSqliteSessionMigrationsSync(
  db: DatabaseSync,
  dbPath: string,
  lockTimeoutMs = DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
): MigrationResult {
  const deadline = Date.now() + Math.max(0, lockTimeoutMs);
  db.exec("pragma foreign_keys = on");
  retryBusySync(deadline, dbPath, () => {
    const journal = readJournalMode(db);
    if (journal === "wal" || isMemoryJournalMode(dbPath, journal)) return;
    const mode = readJournalMode(db, true);
    if (mode !== "wal" && !isMemoryJournalMode(dbPath, mode))
      throw new SqliteSessionMigrationError(
        `SQLite refused WAL journal mode for ${dbPath}; received ${mode}`,
        { dbPath, kind: "sql_failed" },
      );
  });
  retryBusySync(deadline, dbPath, () => db.exec("begin immediate"));
  try {
    ensureSqliteSchemaMigrationTable(db);
    const applied: string[] = [];
    for (const migration of resolveSessionDatabaseMigrations(db))
      if (applyLedgerStep(db, dbPath, migration)) applied.push(migration.id);
    db.exec("commit");
    // Sync compat never takes the table backup, so the shape reports backupSkipped as true.
    return { applied, backupSkipped: true };
  } catch (error) {
    if (db.isTransaction) db.exec("rollback");
    throw error instanceof SqliteSessionMigrationError ||
      error instanceof MigrationChecksumError ||
      error instanceof SqliteSchemaMigrationChecksumError
      ? error
      : normalizeMigrationError(error, dbPath);
  }
}

/**
 * Applies one migration to a ledger inside the caller's write transaction (sync compat only).
 * Returns true only when the migration SQL ran; a relocated previousIds row does not count as applied.
 */
function applyLedgerStep(db: DatabaseSync, dbPath: string, migration: SqliteMigration): boolean {
  const current = migrationChecksum(migration.sql);
  const ids = [migration.id, ...(migration.previousIds ?? [])];
  const applied = ids
    .map((id) => ({ id, row: readAppliedMigration(db, id) }))
    .filter((entry): entry is { id: string; row: SchemaMigrationRow } => entry.row !== undefined);
  for (const entry of applied)
    ensureMigrationChecksum(entry.id, entry.row.checksum, current, dbPath);
  if (!applied.length) {
    if (migration.apply) migration.apply(db);
    else db.exec(migration.sql);
    db.prepare(
      "insert into schema_migration (id, checksum, app_version, time_applied) values (?, ?, ?, ?)",
    ).run(migration.id, current, migration.appVersion, Date.now());
    return true;
  }
  if (!applied.some((entry) => entry.id === migration.id)) {
    // previousIds: the relocated row carries the same checksum and timestamp; its SQL is not re-run.
    db.prepare(
      "insert into schema_migration (id, checksum, app_version, time_applied) select ?, checksum, app_version, time_applied from schema_migration where id = ?",
    ).run(migration.id, applied[0]!.id);
  }
  return false;
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errcode" in error &&
    typeof error.errcode === "number" &&
    (error.errcode & 0xff) === SQLITE_BUSY
  );
}

function isMemoryJournalMode(dbPath: string, journalMode: string): boolean {
  return dbPath === ":memory:" && journalMode === "memory";
}

function readJournalMode(db: DatabaseSync, enableWal = false): string {
  const row = db.prepare(enableWal ? "pragma journal_mode = wal" : "pragma journal_mode").get() as
    | Record<string, unknown>
    | undefined;
  const mode = row?.journal_mode;
  return typeof mode === "string" ? mode.toLowerCase() : "unknown";
}

function waitSync(delayMs: number): void {
  Atomics.wait(waitBuffer, 0, 0, Math.max(1, Math.ceil(delayMs)));
}

/** Retries a synchronous SQLite step while another writer holds the lock, bounded by the deadline. */
function retryBusySync(deadline: number, dbPath: string, operation: () => void): void {
  let delayMs = WAL_RETRY_INITIAL_DELAY_MS;
  for (;;) {
    try {
      operation();
      return;
    } catch (error) {
      if (!isSqliteBusyError(error)) throw normalizeMigrationError(error, dbPath);
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw lockTimeoutError(error, dbPath);
      waitSync(Math.min(remainingMs, delayMs));
      delayMs = Math.min(WAL_RETRY_MAX_DELAY_MS, delayMs * 2);
    }
  }
}

function normalizeMigrationError(
  error: unknown,
  dbPath: string,
  migrationId?: string,
): SqliteSessionMigrationError {
  if (error instanceof SqliteSessionMigrationError) return error;
  if (error instanceof SqliteSchemaMigrationChecksumError) {
    return new SqliteSessionMigrationError(error.message, {
      dbPath,
      kind: "checksum_mismatch",
      migrationId: error.migrationId,
    });
  }
  if (isSqliteBusyError(error)) return lockTimeoutError(error, dbPath, migrationId);
  return new SqliteSessionMigrationError(
    migrationId
      ? `SQLite migration ${migrationId} failed for ${dbPath}`
      : `SQLite migration initialization failed for ${dbPath}`,
    {
      cause: error,
      dbPath,
      kind: classifyDatabaseStartupError(error),
      migrationId,
    },
  );
}

function lockTimeoutError(
  cause: unknown,
  dbPath: string,
  migrationId?: string,
): SqliteSessionMigrationError {
  return new SqliteSessionMigrationError(
    `Timed out waiting for SQLite migration lock at ${dbPath}`,
    {
      cause,
      dbPath,
      kind: "lock_timeout",
      migrationId,
    },
  );
}

function readAppliedMigration(db: DatabaseSync, id: string): SchemaMigrationRow | undefined {
  return db.prepare("select id, checksum from schema_migration where id = ?").get(id) as
    | SchemaMigrationRow
    | undefined;
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.trim()).digest("hex");
}

function ensureMigrationChecksum(
  id: string,
  applied: string,
  current: string,
  dbPath: string,
): void {
  if (applied === current) return;
  throw new SqliteSessionMigrationError(
    `SQLite migration checksum mismatch for ${id}. Historical migrations are immutable; add a new migration instead.`,
    {
      dbPath,
      kind: "checksum_mismatch",
      migrationId: id,
    },
  );
}

/** Read the small migration ledger without scanning data tables; a database with tables but no ledger is an upgrade. */
function inspectMigrationKind(db: DatabaseSync, dbPath: string): DatabaseMigrationFacts["kind"] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'")
    .get();
  let pending = false;
  for (const migration of resolveSessionDatabaseMigrations(db)) {
    const row = hasLedger ? readAppliedMigration(db, migration.id) : undefined;
    if (row)
      ensureMigrationChecksum(migration.id, row.checksum, migrationChecksum(migration.sql), dbPath);
    else pending = true;
  }
  if (!pending) return "none";
  const hasDataTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migration', 'sqlite_sequence') LIMIT 1",
    )
    .get();
  return hasDataTables ? "upgrade" : "initialize";
}
