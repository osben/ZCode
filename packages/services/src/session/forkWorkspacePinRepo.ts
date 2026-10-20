/* Fork-owned sidebar project pins: the `fork_workspace_pins` table in tasks-index.sqlite.
   Follows the fork DB rules (AGENTS.md, "Shared Databases and Fork Divergence"): a fork_-prefixed
   table, created by the additive migration 9001_fork_workspace_pins, tracked in the shared
   tasks_schema_migration ledger with its own checksum. Upstream migration definitions and their
   checksum inputs are never touched, so upstream builds and this fork keep sharing one database. */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

export const FORK_WORKSPACE_PINS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS fork_workspace_pins (
    workspace_key TEXT PRIMARY KEY,
    pinned_at INTEGER NOT NULL
  );
`;
export const FORK_WORKSPACE_PINS_MIGRATION_ID = "9001_fork_workspace_pins";

function rollbackQuietly(db: DatabaseSyncInstance): void {
  // Rollback can also fail due to I/O; do not replace the original migration/write failure.
  try {
    if (db.isTransaction) db.exec("ROLLBACK");
  } catch {
    /* The caller closes the connection during recovery. */
  }
}

export class ForkWorkspacePinRepo {
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private resolvedDbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;

  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
    this.resolvedDbPath = dbPath?.trim() || null;
  }

  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      const generation = this.lifecycleGeneration;
      this.initializePromise = this.initialize(path, generation).catch((error) => {
        if (generation === this.lifecycleGeneration) this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    this.lifecycleGeneration += 1;
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

  async listPinnedWorkspaceKeys(): Promise<string[]> {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare("SELECT workspace_key FROM fork_workspace_pins ORDER BY workspace_key")
      .all() as Array<{ workspace_key: string }>;
    return rows.map((row) => row.workspace_key);
  }

  async setWorkspacePinned(params: { workspaceKey: string; pinned: boolean }): Promise<void> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (params.pinned) {
        db.prepare(
          "INSERT OR REPLACE INTO fork_workspace_pins (workspace_key, pinned_at) VALUES (?, ?)",
        ).run(params.workspaceKey, Date.now());
      } else {
        db.prepare("DELETE FROM fork_workspace_pins WHERE workspace_key = ?").run(
          params.workspaceKey,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  }

  private runForkMigrations(): void {
    const db = this.getDatabase();
    const checksum = createHash("sha256").update(FORK_WORKSPACE_PINS_SCHEMA).digest("hex");
    db.exec(`CREATE TABLE IF NOT EXISTS tasks_schema_migration (
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL
    )`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const applied = db
        .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
        .get(FORK_WORKSPACE_PINS_MIGRATION_ID) as { checksum: string } | undefined;
      if (applied) {
        if (applied.checksum !== checksum) {
          throw Object.assign(
            new Error(
              `Task database migration checksum mismatch: ${FORK_WORKSPACE_PINS_MIGRATION_ID}`,
            ),
            { kind: "checksum_mismatch" },
          );
        }
        db.exec("COMMIT");
        return;
      }
      db.exec(FORK_WORKSPACE_PINS_SCHEMA);
      db.prepare("INSERT INTO tasks_schema_migration VALUES (?,?,?)").run(
        FORK_WORKSPACE_PINS_MIGRATION_ID,
        checksum,
        Date.now(),
      );
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  }

  private async initialize(path: string, generation: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (generation !== this.lifecycleGeneration) {
      throw new Error("ForkWorkspacePinRepo initialization was closed before it completed");
    }
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    if (!isTasksStoragePrepared(path, this.db)) {
      if (!isTasksStorageMigrated(path, this.db)) await runTasksDatabaseMigrations(this.db);
    }
    // The fork migration is not part of upstream schema preparation; always run the idempotent check.
    this.runForkMigrations();
  }

  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("ForkWorkspacePinRepo not initialized: await ensureReady() first");
    }
    return this.db;
  }
}
