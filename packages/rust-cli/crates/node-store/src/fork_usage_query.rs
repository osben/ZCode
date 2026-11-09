//! Fork: the App Usage read path behind `v4/usage/stats` (Node `fork-usage-query.ts`:
//! `queryAppUsageWithRollup`). The long-lived rollup answers first; the raw tables are only a
//! fallback, and a request neither can answer correctly (detached history, active filters, or a
//! bounded window older than the raw retention) fails loudly with `usage_rollup_unavailable`.
//! The SQL is copied verbatim so both agents read the shared `db.sqlite` identically
//! (specs/fork-rust-agent-parity.md).

use std::collections::BTreeMap;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension};
use rust_cli_kernel_api::store::{
    AppUsageDayModelRow, AppUsageDayRow, AppUsageFacets, AppUsageModelRow, AppUsageRows,
    AppUsageSessionRow, AppUsageSpan, AppUsageToolRow, AppUsageTotals, AppUsageTurnTotals,
    StoreError, USAGE_ROLLUP_UNAVAILABLE,
};

use crate::OrStorage;
use crate::fork_usage_rollup::{
    align_down_to_bucket, ensure_detached_schema, ensure_rollup_schema, is_ready, refresh_for_read,
    sync_protected_raw_rows,
};
use crate::usage_v4;

const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;
/// Tokens per local weekday and hour: a 7x24 grid.
const HOURLY_CELLS: usize = 7 * 24;
const FACET_LIMIT: i64 = 200;
const TOP_SESSIONS_LIMIT: i64 = 10;
/// Mirrors the raw-table retention in usage.ts (not exported there, and that file stays
/// upstream-identical).
const RAW_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Node `queryAppUsageWithRollup`: rollup first, raw tables only as the fallback, loud
/// `usage_rollup_unavailable` when neither can answer correctly. The all-time range (`since` = 0)
/// keeps its legacy meaning, "whatever the raw tables still hold", and may fall back; the result
/// then carries `rollup_fallback_reason` so the protocol layer can log it.
pub(crate) fn query_with_rollup(
    conn: &Connection,
    span: &AppUsageSpan,
    now_ms: u64,
) -> Result<AppUsageRows, StoreError> {
    let now = i64::try_from(now_ms).unwrap_or(i64::MAX);
    let reason = match read_from_rollup(conn, span, now_ms) {
        Ok(rows) => return Ok(rows),
        Err(reason) => reason,
    };
    if has_detached_usage_state(conn) {
        return Err(unavailable());
    }
    if has_filters(&span.filters) || reaches_beyond_raw_retention(span.since_ms, now) {
        return Err(unavailable());
    }
    let mut rows = usage_v4::app_usage(conn, span)?;
    rows.rollup_fallback_reason = Some(reason);
    Ok(rows)
}

/// The try-block of Node's `queryAppUsageWithRollup`: schemas, the protected-row sync, the read
/// recompute, the readiness check, then the rollup query itself. The failure string is the reason
/// the fallback result carries (Node reads it off the caught error).
fn read_from_rollup(
    conn: &Connection,
    span: &AppUsageSpan,
    now_ms: u64,
) -> Result<AppUsageRows, String> {
    ensure_rollup_schema(conn, now_ms).map_err(store_error_message)?;
    ensure_detached_schema(conn, now_ms).map_err(store_error_message)?;
    // Busy lock or surrounding transaction: deltas are applied on the next read/recompute.
    let _ = sync_protected_quietly(conn);
    let refresh_error = refresh_for_read(conn, now_ms);
    // A skipped first recompute leaves empty tables that would answer with zeros; "never
    // computed" is unavailable, not empty. A stale watermark from an earlier recompute still
    // answers (Node: refresh never throws, readiness decides).
    if !is_ready(conn) {
        return Err(refresh_error.unwrap_or_else(|| "rollup_not_ready".to_owned()));
    }
    query_from_rollup(conn, span).map_err(store_error_message)
}

