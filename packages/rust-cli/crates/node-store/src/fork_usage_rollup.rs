//! Fork: the long-lived usage rollup and the detached-identity tables it hands erased sessions
//! over to (Node `fork-usage-rollup-schema.ts`, `fork-usage-detached-schema.ts`,
//! `fork-usage-rollup.ts`, `fork-usage-detached.ts`, `fork-usage-protected-rows.ts`).
//!
//! The schema strings are byte-identical to Node's so the sha256 ledger checksum matches on the
//! shared `db.sqlite` (`specs/upstream-migration-freeze.md`): both builds run
//! `ensure…Schema`, the ledger insert is conflict-tolerant, and a build that does not know the
//! migration id ignores the row. The delete-side of the rollup (recompute, preserve-before-delete,
//! prune) lives here; the read path that answers App Usage queries is `fork_usage_query`.
//!
//! Concurrency: every function here runs inside the caller's `BEGIN IMMEDIATE` transaction
//! (Node checks `db.isTransaction` for the same reason — the schema ensure and the ledger insert
//! must roll back with the delete when it fails).

use rusqlite::{Connection, OptionalExtension};
use rust_cli_kernel_api::store::StoreError;

use crate::OrStorage;

/// Node `FORK_USAGE_ROLLUP_MIGRATION_ID` (`9001_fork_usage_rollup`).
pub(crate) const FORK_USAGE_ROLLUP_MIGRATION_ID: &str = "9001_fork_usage_rollup";
/// Node `FORK_USAGE_DETACHED_MIGRATION_ID` (`9002_fork_usage_detached`).
pub(crate) const FORK_USAGE_DETACHED_MIGRATION_ID: &str = "9002_fork_usage_detached";
/// Node `FORK_USAGE_BUCKET_MS` (15 minutes).
pub(crate) const FORK_USAGE_BUCKET_MS: i64 = 15 * 60 * 1000;
/// Buckets whose raw rows may have been pruned are replaced only within this window.
const REPLACE_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Node `ROLLUP_RETENTION_MS` (two years).
const ROLLUP_RETENTION_MS: i64 = 2 * 365 * 24 * 60 * 60 * 1000;
/// The recompute watermark row in `fork_usage_meta`.
const WATERMARK_KEY: &str = "watermark_ms";
/// Node `WRITE_DEBOUNCE_MS`: a usage write recomputes only when the last recompute is older.
const WRITE_DEBOUNCE_MS: i64 = 5 * 60 * 1000;

/// Node `FORK_USAGE_ROLLUP_SCHEMA`, byte-identical (the ledger checksum is `sha256(trim(sql))`).
const FORK_USAGE_ROLLUP_SCHEMA: &str = "
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
";

/// Node `FORK_USAGE_DETACHED_SCHEMA`, byte-identical (same checksum contract as above).
const FORK_USAGE_DETACHED_SCHEMA: &str = "
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
";

/// Node `ensureForkUsageRollupSchema`: idempotent DDL, the column upgrade for databases created
/// before `total_tokens`, then the conflict-tolerant ledger row (both builds share the database).
/// Node caches the ensured connection in a `WeakSet`; the DDL is `if not exists` and the ledger
/// insert conflict-tolerant, so running it on every call keeps the behavior without the cache.
pub(crate) fn ensure_rollup_schema(conn: &Connection, now_ms: u64) -> Result<(), StoreError> {
    conn.execute_batch(FORK_USAGE_ROLLUP_SCHEMA).storage()?;
    upgrade_rollup_columns(conn)?;
    conn.prepare_cached(
        "insert into schema_migration (id, checksum, app_version, time_applied) \
         values (?, ?, ?, ?) on conflict(id) do nothing",
    )
    .storage()?
    .execute(rusqlite::params![
        FORK_USAGE_ROLLUP_MIGRATION_ID,
        crate::repo::migrations::checksum(FORK_USAGE_ROLLUP_SCHEMA),
        "fork",
        now_ms as i64,
    ])
    .storage()?;
    Ok(())
}

/// Node `upgradeForkUsageRollupColumns`: `create table if not exists` never alters an existing
/// table, so add a missing column and reset the watermark (the next recompute backfills it).
fn upgrade_rollup_columns(conn: &Connection) -> Result<(), StoreError> {
    let mut statement = conn
        .prepare("pragma table_info(fork_usage_turn)")
        .storage()?;
    let names: Vec<String> = statement
        .query_map([], |row| row.get(1))
        .storage()?
        .collect::<rusqlite::Result<_>>()
        .storage()?;
    if !names.iter().any(|name| name == "total_tokens") {
        match conn.execute_batch(
            "alter table fork_usage_turn add column total_tokens integer not null default 0",
        ) {
            Ok(()) => {}
            // A concurrent process may have added the column between the check and the alter.
            Err(error) if error.to_string().contains("duplicate column name") => {}
            Err(error) => return Err(error).storage(),
        }
        conn.execute("delete from fork_usage_meta where key = 'watermark_ms'", [])
            .storage()?;
    }
    Ok(())
}

/// Node `ensureForkUsageDetachedSchema` (same ledger contract as [`ensure_rollup_schema`]).
pub(crate) fn ensure_detached_schema(conn: &Connection, now_ms: u64) -> Result<(), StoreError> {
    conn.execute_batch(FORK_USAGE_DETACHED_SCHEMA).storage()?;
    conn.prepare_cached(
        "insert into schema_migration (id, checksum, app_version, time_applied) \
         values (?, ?, ?, ?) on conflict(id) do nothing",
    )
    .storage()?
    .execute(rusqlite::params![
        FORK_USAGE_DETACHED_MIGRATION_ID,
        crate::repo::migrations::checksum(FORK_USAGE_DETACHED_SCHEMA),
        "fork",
        now_ms as i64,
    ])
    .storage()?;
    Ok(())
}

/// Node `alignDownToBucket`.
pub(crate) fn align_down_to_bucket(time_ms: i64) -> i64 {
    time_ms.div_euclid(FORK_USAGE_BUCKET_MS) * FORK_USAGE_BUCKET_MS
}

/// Node `recomputeForkUsageRollup`: the rollup replacement body under its own immediate
/// transaction (or the caller's, when one is already open).
pub(crate) fn recompute(conn: &Connection, now_ms: u64) -> Result<(), StoreError> {
    ensure_rollup_schema(conn, now_ms)?;
    ensure_detached_schema(conn, now_ms)?;
    if !conn.is_autocommit() {
        return recompute_in_transaction(conn, now_ms);
    }
    conn.execute_batch("begin immediate").storage()?;
    match recompute_in_transaction(conn, now_ms) {
        Ok(()) => conn.execute_batch("commit").storage(),
        Err(error) => {
            let _ = conn.execute_batch("rollback");
            Err(error)
        }
    }
}

