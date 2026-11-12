//! Fork: the raw-table reads behind `v4/usage/stats` and `v4/conversation/usage`
//! (Node `adapters/.../repositories/usage.ts`: `queryAppUsage` and `queryTaskUsage`;
//! specs/fork-rust-agent-parity.md). The SQL is copied verbatim so both agents read
//! the shared `db.sqlite` identically; the snapshot composition and request planning
//! stay in the protocol layer, like Node's `usage-stats-builder` / `usage-stats-run`.
//!
//! `app_usage` is the raw-table fallback of Node's `queryAppUsageWithRollup`
//! (`fork_usage_query`): the rollup answers first, and the caller stamps the failure
//! reason onto the fallback result (`rollup_fallback_reason`); the raw tables cannot
//! compute the rollup-only extras (facets, hourly grid, top sessions).

use std::collections::BTreeMap;

use crate::OrStorage;
use rusqlite::{Connection, params};
use rust_cli_kernel_api::store::{
    AppUsageDayModelRow, AppUsageDayRow, AppUsageModelRow, AppUsageRows, AppUsageSpan,
    AppUsageToolRow, AppUsageTotals, AppUsageTurnTotals, StoreError, TaskUsageTotals,
};

/// Node keeps this private in usage.ts; the day-bucket queries below must divide by the
/// same day length the planner used.
const DAY_MS: i64 = 86_400_000;

