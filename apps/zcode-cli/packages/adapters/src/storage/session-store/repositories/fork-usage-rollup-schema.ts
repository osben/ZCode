import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Fork-owned long-lived usage rollup (docs/design/v2/usage-observability.md, "Fork History Rollup").
 * The upstream build shares this database and prunes the raw usage tables after 30 days; these
 * tables keep derived sums so App Usage can show older history. They are created idempotently here
 * instead of through SQLITE_MIGRATIONS so upstream migration definitions and checksums stay untouched;
 * the ledger row below is ignored by builds that do not know it.
 */
export const FORK_USAGE_ROLLUP_MIGRATION_ID = "9001_fork_usage_rollup";
export const FORK_USAGE_BUCKET_MS = 15 * 60 * 1000;

const FORK_USAGE_ROLLUP_SCHEMA = `
  create table if not exists fork_usage_bucket (
    bucket_start integer not null,
    workspace_key text not null,
    provider_id text not null,
    model_id text not null,
    query_source text not null,
    input_tokens integer not null,
    output_tokens integer not null,
    reasoning_tokens integer not null,
    cache_creation_tokens integer not null,
    cache_read_tokens integer not null,
    computed_total_tokens integer not null,
    request_count integer not null,
    model_error_count integer not null,
    ttft_sum_ms integer not null,
    ttft_count integer not null,
    primary key (bucket_start, workspace_key, provider_id, model_id, query_source)
  ) without rowid;

  create table if not exists fork_usage_turn (
    bucket_start integer not null,
    session_id text not null,
    workspace_key text not null,
    turn_count integer not null,
    completed_duration_sum_ms integer not null,
    completed_count integer not null,
    total_tokens integer not null default 0,
    primary key (bucket_start, session_id)
  ) without rowid;

  create table if not exists fork_usage_tool (
    bucket_start integer not null,
    workspace_key text not null,
    tool_name text not null,
    call_count integer not null,
    error_count integer not null,
    duration_sum_ms integer not null,
    duration_count integer not null,
    primary key (bucket_start, workspace_key, tool_name)
  ) without rowid;

  create table if not exists fork_usage_meta (
    key text primary key,
    value text not null
  ) without rowid;
`;

const ensuredDatabases = new WeakSet<DatabaseSync>();

export function ensureForkUsageRollupSchema(db: DatabaseSync): void {
  if (ensuredDatabases.has(db)) {
    return;
  }
  db.exec(FORK_USAGE_ROLLUP_SCHEMA);
  upgradeForkUsageRollupColumns(db);
  // The CLI process and the desktop host share this database and can both run this; the ledger
  // insert must therefore be conflict-tolerant instead of check-then-insert.
  db.prepare(
    "insert into schema_migration (id, checksum, app_version, time_applied) values (?, ?, ?, ?) on conflict(id) do nothing",
  ).run(
    FORK_USAGE_ROLLUP_MIGRATION_ID,
    createHash("sha256").update(FORK_USAGE_ROLLUP_SCHEMA.trim()).digest("hex"),
    "fork",
    Date.now(),
  );
  // DDL issued inside a surrounding transaction can still be rolled back; only cache a committed schema.
  if (!db.isTransaction) {
    ensuredDatabases.add(db);
  }
}

/**
 * Columns added after the first rollout. `create table if not exists` never alters an existing table,
 * so add what is missing and reset the watermark: the next recompute then backfills the new column
 * for every bucket whose raw rows still exist (older buckets keep the column default of 0).
 */
function upgradeForkUsageRollupColumns(db: DatabaseSync): void {
  const turnColumns = db.prepare("pragma table_info(fork_usage_turn)").all() as Array<{
    name: string;
  }>;
  if (!turnColumns.some((column) => column.name === "total_tokens")) {
    try {
      db.exec("alter table fork_usage_turn add column total_tokens integer not null default 0");
    } catch (error) {
      // A concurrent process may have added the column between the check and the alter.
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) {
        throw error;
      }
    }
    db.prepare("delete from fork_usage_meta where key = 'watermark_ms'").run();
  }
}