/// Node `refreshForkUsageRollupForRead` + `runRecomputeQuietly`: recompute before a read so a
/// query does not miss rows written just before it; a failure only skips this round and is
/// returned as the reason a fallback would carry (Node keeps it in `lastRecomputeError`). The
/// read debounce is not ported: every read recomputes, bounded to the 7-day replace window.
pub(crate) fn refresh_for_read(conn: &Connection, now_ms: u64) -> Option<String> {
    // A surrounding transaction must not be broken into; reads fall back for this round.
    if !conn.is_autocommit() {
        return Some("database_in_transaction".to_owned());
    }
    recompute(conn, now_ms).err().map(store_error_message)
}

/// Node `scheduleForkUsageRollup` for a usage batch, run in the batch's own transaction right
/// before the 30-day raw prune (specs/fork-agent-runtime-selection.md "Usage rollup in Rust
/// mode"). Node defers the recompute to a later transaction; here it precedes the prune so no raw
/// row is deleted before a recompute covered it. Skipped while the shared watermark is younger
/// than Node's write debounce: such a watermark was written after every row the prune can reach.
/// An error must stop the prune (the caller rolls the savepoint back).
pub(crate) fn recompute_before_raw_prune(conn: &Connection, now_ms: u64) -> Result<(), StoreError> {
    let now = i64::try_from(now_ms).unwrap_or(i64::MAX);
    if let Some(watermark) = read_watermark_if_present(conn)?
        && now >= watermark
        && now - watermark < WRITE_DEBOUNCE_MS
    {
        return Ok(());
    }
    recompute_in_transaction(conn, now_ms)
}

/// The watermark when the rollup schema exists; a database no build has rolled up yet has no
/// `fork_usage_meta` table, which reads as "never computed".
fn read_watermark_if_present(conn: &Connection) -> Result<Option<i64>, StoreError> {
    let exists = conn
        .query_row(
            "select 1 from sqlite_master where type = 'table' and name = 'fork_usage_meta'",
            [],
            |_| Ok(()),
        )
        .optional()
        .storage()?
        .is_some();
    Ok(if exists { read_watermark(conn) } else { None })
}

/// Node `isForkUsageRollupReady`: a recompute completed at least once, i.e. the rollup holds a
/// usable history.
pub(crate) fn is_ready(conn: &Connection) -> bool {
    read_watermark(conn).is_some()
}

/// The message Node's caught error would carry (`error.message`).
fn store_error_message(error: StoreError) -> String {
    match error {
        StoreError::Storage { message } => message,
        other => other.to_string(),
    }
}

/// Node `recomputeForkUsageRollupInTransaction`: rebuild rollup buckets from the watermark's
/// replace window onwards. Idempotent (buckets are replaced, never incremented) and a table only
/// replaces buckets its surviving raw rows fully cover, so pruned rows keep their rollup. Must run
/// inside the caller's write transaction; it writes the new watermark at the end.
pub(crate) fn recompute_in_transaction(conn: &Connection, now_ms: u64) -> Result<(), StoreError> {
    ensure_rollup_schema(conn, now_ms)?;
    ensure_detached_schema(conn, now_ms)?;
    sync_protected_raw_rows(conn)?;
    let watermark = read_watermark(conn);
    let window_start = match watermark {
        None => 0,
        Some(watermark) => align_down_to_bucket(watermark - REPLACE_WINDOW_MS),
    };
    replace_buckets(conn, &MODEL_REPLACE, window_start)?;
    replace_buckets(conn, &TURN_REPLACE, window_start)?;
    replace_buckets(conn, &TOOL_REPLACE, window_start)?;
    prune(conn, now_ms)?;
    conn.prepare_cached(
        "insert into fork_usage_meta (key, value) values (?, ?) \
         on conflict(key) do update set value = excluded.value",
    )
    .storage()?
    .execute(rusqlite::params![WATERMARK_KEY, now_ms.to_string()])
    .storage()?;
    Ok(())
}

/// Node `pruneForkUsageRollup`: drop rollup rows older than the retention window.
pub(crate) fn prune(conn: &Connection, now_ms: u64) -> Result<(), StoreError> {
    let cutoff = i64::try_from(now_ms).unwrap_or(i64::MAX) - ROLLUP_RETENTION_MS;
    for table in [
        "fork_usage_bucket",
        "fork_usage_turn",
        "fork_usage_tool",
        "fork_usage_detached_turn",
        "fork_usage_protected_bucket",
        "fork_usage_protected_model",
        "fork_usage_protected_tool",
        "fork_usage_protected_model_raw",
        "fork_usage_protected_tool_raw",
    ] {
        conn.prepare_cached(&format!("delete from {table} where bucket_start < ?"))
            .storage()?
            .execute(rusqlite::params![cutoff])
            .storage()?;
    }
    Ok(())
}

/// Node `readWatermark`: a finite number or `null` (a missing or non-numeric row restarts the
/// replace window at the beginning).
fn read_watermark(conn: &Connection) -> Option<i64> {
    conn.query_row(
        "select value from fork_usage_meta where key = ?",
        rusqlite::params![WATERMARK_KEY],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|value| value.parse::<f64>().ok())
    .filter(|value| value.is_finite())
    .map(|value| value as i64)
}

/// One table's bucket replacement (Node `replaceBuckets`'s input object).
pub(crate) struct Replace {
    table: &'static str,
    raw_table: &'static str,
    /// Rollup column that counts the raw rows a bucket row stands for.
    count_column: &'static str,
    /// Appended to the delete's `where`; `1 = 1` when the table has no protected variant.
    protected_match: &'static str,
    /// The insert-select with the `from` bound parameter as the first placeholder.
    pub(crate) insert_sql: &'static str,
}

/// Node's `BUCKET_EXPR`.
fn bucket_expr(column: &str) -> String {
    format!("cast({column} / {FORK_USAGE_BUCKET_MS} as integer) * {FORK_USAGE_BUCKET_MS}")
}