/// Node `queryAppUsage`: the raw usage-table aggregation for one `[since, until]` span,
/// bucketed into local days by the fixed `tz_offset_ms` (day = floor((started_at + offset) / DAY)).
pub(crate) fn app_usage(
    conn: &Connection,
    span: &AppUsageSpan,
) -> Result<AppUsageRows, StoreError> {
    let (since, until, offset) = (span.since_ms, span.until_ms, span.tz_offset_ms);

    let totals = conn
        .query_row(
            "
        select
           coalesce(sum(computed_total_tokens), 0) as totalTokens,
           coalesce(sum(input_tokens), 0) as inputTokens,
           coalesce(sum(output_tokens), 0) as outputTokens,
           coalesce(sum(reasoning_tokens), 0) as reasoningTokens,
           coalesce(sum(cache_creation_input_tokens), 0) as cacheCreationTokens,
           coalesce(sum(cache_read_input_tokens), 0) as cacheReadTokens,
           count(*) as modelRequestCount,
           coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as modelErrorCount,
           avg(time_to_first_token_ms) as avgTimeToFirstTokenMs
         from model_usage
         where started_at >= ? and started_at <= ?",
            params![since, until],
            |row| {
                Ok(AppUsageTotals {
                    total_tokens: row.get(0)?,
                    input_tokens: row.get(1)?,
                    output_tokens: row.get(2)?,
                    reasoning_tokens: row.get(3)?,
                    cache_creation_tokens: row.get(4)?,
                    cache_read_tokens: row.get(5)?,
                    model_request_count: row.get(6)?,
                    model_error_count: row.get(7)?,
                    avg_time_to_first_token_ms: row.get(8)?,
                })
            },
        )
        .storage()?;

    let (total_sessions, total_turns, avg_turn_duration_ms) = conn
        .query_row(
            "
        select
           count(distinct session_id) as totalSessions,
           count(*) as totalTurns,
           avg(case when status = 'completed' then duration_ms else null end) as avgTurnDurationMs
         from turn_usage
         where started_at >= ? and started_at <= ?",
            params![since, until],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get(2)?)),
        )
        .storage()?;
    let longest_session_ms = conn
        .query_row(
            "
        select coalesce(max(sessionDurationMs), 0) as longestSessionMs
         from (
           select coalesce(sum(case when status = 'completed' then duration_ms else 0 end), 0)
             as sessionDurationMs
           from turn_usage
           where started_at >= ? and started_at <= ?
           group by session_id
         )",
            params![since, until],
            |row| row.get::<_, i64>(0),
        )
        .storage()?;

    let (tool_call_count, tool_error_count) = conn
        .query_row(
            "
        select
           count(*) as toolCallCount,
           coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as toolErrorCount
         from tool_usage
         where started_at >= ? and started_at <= ?",
            params![since, until],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )
        .storage()?;

    let models = query_all(
        conn,
        "
        select
           model_id as modelId,
           coalesce(sum(computed_total_tokens), 0) as totalTokens,
           coalesce(sum(input_tokens), 0) as inputTokens,
           coalesce(sum(output_tokens), 0) as outputTokens,
           count(*) as requestCount
         from model_usage
         where started_at >= ? and started_at <= ?
         group by model_id
         order by totalTokens desc",
        params![since, until],
        |row| {
            Ok(AppUsageModelRow {
                model_id: row.get(0)?,
                total_tokens: row.get(1)?,
                input_tokens: row.get(2)?,
                output_tokens: row.get(3)?,
                request_count: row.get(4)?,
            })
        },
    )?;

    let tools = query_all(
        conn,
        "
        select
           tool_name as toolName,
           count(*) as callCount,
           coalesce(sum(case when status = 'error' then 1 else 0 end), 0) as errorCount,
           avg(duration_ms) as avgDurationMs
         from tool_usage
         where started_at >= ? and started_at <= ?
         group by tool_name
         order by callCount desc",
        params![since, until],
        |row| {
            Ok(AppUsageToolRow {
                tool_name: row.get(0)?,
                call_count: row.get(1)?,
                error_count: row.get(2)?,
                avg_duration_ms: row.get(3)?,
            })
        },
    )?;

    let day_tokens = query_all(
        conn,
        "
        select
           cast((started_at + ?) / ? as integer) as dayIndex,
           coalesce(sum(computed_total_tokens), 0) as totalTokens
         from model_usage
         where started_at >= ? and started_at <= ?
         group by dayIndex",
        params![offset, DAY_MS, since, until],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let turn_days = query_all(
        conn,
        "
        select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as turnCount
         from turn_usage
         where started_at >= ? and started_at <= ?
         group by dayIndex",
        params![offset, DAY_MS, since, until],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let tool_days = query_all(
        conn,
        "
        select cast((started_at + ?) / ? as integer) as dayIndex, count(*) as toolCallCount
         from tool_usage
         where started_at >= ? and started_at <= ?
         group by dayIndex",
        params![offset, DAY_MS, since, until],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;

    // Merge the three daily statistics onto the same dayIndex (Node builds one map then sorts
    // by dayIndex; a BTreeMap gives the same sorted order).
    let mut day_map: BTreeMap<i64, (i64, i64, i64)> = BTreeMap::new();
    for (day_index, tokens) in day_tokens {
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

    let day_models = query_all(
        conn,
        "
        select
           cast((started_at + ?) / ? as integer) as dayIndex,
           model_id as modelId,
           coalesce(sum(computed_total_tokens), 0) as totalTokens
         from model_usage
         where started_at >= ? and started_at <= ?
         group by dayIndex, model_id",
        params![offset, DAY_MS, since, until],
        |row| {
            Ok(AppUsageDayModelRow {
                day_index: row.get(0)?,
                model_id: row.get(1)?,
                total_tokens: row.get(2)?,
            })
        },
    )?;

    Ok(AppUsageRows {
        totals,
        turn_totals: AppUsageTurnTotals {
            total_sessions,
            total_turns,
            avg_turn_duration_ms,
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
        // Rollup-only extras (facets, hourly grid, top sessions): the raw tables cannot
        // compute them, so they stay absent like Node's fallback result. The fallback reason
        // is the rollup's failure message and is set by the caller (`fork_usage_query`).
        facets: None,
        hourly_tokens: None,
        top_sessions: None,
        rollup_fallback_reason: None,
    })
}

/// Node `queryTaskUsage`: per-session incremental totals. Later requests of the same
/// query source only count the context growth over the previous request (compaction
/// lowers the baseline instead of subtracting from history); unknown sources count in
/// full and keep their cache columns.
pub(crate) fn task_usage(conn: &Connection, session: &str) -> Result<TaskUsageTotals, StoreError> {
    let rows = query_all(
        conn,
        "
        select
           id,
           query_source as querySource,
           status,
           input_tokens as inputTokens,
           output_tokens as outputTokens,
           reasoning_tokens as reasoningTokens,
           cache_creation_input_tokens as cacheCreationTokens,
           cache_read_input_tokens as cacheReadTokens,
           computed_total_tokens as computedTotalTokens,
           provider_total_tokens as providerTotalTokens
         from model_usage
         where session_id = ?
         order by started_at asc, id asc",
        params![session],
        |row| {
            Ok(TaskRow {
                query_source: row.get(1)?,
                status: row.get(2)?,
                input_tokens: row.get(3)?,
                output_tokens: row.get(4)?,
                reasoning_tokens: row.get(5)?,
                cache_creation: row.get(6)?,
                cache_read: row.get(7)?,
                computed_total: row.get(8)?,
                provider_total: row.get(9)?,
            })
        },
    )?;

    let mut totals = TaskUsageTotals::default();
    // Insertion order matches Node's object keys (main_turn / subagent / workflow_child
    // as first seen); the protocol layer emits the map as received.
    let mut baselines: Vec<(String, i64)> = Vec::new();
    for row in &rows {
        let raw_total_tokens = row.provider_total.unwrap_or(row.computed_total);
        let input_side_tokens = input_side_tokens(row);
        let source = baseline_source(&row.query_source);
        let baseline = source
            .and_then(|source| baselines.iter().find(|(key, _)| key == source))
            .map_or(0, |(_, value)| *value);
        let incremental_input_tokens = match source {
            Some(_) => (input_side_tokens - baseline).max(0),
            None => input_side_tokens,
        };
        if let Some(source) = source {
            // Compaction reduces subsequent context input; do not subtract that reduction
            // from historical cumulative usage. But lower the baseline to the compacted
            // value so later turns can continue to be counted incrementally.
            match baselines.iter_mut().find(|(key, _)| key == source) {
                Some(entry) => entry.1 = input_side_tokens,
                None => baselines.push((source.to_owned(), input_side_tokens)),
            }
        }
        let non_input_tokens = (raw_total_tokens - input_side_tokens).max(0);
        totals.total_tokens += incremental_input_tokens + non_input_tokens;
        totals.input_tokens += incremental_input_tokens;
        totals.output_tokens += row.output_tokens;
        totals.reasoning_tokens += row.reasoning_tokens;
        if source.is_none() {
            totals.cache_creation_tokens += row.cache_creation;
            totals.cache_read_tokens += row.cache_read;
        }
        if row.status == "error" {
            totals.model_error_count += 1;
        }
    }
    totals.model_request_count = rows.len() as i64;
    totals.input_baseline_by_source = baselines;
    Ok(totals)
}

/// One `model_usage` row of the task-usage query, in the SQL column order.
struct TaskRow {
    query_source: String,
    status: String,
    input_tokens: i64,
    output_tokens: i64,
    reasoning_tokens: i64,
    cache_creation: i64,
    cache_read: i64,
    computed_total: i64,
    provider_total: Option<i64>,
}

/// Node `taskUsageInputBaselineSource`.
fn baseline_source(query_source: &str) -> Option<&str> {
    match query_source {
        "main_turn" | "subagent" | "workflow_child" => Some(query_source),
        _ => None,
    }
}

/// Node `inputSideTokensFromStoredUsage`: which part of the row is the request's input
/// side. AI SDK v6 writes `inputTokens` as the total input, so cache columns are only
/// added back when they explain the provider's total better.
fn input_side_tokens(row: &TaskRow) -> i64 {
    let input = row.input_tokens.max(0);
    let cache = row.cache_creation.max(0) + row.cache_read.max(0);
    if input <= 0 {
        return cache;
    }
    if cache <= 0 {
        return input;
    }
    let output = row.output_tokens.max(0);
    let total = row.provider_total.unwrap_or(row.computed_total).max(0);
    if total > 0 {
        let total_input_distance = (total - (input + output)).abs();
        let no_cache_input_distance = (total - (input + cache + output)).abs();
        if no_cache_input_distance < total_input_distance {
            return input + cache;
        }
    }
    input
}

/// `query_map` + collect, with the rusqlite error carried as [`StoreError::Storage`].
pub(crate) fn query_all<T, F, P>(
    conn: &Connection,
    sql: &str,
    params: P,
    map: F,
) -> Result<Vec<T>, StoreError>
where
    P: rusqlite::Params,
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
{
    let mut statement = conn.prepare(sql).storage()?;
    let rows = statement.query_map(params, map).storage()?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.storage()?);
    }
    Ok(out)
}

#[cfg(test)]
#[path = "usage_v4_tests.rs"]
mod tests;