/// Node `queryAppUsageFromRollup`: the rollup-view aggregation for one span.
fn query_from_rollup(conn: &Connection, span: &AppUsageSpan) -> Result<AppUsageRows, StoreError> {
    let (since, until, offset) = (span.since_ms, span.until_ms, span.tz_offset_ms);
    let bucket = build_where(since, until, &span.filters, Scope::Bucket);
    let scoped = build_where(since, until, &span.filters, Scope::Workspace);
    let day_expr = "cast((bucket_start + ?) / ? as integer)";

    let totals = conn
        .query_row(
            &format!(
                "select
                   coalesce(sum(computed_total_tokens), 0) as totalTokens,
                   coalesce(sum(input_tokens), 0) as inputTokens,
                   coalesce(sum(output_tokens), 0) as outputTokens,
                   coalesce(sum(reasoning_tokens), 0) as reasoningTokens,
                   coalesce(sum(cache_creation_tokens), 0) as cacheCreationTokens,
                   coalesce(sum(cache_read_tokens), 0) as cacheReadTokens,
                   coalesce(sum(request_count), 0) as modelRequestCount,
                   coalesce(sum(model_error_count), 0) as modelErrorCount,
                   coalesce(sum(ttft_sum_ms), 0) as ttftSum,
                   coalesce(sum(ttft_count), 0) as ttftCount
                 from fork_usage_bucket_all where {}",
                bucket.sql
            ),
            rusqlite::params_from_iter(bucket.params.clone()),
            |row| {
                let ttft_sum: i64 = row.get(8)?;
                let ttft_count: i64 = row.get(9)?;
                Ok(AppUsageTotals {
                    total_tokens: row.get(0)?,
                    input_tokens: row.get(1)?,
                    output_tokens: row.get(2)?,
                    reasoning_tokens: row.get(3)?,
                    cache_creation_tokens: row.get(4)?,
                    cache_read_tokens: row.get(5)?,
                    model_request_count: row.get(6)?,
                    model_error_count: row.get(7)?,
                    avg_time_to_first_token_ms: (ttft_count > 0)
                        .then_some(ttft_sum as f64 / ttft_count as f64),
                })
            },
        )
        .storage()?;

    let (total_sessions, total_turns, duration_sum, duration_count) = conn
        .query_row(
            &format!(
                "select
                   count(distinct session_id) as totalSessions,
                   coalesce(sum(turn_count), 0) as totalTurns,
                   coalesce(sum(completed_duration_sum_ms), 0) as durationSum,
                   coalesce(sum(completed_count), 0) as durationCount
                 from fork_usage_turn_all where {}",
                scoped.sql
            ),
            rusqlite::params_from_iter(scoped.params.clone()),
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .storage()?;
    let longest_session_ms = conn
        .query_row(
            &format!(
                "select coalesce(max(sessionDurationMs), 0) as longestSessionMs
                 from (
                   select sum(completed_duration_sum_ms) as sessionDurationMs
                   from fork_usage_turn_all where {}
                   group by session_id
                 )",
                scoped.sql
            ),
            rusqlite::params_from_iter(scoped.params.clone()),
            |row| row.get::<_, i64>(0),
        )
        .storage()?;

    let (tool_call_count, tool_error_count) = conn
        .query_row(
            &format!(
                "select
                   coalesce(sum(call_count), 0) as toolCallCount,
                   coalesce(sum(error_count), 0) as toolErrorCount
                 from fork_usage_tool_all where {}",
                scoped.sql
            ),
            rusqlite::params_from_iter(scoped.params.clone()),
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .storage()?;

    let models = usage_v4::query_all(
        conn,
        &format!(
            "select
               model_id as modelId,
               coalesce(sum(computed_total_tokens), 0) as totalTokens,
               coalesce(sum(input_tokens), 0) as inputTokens,
               coalesce(sum(output_tokens), 0) as outputTokens,
               coalesce(sum(request_count), 0) as requestCount
             from fork_usage_bucket_all where {}
             group by model_id
             order by totalTokens desc",
            bucket.sql
        ),
        rusqlite::params_from_iter(bucket.params.clone()),
        |row| {
            Ok(AppUsageModelRow {
                // The rollup coalesces NULL model ids to '' on write, so this is never null.
                model_id: Some(row.get::<_, String>(0)?),
                total_tokens: row.get(1)?,
                input_tokens: row.get(2)?,
                output_tokens: row.get(3)?,
                request_count: row.get(4)?,
            })
        },
    )?;

    let tools = usage_v4::query_all(
        conn,
        &format!(
            "select
               tool_name as toolName,
               coalesce(sum(call_count), 0) as callCount,
               coalesce(sum(error_count), 0) as errorCount,
               coalesce(sum(duration_sum_ms), 0) as durationSum,
               coalesce(sum(duration_count), 0) as durationCount
             from fork_usage_tool_all where {}
             group by tool_name
             order by callCount desc",
            scoped.sql
        ),
        rusqlite::params_from_iter(scoped.params.clone()),
        |row| {
            let duration_sum: i64 = row.get(3)?;
            let duration_count: i64 = row.get(4)?;
            Ok(AppUsageToolRow {
                tool_name: row.get(0)?,
                call_count: row.get(1)?,
                error_count: row.get(2)?,
                avg_duration_ms: (duration_count > 0)
                    .then_some(duration_sum as f64 / duration_count as f64),
            })
        },
    )?;

    let day_params = |clause: &WhereClause| {
        let mut params: Vec<SqlValue> = vec![offset.into(), DAY_MS.into()];
        params.extend(clause.params.iter().cloned());
        params
    };
    let token_days = usage_v4::query_all(
        conn,
        &format!(
            "select {day_expr} as dayIndex, coalesce(sum(computed_total_tokens), 0) as totalTokens
             from fork_usage_bucket_all where {} group by dayIndex",
            bucket.sql
        ),
        rusqlite::params_from_iter(day_params(&bucket)),
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let turn_days = usage_v4::query_all(
        conn,
        &format!(
            "select {day_expr} as dayIndex, coalesce(sum(turn_count), 0) as turnCount
             from fork_usage_turn_all where {} group by dayIndex",
            scoped.sql
        ),
        rusqlite::params_from_iter(day_params(&scoped)),
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let tool_days = usage_v4::query_all(
        conn,
        &format!(
            "select {day_expr} as dayIndex, coalesce(sum(call_count), 0) as toolCallCount
             from fork_usage_tool_all where {} group by dayIndex",
            scoped.sql
        ),
        rusqlite::params_from_iter(day_params(&scoped)),
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let day_models = usage_v4::query_all(
        conn,
        &format!(
            "select {day_expr} as dayIndex, model_id as modelId,
               coalesce(sum(computed_total_tokens), 0) as totalTokens
             from fork_usage_bucket_all where {} group by dayIndex, model_id",
            bucket.sql
        ),
        rusqlite::params_from_iter(day_params(&bucket)),
        |row| {
            Ok(AppUsageDayModelRow {
                day_index: row.get(0)?,
                model_id: Some(row.get::<_, String>(1)?),
                total_tokens: row.get(2)?,
            })
        },
    )?;

    // Merge the three daily statistics onto the same dayIndex (Node builds one map then sorts
    // by dayIndex; a BTreeMap gives the same sorted order).
    let mut day_map: BTreeMap<i64, (i64, i64, i64)> = BTreeMap::new();
    for (day_index, tokens) in token_days {
        day_map.insert(day_index, (tokens, 0, 0));
    }
    for (day_index, turns) in turn_days {
        let entry = day_map.entry(day_index).or_insert((0, 0, 0));
        entry.1 = turns;
    }
    for (day_index, calls) in tool_days {
        let entry = day_map.entry(day_index).or_insert((0, 0, 0));
        entry.2 = calls;
    }
    let days = day_map
        .into_iter()
        .map(
            |(day_index, (total_tokens, turn_count, tool_call_count))| AppUsageDayRow {
                day_index,
                total_tokens,
                turn_count,
                tool_call_count,
            },
        )
        .collect();

    Ok(AppUsageRows {
        facets: span
            .include_facets
            .then(|| query_facets(conn, since, until))
            .transpose()?,
        hourly_tokens: span
            .hourly
            .then(|| query_hourly_tokens(conn, &bucket, offset))
            .transpose()?,
        top_sessions: span
            .top_sessions
            .then(|| query_top_sessions(conn, &scoped))
            .transpose()?,
        totals,
        turn_totals: AppUsageTurnTotals {
            total_sessions,
            total_turns,
            avg_turn_duration_ms: (duration_count > 0)
                .then_some(duration_sum as f64 / duration_count as f64),
            longest_session_ms,
        },
        tool_totals: rust_cli_kernel_api::store::AppUsageToolTotals {
            tool_call_count,
            tool_error_count,
        },
        models,
        tools,
        days,
        day_models,
        rollup_fallback_reason: None,
    })
}

/// Node `syncForkUsageProtectedRawRows` opens its own immediate transaction when the caller
/// holds none; the reconcile must be atomic, or an interrupted run re-applies its deltas on the
/// next read and double-counts protected baselines. The ported body has no transaction of its
/// own, so the read path wraps it the same way.
fn sync_protected_quietly(conn: &Connection) -> Result<(), StoreError> {
    if !conn.is_autocommit() {
        return sync_protected_raw_rows(conn);
    }
    conn.execute_batch("begin immediate").storage()?;
    match sync_protected_raw_rows(conn) {
        Ok(()) => conn.execute_batch("commit").storage(),
        Err(error) => {
            let _ = conn.execute_batch("rollback");
            Err(error)
        }
    }
}

/// Node `buildWhere`'s scope: "bucket" filters the dimension columns of
/// `fork_usage_bucket_all`, "workspace" only the columns every rollup view shares.
#[derive(Clone, Copy, PartialEq)]
enum Scope {
    Bucket,
    Workspace,
}

/// Node `WhereClause`.
struct WhereClause {
    sql: String,
    params: Vec<SqlValue>,
}

/// Node `inList`.
fn in_list(column: &str, values: &[String], out: &mut WhereClause) {
    if values.is_empty() {
        return;
    }
    let placeholders = vec!["?"; values.len()].join(", ");
    out.sql
        .push_str(&format!(" and {column} in ({placeholders})"));
    out.params
        .extend(values.iter().cloned().map(SqlValue::Text));
}

/// Node `buildWhere`.
fn build_where(
    since: i64,
    until: i64,
    filters: &rust_cli_kernel_api::store::AppUsageFilters,
    scope: Scope,
) -> WhereClause {
    let mut clause = WhereClause {
        sql: "bucket_start >= ? and bucket_start <= ?".to_owned(),
        params: vec![align_down_to_bucket(since).into(), until.into()],
    };
    in_list("workspace_key", &filters.workspace_keys, &mut clause);
    if scope == Scope::Bucket {
        in_list("model_id", &filters.model_ids, &mut clause);
        in_list("provider_id", &filters.provider_ids, &mut clause);
        in_list("query_source", &filters.query_sources, &mut clause);
    }
    clause
}

/// Node `hasFilters`.
fn has_filters(filters: &rust_cli_kernel_api::store::AppUsageFilters) -> bool {
    !filters.is_empty()
}

/// Node `reachesBeyondRawRetention`: a bounded window that reaches past the raw retention cannot
/// be answered from the raw tables.
fn reaches_beyond_raw_retention(since: i64, now: i64) -> bool {
    since > 0 && since < now - RAW_RETENTION_MS
}

/// Node `queryFacets`: filter options for the window; deliberately ignores the active filters so
/// choices never vanish.
fn query_facets(conn: &Connection, since: i64, until: i64) -> Result<AppUsageFacets, StoreError> {
    let range = [align_down_to_bucket(since), until];
    let where_sql = "bucket_start >= ? and bucket_start <= ?";
    let distinct = |sql: String, params: Vec<SqlValue>| -> Result<Vec<String>, StoreError> {
        usage_v4::query_all(conn, &sql, rusqlite::params_from_iter(params), |row| {
            row.get::<_, String>(0)
        })
    };
    let bucket_column = |column: &str| {
        distinct(
            format!(
                "select distinct {column} as value from fork_usage_bucket_all \
                 where {where_sql} order by value limit {FACET_LIMIT}"
            ),
            range.iter().map(|value| (*value).into()).collect(),
        )
    };
    let workspaces = distinct(
        format!(
            "select value from (
               select workspace_key as value from fork_usage_bucket_all where {where_sql}
               union select workspace_key from fork_usage_turn_all where {where_sql}
               union select workspace_key from fork_usage_tool_all where {where_sql}
             ) order by value limit {FACET_LIMIT}"
        ),
        range
            .iter()
            .chain(range.iter())
            .chain(range.iter())
            .cloned()
            .map(SqlValue::from)
            .collect(),
    );
    Ok(AppUsageFacets {
        models: bucket_column("model_id")?,
        providers: bucket_column("provider_id")?,
        query_sources: bucket_column("query_source")?,
        workspaces: workspaces?,
    })
}

/// Node `queryHourlyTokens`: tokens per local weekday and hour. 15-minute buckets never straddle
/// a local hour boundary.
fn query_hourly_tokens(
    conn: &Connection,
    bucket: &WhereClause,
    tz_offset_ms: i64,
) -> Result<Vec<i64>, StoreError> {
    let mut params: Vec<SqlValue> = vec![
        tz_offset_ms.into(),
        DAY_MS.into(),
        tz_offset_ms.into(),
        DAY_MS.into(),
        HOUR_MS.into(),
    ];
    params.extend(bucket.params.iter().cloned());
    let rows = usage_v4::query_all(
        conn,
        &format!(
            "select
               (cast((bucket_start + ?) / ? as integer) + 4) % 7 as weekday,
               cast(((bucket_start + ?) % ?) / ? as integer) as hour,
               coalesce(sum(computed_total_tokens), 0) as totalTokens
             from fork_usage_bucket_all where {}
             group by weekday, hour",
            bucket.sql
        ),
        rusqlite::params_from_iter(params),
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;
    let mut cells = vec![0_i64; HOURLY_CELLS];
    for (weekday, hour, tokens) in rows {
        let index = weekday * 24 + hour;
        if index >= 0 && (index as usize) < HOURLY_CELLS {
            cells[index as usize] = tokens;
        }
    }
    Ok(cells)
}

/// Node `queryTopSessions`: heaviest live sessions in the window (the title join only sees
/// sessions that still exist, hence the base `fork_usage_turn`, not the `_all` view).
fn query_top_sessions(
    conn: &Connection,
    scoped: &WhereClause,
) -> Result<Vec<AppUsageSessionRow>, StoreError> {
    let sql = scoped
        .sql
        .replace("bucket_start", "t.bucket_start")
        .replace("workspace_key", "t.workspace_key");
    usage_v4::query_all(
        conn,
        &format!(
            "select
               t.session_id as sessionId,
               s.title as title,
               max(t.workspace_key) as workspaceKey,
               coalesce(sum(t.total_tokens), 0) as totalTokens,
               coalesce(sum(t.turn_count), 0) as turnCount,
               coalesce(sum(t.completed_duration_sum_ms), 0) as durationMs
             from fork_usage_turn t
             join session s on s.id = t.session_id
             where {sql}
             group by t.session_id
             having totalTokens > 0
             order by totalTokens desc
             limit {TOP_SESSIONS_LIMIT}"
        ),
        rusqlite::params_from_iter(scoped.params.clone()),
        |row| {
            Ok(AppUsageSessionRow {
                session_id: row.get(0)?,
                title: row.get(1)?,
                workspace_key: row.get(2)?,
                total_tokens: row.get(3)?,
                turn_count: row.get(4)?,
                duration_ms: row.get(5)?,
            })
        },
    )
}

/// Node `hasDetachedUsageState`: erased sessions exist, so the raw tables under-count and the
/// fallback is not allowed. Read errors count as "no detached state" (Node would throw here; the
/// tables are ensured just before, so the reads cannot fail in practice).
fn has_detached_usage_state(conn: &Connection) -> bool {
    for table in ["fork_usage_detached_turn", "fork_usage_protected_bucket"] {
        let exists = conn
            .query_row(
                "select 1 from sqlite_master where type = 'table' and name = ?",
                rusqlite::params![table],
                |_| Ok(true),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or(false);
        if exists {
            let has_row = conn
                .query_row(&format!("select 1 from {table} limit 1"), [], |_| Ok(true))
                .optional()
                .ok()
                .flatten()
                .unwrap_or(false);
            if has_row {
                return true;
            }
        }
    }
    false
}

/// The error both agents use when neither the rollup nor the raw tables can answer correctly.
fn unavailable() -> StoreError {
    StoreError::Storage {
        message: USAGE_ROLLUP_UNAVAILABLE.to_owned(),
    }
}

/// The message Node's caught error would carry (`error.message`).
fn store_error_message(error: StoreError) -> String {
    match error {
        StoreError::Storage { message } => message,
        other => other.to_string(),
    }
}

#[cfg(test)]
#[path = "fork_usage_query_tests.rs"]
mod tests;