pub(crate) const MODEL_REPLACE: Replace = Replace {
    table: "fork_usage_bucket",
    raw_table: "model_usage",
    count_column: "request_count",
    protected_match: "and not exists (
        select 1 from fork_usage_protected_bucket p where p.kind = 'model'
          and p.bucket_start = fork_usage_bucket.bucket_start
          and p.workspace_key = fork_usage_bucket.workspace_key
          and p.provider_id = fork_usage_bucket.provider_id
          and p.model_id = fork_usage_bucket.model_id
          and p.query_source = fork_usage_bucket.query_source
      )",
    insert_sql: "
        insert into fork_usage_bucket (
          bucket_start, workspace_key, provider_id, model_id, query_source,
          input_tokens, output_tokens, reasoning_tokens, cache_creation_tokens, cache_read_tokens,
          computed_total_tokens, request_count, model_error_count, ttft_sum_ms, ttft_count
        )
        select
          cast(m.started_at / 900000 as integer) * 900000,
          coalesce(s.directory, ''),
          m.provider_id,
          coalesce(m.model_id, ''),
          m.query_source,
          coalesce(sum(m.input_tokens), 0),
          coalesce(sum(m.output_tokens), 0),
          coalesce(sum(m.reasoning_tokens), 0),
          coalesce(sum(m.cache_creation_input_tokens), 0),
          coalesce(sum(m.cache_read_input_tokens), 0),
          coalesce(sum(m.computed_total_tokens), 0),
          count(*),
          coalesce(sum(case when m.status = 'error' then 1 else 0 end), 0),
          coalesce(sum(m.time_to_first_token_ms), 0),
          count(m.time_to_first_token_ms)
        from model_usage m
        left join session s on s.id = m.session_id
        where m.started_at >= ?
          and not exists (
            select 1 from fork_usage_protected_bucket p where p.kind = 'model'
              and p.bucket_start = cast(m.started_at / 900000 as integer) * 900000
              and p.workspace_key = coalesce(s.directory, '') and p.provider_id = m.provider_id
              and p.model_id = coalesce(m.model_id, '') and p.query_source = m.query_source
          )
        group by 1, 2, 3, 4, 5",
};

pub(crate) const TURN_REPLACE: Replace = Replace {
    table: "fork_usage_turn",
    raw_table: "turn_usage",
    count_column: "turn_count",
    protected_match: "",
    insert_sql: "
        insert into fork_usage_turn (
          bucket_start, session_id, workspace_key, turn_count,
          completed_duration_sum_ms, completed_count, total_tokens
        )
        select
          cast(t.started_at / 900000 as integer) * 900000,
          t.session_id,
          coalesce(s.directory, ''),
          count(*),
          coalesce(sum(case when t.status = 'completed' then coalesce(t.duration_ms, 0) else 0 end), 0),
          coalesce(sum(case when t.status = 'completed' and t.duration_ms is not null then 1 else 0 end), 0),
          coalesce(sum(t.computed_total_tokens), 0)
        from turn_usage t
        left join session s on s.id = t.session_id
        where t.started_at >= ?
        group by 1, 2, 3",
};

pub(crate) const TOOL_REPLACE: Replace = Replace {
    table: "fork_usage_tool",
    raw_table: "tool_usage",
    count_column: "call_count",
    protected_match: "and not exists (
        select 1 from fork_usage_protected_bucket p where p.kind = 'tool'
          and p.bucket_start = fork_usage_tool.bucket_start
          and p.workspace_key = fork_usage_tool.workspace_key
          and p.tool_name = fork_usage_tool.tool_name
      )",
    insert_sql: "
        insert into fork_usage_tool (
          bucket_start, workspace_key, tool_name, call_count, error_count,
          duration_sum_ms, duration_count
        )
        select
          cast(u.started_at / 900000 as integer) * 900000,
          coalesce(s.directory, ''),
          u.tool_name,
          count(*),
          coalesce(sum(case when u.status = 'error' then 1 else 0 end), 0),
          coalesce(sum(u.duration_ms), 0),
          count(u.duration_ms)
        from tool_usage u
        left join session s on s.id = u.session_id
        where u.started_at >= ?
          and not exists (
            select 1 from fork_usage_protected_bucket p where p.kind = 'tool'
              and p.bucket_start = cast(u.started_at / 900000 as integer) * 900000
              and p.workspace_key = coalesce(s.directory, '') and p.tool_name = u.tool_name
          )
        group by 1, 2, 3",
};

/// Node `replaceBuckets`. The bucket holding the oldest surviving raw row may have lost earlier
/// rows to a prune; it is rebuilt only when the raw table still holds at least as many rows for it
/// as the rollup already counted, otherwise the existing bucket is kept.
fn replace_buckets(
    conn: &Connection,
    input: &Replace,
    window_start: i64,
) -> Result<(), StoreError> {
    let Some(oldest) = conn
        .query_row(
            &format!("select min(started_at) as oldest from {}", input.raw_table),
            [],
            |row| row.get::<_, Option<i64>>(0),
        )
        .storage()?
    else {
        return Ok(());
    };
    let oldest_bucket = align_down_to_bucket(oldest);
    let rolled_up: i64 = conn
        .query_row(
            &format!(
                "select coalesce(sum({}), 0) as n from {} where bucket_start = ?",
                input.count_column, input.table
            ),
            rusqlite::params![oldest_bucket],
            |row| row.get(0),
        )
        .storage()?;
    let raw: i64 = conn
        .query_row(
            &format!(
                "select count(*) as n from {} where started_at >= ? and started_at < ?",
                input.raw_table
            ),
            rusqlite::params![oldest_bucket, oldest_bucket + FORK_USAGE_BUCKET_MS],
            |row| row.get(0),
        )
        .storage()?;
    let earliest_safe = if raw >= rolled_up {
        oldest_bucket
    } else {
        oldest_bucket + FORK_USAGE_BUCKET_MS
    };
    let from = window_start.max(earliest_safe);
    let delete = format!(
        "delete from {} where bucket_start >= ? {}",
        input.table, input.protected_match
    );
    conn.prepare_cached(&delete)
        .storage()?
        .execute(rusqlite::params![from])
        .storage()?;
    conn.prepare_cached(input.insert_sql)
        .storage()?
        .execute(rusqlite::params![from])
        .storage()?;
    Ok(())
}

