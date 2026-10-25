import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

// Fork-owned additive migration in the shared tasks-index ledger (AGENTS.md "Shared Databases and Fork
// Divergence"). Upstream builds ignore this id; this build ignores unknown upstream ids.
export const FORK_QUICK_PROMPTS_MIGRATION_ID = "9003_fork_quick_prompts";

export const FORK_QUICK_PROMPTS_SCHEMA = `CREATE TABLE IF NOT EXISTS fork_quick_prompts (
  prompt_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  host_id TEXT,
  project_id TEXT,
  name TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  body_nodes TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fork_quick_prompt_hidden (
  host_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  PRIMARY KEY (host_id, project_id, prompt_id)
);`;

/** Spec "Color column": adds the optional label color. A separate row keeps the 9003 DDL and checksum frozen. */
export const FORK_QUICK_PROMPT_COLOR_MIGRATION_ID = "9004_fork_quick_prompt_color";
export const FORK_QUICK_PROMPT_COLOR_SCHEMA = `ALTER TABLE fork_quick_prompts ADD COLUMN color TEXT;`;

const FORK_QUICK_PROMPT_MIGRATIONS = [
  { id: FORK_QUICK_PROMPTS_MIGRATION_ID, schema: FORK_QUICK_PROMPTS_SCHEMA },
  {
    id: FORK_QUICK_PROMPT_COLOR_MIGRATION_ID,
    schema: FORK_QUICK_PROMPT_COLOR_SCHEMA,
  },
] as const;

const log = createServiceLogger("quick-prompts");
const ensuredHandles = new WeakSet<DatabaseSync>();

/**
 * Checks and applies the fork migration in one BEGIN IMMEDIATE transaction, so several Host processes that
 * open the same tasks-index.sqlite cannot race. A handle is memoized only after success, so a failed attempt
 * is retried on the next call, and a new handle (after the shared connection is reopened) is checked again.
 */
export function ensureQuickPromptSchema(db: DatabaseSync): void {
  if (ensuredHandles.has(db)) return;
  if (db.isTransaction) throw new Error("quick-prompts.schema-inside-transaction");
  const appliedIds: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS tasks_schema_migration (
      id TEXT PRIMARY KEY, checksum TEXT NOT NULL, time_applied INTEGER NOT NULL
    )`);
    for (const migration of FORK_QUICK_PROMPT_MIGRATIONS) {
      const checksum = createHash("sha256").update(migration.schema).digest("hex");
      const row = db
        .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
        .get(migration.id) as { checksum: string } | undefined;
      if (row) {
        if (row.checksum !== checksum) {
          throw Object.assign(
            new Error(`Task database migration checksum mismatch: ${migration.id}`),
            { kind: "checksum_mismatch" },
          );
        }
      } else {
        db.exec(migration.schema);
        db.prepare("INSERT INTO tasks_schema_migration VALUES (?,?,?)").run(
          migration.id,
          checksum,
          Date.now(),
        );
        appliedIds.push(migration.id);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
  ensuredHandles.add(db);
  for (const migrationId of appliedIds) {
    log.info(undefined, "quick prompts schema applied", { migrationId });
  }
}
