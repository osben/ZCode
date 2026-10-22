import type { DatabaseSync } from "node:sqlite";
import type { SqliteMigration } from "@zcode/shared/sqlite-migrations";
import { SQLITE_MIGRATIONS } from "./migrations.js";
import { PROVIDER_MODEL_SELECTION_MIGRATION_SQL as TRANSLATED_0020_SQL } from "./fork-ledger-variants/0020-provider-model-selection.translated.js";

// Fork-owned migrations. The upstream list in migrations.ts stays byte-identical to upstream; fork entries
// are appended here and run after it. See specs/session-database-migrations.md.

/** Column-existence guard: a ledger row may be missing while the column already exists. */
function addSessionColumnsIfMissing(db: DatabaseSync, columns: readonly string[]): void {
  const existing = new Set(
    db
      .prepare("pragma table_info(session)")
      .all()
      .map((row) => row.name),
  );
  for (const column of columns) {
    if (!existing.has(column)) db.exec(`alter table session add column ${column} text`);
  }
}

/** Same guard as addSessionColumnsIfMissing, for the fork-owned ACP binding table. */
function addAcpBindingColumnsIfMissing(db: DatabaseSync, columns: readonly string[]): void {
  const existing = new Set(
    db
      .prepare("pragma table_info(fork_acp_session_binding)")
      .all()
      .map((row) => row.name),
  );
  for (const column of columns) {
    if (!existing.has(column)) {
      db.exec(`alter table fork_acp_session_binding add column ${column} text`);
    }
  }
}

const FORK_ACP_SESSION_BINDING_SQL = `
  create table if not exists fork_acp_session_binding (
    session_id text primary key,
    agent_id text not null,
    acp_session_id text not null,
    cwd text not null,
    launch_key text not null,
    updated_at integer not null
  );
`;

export const FORK_SESSION_MIGRATIONS: readonly SqliteMigration[] = [
  {
    appVersion: "0.16.9",
    id: "9001_fork_session_incognito",
    // Fork-owned (fork_ prefix, 9001_fork_* id): the frozen incognito profile JSON; NULL is a
    // normal session. Upstream builds ignore this ledger row and never list the column.
    touchedTables: ["session"],
    apply: (db) => addSessionColumnsIfMissing(db, ["fork_incognito"]),
    sql: `
      alter table session
        add column fork_incognito text;
    `,
  },
  {
    appVersion: "0.16.9",
    id: "9002_fork_session_execution_worktree",
    // Re-homes the pre-PR fork id 0023_session_execution_worktree out of the upstream 000N sequence.
    // previousIds copies that ledger row without re-running SQL, so the SQL text below must stay
    // byte-identical to the historical fork SQL (its checksum is the alias check). Execution worktree
    // facts for sessions whose agent runs in a linked worktree while directory/path keep the parent
    // workspace; nullable because every ordinary session has no execution worktree.
    previousIds: ["0023_session_execution_worktree"],
    touchedTables: ["session"],
    apply: (db) => addSessionColumnsIfMissing(db, ["execution_directory", "execution_branch"]),
    sql: `
      alter table session
        add column execution_directory text;

      alter table session
        add column execution_branch text;
    `,
  },
  {
    appVersion: "0.16.9",
    id: "9003_fork_session_acp_binding",
    // Fork-owned (fork_ prefix, 9003_fork_* id): the ACP session an external agent resumes for a ZCode
    // session. One row per ZCode session; `launch_key` is a digest of the launch config, never the config
    // itself, because the launch environment can carry credentials.
    touchedTables: ["fork_acp_session_binding"],
    apply: (db) => db.exec(FORK_ACP_SESSION_BINDING_SQL),
    sql: FORK_ACP_SESSION_BINDING_SQL,
  },
  {
    appVersion: "0.16.9",
    id: "9004_fork_session_acp_config",
    // Fork-owned (9004_fork_* id, fork_ table): the agent's offered config options (display copy, JSON)
    // and the user's chosen values (JSON map of config id to value). Both are nullable: a binding
    // without a first turn has neither. They are cleared with the binding row.
    touchedTables: ["fork_acp_session_binding"],
    apply: (db) => addAcpBindingColumnsIfMissing(db, ["config_options", "config_choices"]),
    sql: `
      alter table fork_acp_session_binding
        add column config_options text;

      alter table fork_acp_session_binding
        add column config_choices text;
    `,
  },
];

/** Full ordered list the runner executes: upstream definitions first, then fork-owned entries. */
export const SESSION_DATABASE_MIGRATIONS: readonly SqliteMigration[] = [
  ...SQLITE_MIGRATIONS,
  ...FORK_SESSION_MIGRATIONS,
];

/**
 * A historical SQL text of an upstream id whose ledger rows were written with a different checksum.
 * The ledger is never rewritten: when the ledger row carries `acceptedChecksum`, the runner uses
 * `sql` for that id, so the shared runner's checksum check passes on the untouched row. `sql` is
 * only executed if the id is pending, which cannot happen for a row that is already present.
 */
export interface ForkLedgerSqlVariant {
  id: string;
  acceptedChecksum: string;
  sql: string;
}

export const FORK_LEDGER_SQL_VARIANTS: readonly ForkLedgerSqlVariant[] = [
  {
    // Fork commits ac31c7db..32b1525a translated the SQL comments of this migration; the SQL is
    // otherwise identical. Source: ./fork-ledger-variants/0020-provider-model-selection.translated.ts.
    id: "0020_provider_model_selection",
    acceptedChecksum: "31fdaa50915e6ee967de3d8072a7f98bab64da0ac2864275589e4a2740eda788",
    sql: TRANSLATED_0020_SQL,
  },
];

/**
 * Returns the migration list for this database: each id whose ledger row carries a historical
 * checksum recorded by fork builds is paired with that historical SQL. Read-only; called inside the
 * startup lock so the ledger it reads is the one that will be migrated.
 */
export function resolveSessionDatabaseMigrations(db: DatabaseSync): readonly SqliteMigration[] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration'")
    .get();
  if (!hasLedger) return SESSION_DATABASE_MIGRATIONS;
  return SESSION_DATABASE_MIGRATIONS.map((migration) => {
    const variant = FORK_LEDGER_SQL_VARIANTS.find((entry) => entry.id === migration.id);
    if (!variant) return migration;
    const row = db
      .prepare("select checksum from schema_migration where id = ?")
      .get(migration.id) as { checksum: string } | undefined;
    if (!row || row.checksum !== variant.acceptedChecksum) return migration;
    return { ...migration, sql: variant.sql };
  });
}