/// Node `preserveUsageBeforeSessionTreeDelete`: detach session-scoped turn identities and freeze
/// model/tool rollups as protected baselines before the session rows go away. Called inside
/// `delete_tree`'s write transaction; `uuid` mints the opaque id per erased session (Node
/// `randomUUID`; this crate routes every random uuid through `NodeIds`).
pub(crate) fn preserve_before_session_tree_delete(
    conn: &Connection,
    session_ids: &[String],
    now_ms: u64,
    mut uuid: impl FnMut() -> String,
) -> Result<(), StoreError> {
    if session_ids.is_empty() {
        return Ok(());
    }
    ensure_detached_schema(conn, now_ms)?;
    sync_protected_raw_rows(conn)?;
    protect_model_rollups(conn, session_ids)?;
    protect_tool_rollups(conn, session_ids)?;
    snapshot_protected_model_rows(conn)?;
    snapshot_protected_tool_rows(conn)?;
    detach_turn_rows(conn, session_ids, &mut uuid)?;
    // Raw tool IDs can embed a session ID. Once content is deleted, retain no snapshot linking it.
    for part in chunks(session_ids) {
        let list = placeholders(part.len());
        conn.prepare_cached(&format!(
            "delete from fork_usage_protected_model_raw where raw_id in (
      select id from model_usage where session_id in ({list}))"
        ))
        .storage()?
        .execute(rusqlite::params_from_iter(
            part.iter().cloned().map(rusqlite::types::Value::Text),
        ))
        .storage()?;
        conn.prepare_cached(&format!(
            "delete from fork_usage_protected_tool_raw where raw_id in (
      select id from tool_usage where session_id in ({list}))"
        ))
        .storage()?
        .execute(rusqlite::params_from_iter(
            part.iter().cloned().map(rusqlite::types::Value::Text),
        ))
        .storage()?;
    }
    Ok(())
}

/// Node `syncForkUsageProtectedRawRows` without its own transaction: this port only calls it from
/// inside caller-owned write transactions, so the begin/commit branch of the original is not
/// needed. Raw retention removes provenance, never its preserved aggregate contribution.
pub(crate) fn sync_protected_raw_rows(conn: &Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        "delete from fork_usage_protected_model_raw where raw_id not in (select id from model_usage);
         delete from fork_usage_protected_tool_raw where raw_id not in (select id from tool_usage);",
    )
    .storage()?;
    sync_model_rows(conn)?;
    sync_tool_rows(conn)?;
    Ok(())
}

/// Node `protectModelRollups`.
fn protect_model_rollups(conn: &Connection, session_ids: &[String]) -> Result<(), StoreError> {
    for part in chunks(session_ids) {
        let list = placeholders(part.len());
        let mut values: Vec<rusqlite::types::Value> =
            vec![FORK_USAGE_BUCKET_MS.into(), FORK_USAGE_BUCKET_MS.into()];
        values.extend(part.iter().cloned().map(rusqlite::types::Value::Text));
        conn.prepare_cached(&format!(
            "insert or ignore into fork_usage_protected_bucket (
      kind, bucket_start, workspace_key, provider_id, model_id, query_source
    ) select 'model', cast(m.started_at / ? as integer) * ?, coalesce(s.directory, ''),
      m.provider_id, coalesce(m.model_id, ''), m.query_source
    from model_usage m left join session s on s.id = m.session_id where m.session_id in ({list})"
        ))
        .storage()?
        .execute(rusqlite::params_from_iter(values))
        .storage()?;
        conn.prepare_cached(&format!(
            "insert or ignore into fork_usage_protected_bucket (
      kind, bucket_start, workspace_key, provider_id, model_id, query_source
    ) select 'model', b.bucket_start, b.workspace_key, b.provider_id, b.model_id, b.query_source
    from fork_usage_bucket b where exists (
        select 1 from fork_usage_turn t where t.session_id in ({list})
          and t.bucket_start = b.bucket_start and t.workspace_key = b.workspace_key
      )"
        ))
        .storage()?
        .execute(rusqlite::params_from_iter(
            part.iter().cloned().map(rusqlite::types::Value::Text),
        ))
        .storage()?;
    }
    conn.execute_batch("
    insert or ignore into fork_usage_protected_model
    select b.* from fork_usage_bucket b where exists (
      select 1 from fork_usage_protected_bucket p where p.kind='model'
        and p.bucket_start=b.bucket_start and p.workspace_key=b.workspace_key
        and p.provider_id=b.provider_id and p.model_id=b.model_id and p.query_source=b.query_source
    );
    delete from fork_usage_bucket where exists (
      select 1 from fork_usage_protected_bucket p where p.kind='model'
        and p.bucket_start=fork_usage_bucket.bucket_start and p.workspace_key=fork_usage_bucket.workspace_key
        and p.provider_id=fork_usage_bucket.provider_id and p.model_id=fork_usage_bucket.model_id
        and p.query_source=fork_usage_bucket.query_source
    );
  ")
    .storage()?;
    initialize_missing_protected_models_from_raw(conn)
}

/// Node `protectToolRollups`.
fn protect_tool_rollups(conn: &Connection, session_ids: &[String]) -> Result<(), StoreError> {
    for part in chunks(session_ids) {
        let list = placeholders(part.len());
        let mut values: Vec<rusqlite::types::Value> =
            vec![FORK_USAGE_BUCKET_MS.into(), FORK_USAGE_BUCKET_MS.into()];
        values.extend(part.iter().cloned().map(rusqlite::types::Value::Text));
        conn.prepare_cached(&format!(
            "insert or ignore into fork_usage_protected_bucket (
      kind, bucket_start, workspace_key, tool_name
    ) select 'tool', cast(u.started_at / ? as integer) * ?, coalesce(s.directory, ''), u.tool_name
    from tool_usage u left join session s on s.id=u.session_id where u.session_id in ({list})"
        ))
        .storage()?
        .execute(rusqlite::params_from_iter(values))
        .storage()?;
        conn.prepare_cached(&format!(
            "insert or ignore into fork_usage_protected_bucket (
      kind, bucket_start, workspace_key, tool_name
    ) select 'tool', u.bucket_start, u.workspace_key, u.tool_name from fork_usage_tool u where exists (
      select 1 from fork_usage_turn t where t.session_id in ({list})
        and t.bucket_start=u.bucket_start and t.workspace_key=u.workspace_key
    )"
        ))
        .storage()?
        .execute(rusqlite::params_from_iter(
            part.iter().cloned().map(rusqlite::types::Value::Text),
        ))
        .storage()?;
    }
    conn.execute_batch("
    insert or ignore into fork_usage_protected_tool
    select u.* from fork_usage_tool u where exists (
      select 1 from fork_usage_protected_bucket p where p.kind='tool'
        and p.bucket_start=u.bucket_start and p.workspace_key=u.workspace_key and p.tool_name=u.tool_name
    );
    delete from fork_usage_tool where exists (
      select 1 from fork_usage_protected_bucket p where p.kind='tool'
        and p.bucket_start=fork_usage_tool.bucket_start and p.workspace_key=fork_usage_tool.workspace_key
        and p.tool_name=fork_usage_tool.tool_name
    );
  ")
    .storage()?;
    initialize_missing_protected_tools_from_raw(conn)
}

