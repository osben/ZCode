import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const FORK_USAGE_DETACHED_MIGRATION_ID = "9002_fork_usage_detached";

const FORK_USAGE_DETACHED_SCHEMA = `
  create table if not exists fork_usage_detached_turn (
    bucket_start integer not null,
    opaque_session_id text not null,
    workspace_key text not null,
    turn_count integer not null,
    completed_duration_sum_ms integer not null,
    completed_count integer not null,
    total_tokens integer not null,
    primary key (bucket_start, opaque_session_id)
  ) without rowid;

  create table if not exists fork_usage_protected_bucket (
    kind text not null,
    bucket_start integer not null,
    workspace_key text not null,
    provider_id text not null default '',
    model_id text not null default '',
    query_source text not null default '',
    tool_name text not null default '',
    primary key (kind, bucket_start, workspace_key, provider_id, model_id, query_source, tool_name)
  ) without rowid;

  create table if not exists fork_usage_protected_model (
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

  create table if not exists fork_usage_protected_tool (
    bucket_start integer not null,
    workspace_key text not null,
    tool_name text not null,
    call_count integer not null,
    error_count integer not null,
    duration_sum_ms integer not null,
    duration_count integer not null,
    primary key (bucket_start, workspace_key, tool_name)
  ) without rowid;

  create table if not exists fork_usage_protected_model_raw (
    raw_id text primary key,
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
    is_error integer not null,
    ttft_ms integer
  ) without rowid;

  create table if not exists fork_usage_protected_tool_raw (
    raw_id text primary key,
    bucket_start integer not null,
    workspace_key text not null,
    tool_name text not null,
    is_error integer not null,
    duration_ms integer
  ) without rowid;

  create view if not exists fork_usage_turn_all as
    select bucket_start, 'live:' || session_id as session_id, workspace_key, turn_count,
      completed_duration_sum_ms, completed_count, total_tokens from fork_usage_turn
    union all
    select bucket_start, 'deleted:' || opaque_session_id, workspace_key, turn_count,
      completed_duration_sum_ms, completed_count, total_tokens from fork_usage_detached_turn;

  create view if not exists fork_usage_bucket_all as
    select b.* from fork_usage_bucket b where not exists (
      select 1 from fork_usage_protected_bucket p where p.kind = 'model'
        and p.bucket_start = b.bucket_start and p.workspace_key = b.workspace_key
        and p.provider_id = b.provider_id and p.model_id = b.model_id and p.query_source = b.query_source
    ) union all select * from fork_usage_protected_model;

  create view if not exists fork_usage_tool_all as
    select u.* from fork_usage_tool u where not exists (
      select 1 from fork_usage_protected_bucket p where p.kind = 'tool'
        and p.bucket_start = u.bucket_start and p.workspace_key = u.workspace_key and p.tool_name = u.tool_name
    ) union all select * from fork_usage_protected_tool;
`;

const ensuredDatabases = new WeakSet<DatabaseSync>();

export function ensureForkUsageDetachedSchema(db: DatabaseSync): void {
  if (ensuredDatabases.has(db)) return;
  db.exec(FORK_USAGE_DETACHED_SCHEMA);
  db.prepare(
    "insert into schema_migration (id, checksum, app_version, time_applied) values (?, ?, ?, ?) on conflict(id) do nothing",
  ).run(
    FORK_USAGE_DETACHED_MIGRATION_ID,
    createHash("sha256").update(FORK_USAGE_DETACHED_SCHEMA.trim()).digest("hex"),
    "fork",
    Date.now(),
  );
  if (!db.isTransaction) ensuredDatabases.add(db);
}