/// Node `initializeMissingProtectedModelsFromRaw`.
fn initialize_missing_protected_models_from_raw(conn: &Connection) -> Result<(), StoreError> {
    let bucket = bucket_expr("m.started_at");
    conn.execute_batch(&format!(
        "
    insert or ignore into fork_usage_protected_model
    select {bucket},
      coalesce(s.directory, ''), m.provider_id, coalesce(m.model_id, ''), m.query_source,
      coalesce(sum(m.input_tokens), 0), coalesce(sum(m.output_tokens), 0),
      coalesce(sum(m.reasoning_tokens), 0), coalesce(sum(m.cache_creation_input_tokens), 0),
      coalesce(sum(m.cache_read_input_tokens), 0), coalesce(sum(m.computed_total_tokens), 0), count(*),
      sum(case when m.status='error' then 1 else 0 end),
      coalesce(sum(m.time_to_first_token_ms), 0), count(m.time_to_first_token_ms)
    from model_usage m left join session s on s.id=m.session_id
    where exists (select 1 from fork_usage_protected_bucket p where p.kind='model'
      and p.bucket_start={bucket}
      and p.workspace_key=coalesce(s.directory, '') and p.provider_id=m.provider_id
      and p.model_id=coalesce(m.model_id, '') and p.query_source=m.query_source)
    group by 1,2,3,4,5"
    ))
    .storage()
}

/// Node `initializeMissingProtectedToolsFromRaw`.
fn initialize_missing_protected_tools_from_raw(conn: &Connection) -> Result<(), StoreError> {
    let bucket = bucket_expr("u.started_at");
    conn.execute_batch(&format!(
        "
    insert or ignore into fork_usage_protected_tool
    select {bucket},
      coalesce(s.directory, ''), u.tool_name, count(*), sum(case when u.status='error' then 1 else 0 end),
      coalesce(sum(u.duration_ms), 0), count(u.duration_ms)
    from tool_usage u left join session s on s.id=u.session_id
    where exists (select 1 from fork_usage_protected_bucket p where p.kind='tool'
      and p.bucket_start={bucket}
      and p.workspace_key=coalesce(s.directory, '') and p.tool_name=u.tool_name)
    group by 1,2,3"
    ))
    .storage()
}

/// Node `snapshotProtectedModelRows`.
fn snapshot_protected_model_rows(conn: &Connection) -> Result<(), StoreError> {
    let bucket = bucket_expr("m.started_at");
    conn.execute_batch(&format!(
        "
    insert or ignore into fork_usage_protected_model_raw
    select m.id, {bucket},
      coalesce(s.directory, ''), m.provider_id, coalesce(m.model_id, ''), m.query_source,
      coalesce(m.input_tokens, 0), coalesce(m.output_tokens, 0), coalesce(m.reasoning_tokens, 0),
      coalesce(m.cache_creation_input_tokens, 0), coalesce(m.cache_read_input_tokens, 0),
      coalesce(m.computed_total_tokens, 0), case when m.status = 'error' then 1 else 0 end,
      m.time_to_first_token_ms
    from model_usage m left join session s on s.id = m.session_id
    where exists (
      select 1 from fork_usage_protected_bucket p
      where p.kind = 'model'
        and p.bucket_start = {bucket}
        and p.workspace_key = coalesce(s.directory, '') and p.provider_id = m.provider_id
        and p.model_id = coalesce(m.model_id, '') and p.query_source = m.query_source
    );
  "
    ))
    .storage()
}

/// Node `snapshotProtectedToolRows`.
fn snapshot_protected_tool_rows(conn: &Connection) -> Result<(), StoreError> {
    let bucket = bucket_expr("u.started_at");
    conn.execute_batch(&format!(
        "
    insert or ignore into fork_usage_protected_tool_raw
    select u.id, {bucket},
      coalesce(s.directory, ''), u.tool_name,
      case when u.status = 'error' then 1 else 0 end, u.duration_ms
    from tool_usage u left join session s on s.id = u.session_id
    where exists (
      select 1 from fork_usage_protected_bucket p
      where p.kind = 'tool'
        and p.bucket_start = {bucket}
        and p.workspace_key = coalesce(s.directory, '') and p.tool_name = u.tool_name
    );
  "
    ))
    .storage()
}

/// Node `detachTurnRows`: move `fork_usage_turn` rows to `fork_usage_detached_turn` under an
/// opaque id per session (the id never equals or reveals the session id), then delete the live
/// rows.
fn detach_turn_rows(
    conn: &Connection,
    session_ids: &[String],
    uuid: &mut dyn FnMut() -> String,
) -> Result<(), StoreError> {
    let mut opaque_by_session = std::collections::HashMap::new();
    for id in session_ids {
        opaque_by_session.insert(id.clone(), uuid());
    }
    for part in chunks(session_ids) {
        let list = placeholders(part.len());
        let present: Vec<String> = conn
            .prepare_cached(&format!(
                "select distinct session_id from fork_usage_turn where session_id in ({list})"
            ))
            .storage()?
            .query_map(
                rusqlite::params_from_iter(part.iter().cloned().map(rusqlite::types::Value::Text)),
                |row| row.get(0),
            )
            .storage()?
            .collect::<rusqlite::Result<_>>()
            .storage()?;
        for session in present {
            let Some(opaque) = opaque_by_session.get(&session) else {
                continue;
            };
            conn.prepare_cached(
                "
    insert into fork_usage_detached_turn (
      bucket_start, opaque_session_id, workspace_key, turn_count,
      completed_duration_sum_ms, completed_count, total_tokens
    )
    select bucket_start, ?, workspace_key, turn_count, completed_duration_sum_ms, completed_count,
      total_tokens from fork_usage_turn where session_id = ?
    on conflict(bucket_start, opaque_session_id) do update set
      workspace_key = excluded.workspace_key, turn_count = excluded.turn_count,
      completed_duration_sum_ms = excluded.completed_duration_sum_ms,
      completed_count = excluded.completed_count, total_tokens = excluded.total_tokens
  ",
            )
            .storage()?
            .execute(rusqlite::params![opaque, session])
            .storage()?;
        }
        conn.prepare_cached(&format!(
            "delete from fork_usage_turn where session_id in ({list})"
        ))
        .storage()?
        .execute(rusqlite::params_from_iter(
            part.iter().cloned().map(rusqlite::types::Value::Text),
        ))
        .storage()?;
    }
    Ok(())
}

/// One raw model-usage row as the protected-row sync sees it (Node `ModelRawRow`).
#[derive(Debug, Clone, PartialEq)]
struct ModelRawRow {
    id: String,
    bucket_start: i64,
    workspace_key: String,
    provider_id: String,
    model_id: String,
    query_source: String,
    input_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    cache_creation_tokens: i64,
    cache_read_tokens: i64,
    computed_total_tokens: i64,
    is_error: i64,
    ttft_ms: Option<i64>,
}

/// One raw tool-usage row (Node `ToolRawRow`).
#[derive(Debug, Clone, PartialEq)]
struct ToolRawRow {
    id: String,
    bucket_start: i64,
    workspace_key: String,
    tool_name: String,
    is_error: i64,
    duration_ms: Option<i64>,
}

impl ModelRawRow {
    fn group(&self) -> [rusqlite::types::Value; 5] {
        [
            self.bucket_start.into(),
            self.workspace_key.clone().into(),
            self.provider_id.clone().into(),
            self.model_id.clone().into(),
            self.query_source.clone().into(),
        ]
    }
}

impl ToolRawRow {
    fn group(&self) -> [rusqlite::types::Value; 3] {
        [
            self.bucket_start.into(),
            self.workspace_key.clone().into(),
            self.tool_name.clone().into(),
        ]
    }
}

/// Node `syncModelRows`: rows that are snapshotted or whose bucket is protected keep their
/// aggregate contribution correct as the raw row changes (writes by either build).
fn sync_model_rows(conn: &Connection) -> Result<(), StoreError> {
    let bucket = bucket_expr("m.started_at");
    let rows: Vec<ModelRawRow> = conn
        .prepare(&format!(
            "
    select m.id, {bucket} as bucket_start,
      coalesce(s.directory, '') as workspace_key, m.provider_id, coalesce(m.model_id, '') as model_id,
      m.query_source, coalesce(m.input_tokens, 0) as input_tokens,
      coalesce(m.output_tokens, 0) as output_tokens, coalesce(m.reasoning_tokens, 0) as reasoning_tokens,
      coalesce(m.cache_creation_input_tokens, 0) as cache_creation_tokens,
      coalesce(m.cache_read_input_tokens, 0) as cache_read_tokens,
      coalesce(m.computed_total_tokens, 0) as computed_total_tokens,
      case when m.status = 'error' then 1 else 0 end as is_error,
      m.time_to_first_token_ms as ttft_ms
    from model_usage m left join session s on s.id = m.session_id
    left join fork_usage_protected_model_raw r on r.raw_id = m.id
    where r.raw_id is not null or exists (
      select 1 from fork_usage_protected_bucket p where p.kind = 'model'
        and p.bucket_start = {bucket}
        and p.workspace_key = coalesce(s.directory, '') and p.provider_id = m.provider_id
        and p.model_id = coalesce(m.model_id, '') and p.query_source = m.query_source
    )
  "
        ))
        .storage()?
        .query_map([], decode_model_row)
        .storage()?
        .collect::<rusqlite::Result<_>>()
        .storage()?;
    let old_by_id: std::collections::HashMap<String, ModelRawRow> = conn
        .prepare(
            "select raw_id, bucket_start, workspace_key, provider_id, model_id, query_source,
      input_tokens, output_tokens, reasoning_tokens, cache_creation_tokens, cache_read_tokens,
      computed_total_tokens, is_error, ttft_ms
    from fork_usage_protected_model_raw",
        )
        .storage()?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ModelRawRow {
                    id: row.get(0)?,
                    bucket_start: row.get(1)?,
                    workspace_key: row.get(2)?,
                    provider_id: row.get(3)?,
                    model_id: row.get(4)?,
                    query_source: row.get(5)?,
                    input_tokens: row.get(6)?,
                    output_tokens: row.get(7)?,
                    reasoning_tokens: row.get(8)?,
                    cache_creation_tokens: row.get(9)?,
                    cache_read_tokens: row.get(10)?,
                    computed_total_tokens: row.get(11)?,
                    is_error: row.get(12)?,
                    ttft_ms: row.get(13)?,
                },
            ))
        })
        .storage()?
        .collect::<rusqlite::Result<Vec<_>>>()
        .storage()?
        .into_iter()
        .collect();
    for row in rows {
        let old = old_by_id.get(&row.id);
        apply_model_difference(conn, old, &row)?;
        if is_protected_model_row(conn, &row)? {
            save_model_raw_row(conn, &row)?;
        } else if old.is_some() {
            conn.execute(
                "delete from fork_usage_protected_model_raw where raw_id = ?",
                rusqlite::params![row.id],
            )
            .storage()?;
        }
    }
    Ok(())
}

/// Node `syncToolRows`.
fn sync_tool_rows(conn: &Connection) -> Result<(), StoreError> {
    let bucket = bucket_expr("u.started_at");
    let rows: Vec<ToolRawRow> = conn
        .prepare(&format!(
            "
    select u.id, {bucket} as bucket_start,
      coalesce(s.directory, '') as workspace_key, u.tool_name,
      case when u.status = 'error' then 1 else 0 end as is_error, u.duration_ms
    from tool_usage u left join session s on s.id = u.session_id
    left join fork_usage_protected_tool_raw r on r.raw_id = u.id
    where r.raw_id is not null or exists (
      select 1 from fork_usage_protected_bucket p where p.kind = 'tool'
        and p.bucket_start = {bucket}
        and p.workspace_key = coalesce(s.directory, '') and p.tool_name = u.tool_name
    )
  "
        ))
        .storage()?
        .query_map([], decode_tool_row)
        .storage()?
        .collect::<rusqlite::Result<_>>()
        .storage()?;
    let old_by_id: std::collections::HashMap<String, ToolRawRow> = conn
        .prepare(
            "select raw_id, bucket_start, workspace_key, tool_name, is_error, duration_ms
    from fork_usage_protected_tool_raw",
        )
        .storage()?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ToolRawRow {
                    id: row.get(0)?,
                    bucket_start: row.get(1)?,
                    workspace_key: row.get(2)?,
                    tool_name: row.get(3)?,
                    is_error: row.get(4)?,
                    duration_ms: row.get(5)?,
                },
            ))
        })
        .storage()?
        .collect::<rusqlite::Result<Vec<_>>>()
        .storage()?
        .into_iter()
        .collect();
    for row in rows {
        let old = old_by_id.get(&row.id);
        apply_tool_difference(conn, old, &row)?;
        if is_protected_tool_row(conn, &row)? {
            save_tool_raw_row(conn, &row)?;
        } else if old.is_some() {
            conn.execute(
                "delete from fork_usage_protected_tool_raw where raw_id = ?",
                rusqlite::params![row.id],
            )
            .storage()?;
        }
    }
    Ok(())
}

fn decode_model_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ModelRawRow> {
    Ok(ModelRawRow {
        id: row.get(0)?,
        bucket_start: row.get(1)?,
        workspace_key: row.get(2)?,
        provider_id: row.get(3)?,
        model_id: row.get(4)?,
        query_source: row.get(5)?,
        input_tokens: row.get(6)?,
        output_tokens: row.get(7)?,
        reasoning_tokens: row.get(8)?,
        cache_creation_tokens: row.get(9)?,
        cache_read_tokens: row.get(10)?,
        computed_total_tokens: row.get(11)?,
        is_error: row.get(12)?,
        ttft_ms: row.get(13)?,
    })
}

fn decode_tool_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ToolRawRow> {
    Ok(ToolRawRow {
        id: row.get(0)?,
        bucket_start: row.get(1)?,
        workspace_key: row.get(2)?,
        tool_name: row.get(3)?,
        is_error: row.get(4)?,
        duration_ms: row.get(5)?,
    })
}

/// Node `applyModelDifference`: a group move retracts the old contribution and re-adds the new
/// one; staying in the group adds only the change (the request count is already correct).
fn apply_model_difference(
    conn: &Connection,
    old: Option<&ModelRawRow>,
    current: &ModelRawRow,
) -> Result<(), StoreError> {
    let same_group = match old {
        Some(old) => {
            old.bucket_start == current.bucket_start
                && old.workspace_key == current.workspace_key
                && old.provider_id == current.provider_id
                && old.model_id == current.model_id
                && old.query_source == current.query_source
        }
        None => false,
    };
    let Some(old) = old else {
        if is_protected_model_row(conn, current)? {
            apply_model_delta(conn, current, 1, None, None)?;
        }
        return Ok(());
    };
    if !same_group {
        apply_model_delta(conn, old, -1, None, None)?;
        if is_protected_model_row(conn, current)? {
            apply_model_delta(conn, current, 1, None, None)?;
        }
        return Ok(());
    }
    if is_protected_model_row(conn, current)? {
        let combined = ModelRawRow {
            input_tokens: current.input_tokens - old.input_tokens,
            output_tokens: current.output_tokens - old.output_tokens,
            reasoning_tokens: current.reasoning_tokens - old.reasoning_tokens,
            cache_creation_tokens: current.cache_creation_tokens - old.cache_creation_tokens,
            cache_read_tokens: current.cache_read_tokens - old.cache_read_tokens,
            computed_total_tokens: current.computed_total_tokens - old.computed_total_tokens,
            is_error: current.is_error - old.is_error,
            ttft_ms: Some(current.ttft_ms.unwrap_or(0) - old.ttft_ms.unwrap_or(0)),
            ..current.clone()
        };
        let ttft_count = i64::from(current.ttft_ms.is_some()) - i64::from(old.ttft_ms.is_some());
        apply_model_delta(conn, &combined, 1, Some(0), Some(ttft_count))?;
    }
    Ok(())
}

/// Node `applyModelDelta`: add `sign *` the row to the protected baseline; the guarded insert
/// (`where exists … protected_bucket`) drops deltas for unprotected groups.
fn apply_model_delta(
    conn: &Connection,
    row: &ModelRawRow,
    sign: i64,
    request_count: Option<i64>,
    ttft_count: Option<i64>,
) -> Result<(), StoreError> {
    let request_count = request_count.unwrap_or(sign);
    let ttft_count = ttft_count.unwrap_or(sign * i64::from(row.ttft_ms.is_some()));
    let mut values: Vec<rusqlite::types::Value> = vec![
        row.bucket_start.into(),
        row.workspace_key.clone().into(),
        row.provider_id.clone().into(),
        row.model_id.clone().into(),
        row.query_source.clone().into(),
        (sign * row.input_tokens).into(),
        (sign * row.output_tokens).into(),
        (sign * row.reasoning_tokens).into(),
        (sign * row.cache_creation_tokens).into(),
        (sign * row.cache_read_tokens).into(),
        (sign * row.computed_total_tokens).into(),
        request_count.into(),
        (sign * row.is_error).into(),
        (sign * row.ttft_ms.unwrap_or(0)).into(),
        ttft_count.into(),
    ];
    values.extend(row.group());
    conn.prepare_cached(
        "
    insert into fork_usage_protected_model (
    bucket_start, workspace_key, provider_id, model_id, query_source, input_tokens, output_tokens,
    reasoning_tokens, cache_creation_tokens, cache_read_tokens, computed_total_tokens, request_count,
    model_error_count, ttft_sum_ms, ttft_count
  ) select ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  where exists (select 1 from fork_usage_protected_bucket p where p.kind='model'
    and p.bucket_start=? and p.workspace_key=? and p.provider_id=? and p.model_id=? and p.query_source=?)
  on conflict(bucket_start, workspace_key, provider_id, model_id, query_source) do update set
    input_tokens=input_tokens+excluded.input_tokens, output_tokens=output_tokens+excluded.output_tokens,
    reasoning_tokens=reasoning_tokens+excluded.reasoning_tokens,
    cache_creation_tokens=cache_creation_tokens+excluded.cache_creation_tokens,
    cache_read_tokens=cache_read_tokens+excluded.cache_read_tokens,
    computed_total_tokens=computed_total_tokens+excluded.computed_total_tokens,
    request_count=request_count+excluded.request_count, model_error_count=model_error_count+excluded.model_error_count,
    ttft_sum_ms=ttft_sum_ms+excluded.ttft_sum_ms, ttft_count=ttft_count+excluded.ttft_count",
    )
    .storage()?
    .execute(rusqlite::params_from_iter(values))
    .storage()?;
    Ok(())
}

/// Node `applyToolDifference`.
fn apply_tool_difference(
    conn: &Connection,
    old: Option<&ToolRawRow>,
    current: &ToolRawRow,
) -> Result<(), StoreError> {
    let Some(old) = old else {
        if is_protected_tool_row(conn, current)? {
            apply_tool_delta(conn, current, 1, None, None)?;
        }
        return Ok(());
    };
    let same_group = old.bucket_start == current.bucket_start
        && old.workspace_key == current.workspace_key
        && old.tool_name == current.tool_name;
    if !same_group {
        apply_tool_delta(conn, old, -1, None, None)?;
        if is_protected_tool_row(conn, current)? {
            apply_tool_delta(conn, current, 1, None, None)?;
        }
        return Ok(());
    }
    let delta = ToolRawRow {
        is_error: current.is_error - old.is_error,
        duration_ms: Some(current.duration_ms.unwrap_or(0) - old.duration_ms.unwrap_or(0)),
        ..current.clone()
    };
    if is_protected_tool_row(conn, current)? {
        let duration_count =
            i64::from(current.duration_ms.is_some()) - i64::from(old.duration_ms.is_some());
        apply_tool_delta(conn, &delta, 1, Some(0), Some(duration_count))?;
    }
    Ok(())
}

/// Node `applyToolDelta`.
fn apply_tool_delta(
    conn: &Connection,
    row: &ToolRawRow,
    sign: i64,
    call_count: Option<i64>,
    duration_count: Option<i64>,
) -> Result<(), StoreError> {
    let call_count = call_count.unwrap_or(sign);
    let duration_count = duration_count.unwrap_or(sign * i64::from(row.duration_ms.is_some()));
    let mut values: Vec<rusqlite::types::Value> = vec![
        row.bucket_start.into(),
        row.workspace_key.clone().into(),
        row.tool_name.clone().into(),
        call_count.into(),
        (sign * row.is_error).into(),
        (sign * row.duration_ms.unwrap_or(0)).into(),
        duration_count.into(),
    ];
    values.extend(row.group());
    conn.prepare_cached(
        "
    insert into fork_usage_protected_tool (
    bucket_start, workspace_key, tool_name, call_count, error_count, duration_sum_ms, duration_count
  ) select ?, ?, ?, ?, ?, ?, ? where exists (
    select 1 from fork_usage_protected_bucket p where p.kind='tool' and p.bucket_start=?
      and p.workspace_key=? and p.tool_name=?
  ) on conflict(bucket_start, workspace_key, tool_name) do update set
    call_count=call_count+excluded.call_count, error_count=error_count+excluded.error_count,
    duration_sum_ms=duration_sum_ms+excluded.duration_sum_ms,
    duration_count=duration_count+excluded.duration_count",
    )
    .storage()?
    .execute(rusqlite::params_from_iter(values))
    .storage()?;
    Ok(())
}

fn is_protected_model_row(conn: &Connection, row: &ModelRawRow) -> Result<bool, StoreError> {
    conn.query_row(
        "select 1 from fork_usage_protected_bucket where kind='model'
    and bucket_start=? and workspace_key=? and provider_id=? and model_id=? and query_source=?",
        rusqlite::params_from_iter(row.group()),
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .storage()
    .map(|found| found.is_some())
}

fn is_protected_tool_row(conn: &Connection, row: &ToolRawRow) -> Result<bool, StoreError> {
    conn.query_row(
        "select 1 from fork_usage_protected_bucket where kind='tool'
    and bucket_start=? and workspace_key=? and tool_name=?",
        rusqlite::params_from_iter(row.group()),
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .storage()
    .map(|found| found.is_some())
}

/// Node's `save` upsert for model snapshots.
fn save_model_raw_row(conn: &Connection, row: &ModelRawRow) -> Result<(), StoreError> {
    let mut values: Vec<rusqlite::types::Value> = vec![row.id.clone().into()];
    values.extend(row.group());
    values.extend([
        row.input_tokens.into(),
        row.output_tokens.into(),
        row.reasoning_tokens.into(),
        row.cache_creation_tokens.into(),
        row.cache_read_tokens.into(),
        row.computed_total_tokens.into(),
        row.is_error.into(),
        match row.ttft_ms {
            Some(ttft) => ttft.into(),
            None => rusqlite::types::Value::Null,
        },
    ]);
    conn.prepare_cached(
        "insert into fork_usage_protected_model_raw (
    raw_id, bucket_start, workspace_key, provider_id, model_id, query_source, input_tokens,
    output_tokens, reasoning_tokens, cache_creation_tokens, cache_read_tokens, computed_total_tokens,
    is_error, ttft_ms
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict(raw_id) do update set bucket_start=excluded.bucket_start, workspace_key=excluded.workspace_key,
    provider_id=excluded.provider_id, model_id=excluded.model_id, query_source=excluded.query_source,
    input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
    reasoning_tokens=excluded.reasoning_tokens, cache_creation_tokens=excluded.cache_creation_tokens,
    cache_read_tokens=excluded.cache_read_tokens, computed_total_tokens=excluded.computed_total_tokens,
    is_error=excluded.is_error, ttft_ms=excluded.ttft_ms",
    )
    .storage()?
    .execute(rusqlite::params_from_iter(values))
    .storage()?;
    Ok(())
}

/// Node's `save` upsert for tool snapshots.
fn save_tool_raw_row(conn: &Connection, row: &ToolRawRow) -> Result<(), StoreError> {
    conn.prepare_cached(
        "insert into fork_usage_protected_tool_raw
    (raw_id, bucket_start, workspace_key, tool_name, is_error, duration_ms) values (?, ?, ?, ?, ?, ?)
  on conflict(raw_id) do update set bucket_start=excluded.bucket_start,
    workspace_key=excluded.workspace_key, tool_name=excluded.tool_name,
    is_error=excluded.is_error, duration_ms=excluded.duration_ms",
    )
    .storage()?
    .execute(rusqlite::params![
        row.id,
        row.bucket_start,
        row.workspace_key,
        row.tool_name,
        row.is_error,
        row.duration_ms,
    ])
    .storage()?;
    Ok(())
}

/// Node `chunks` with the shared `ID_CHUNK_SIZE` of 400.
fn chunks(items: &[String]) -> Vec<&[String]> {
    items.chunks(400).collect()
}

/// Node `placeholders`.
fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}
