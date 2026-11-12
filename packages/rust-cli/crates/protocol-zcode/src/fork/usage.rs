//! Fork: the App's usage surfaces (Node `V4Gateway.usageStats` / `conversationUsage` →
//! `getUsageStats` / `getTaskTokenUsage` → `runUsageStats`; specs/fork-rust-agent-parity.md).
//!
//! `v4/usage/stats` plans the query span (preset rolling ranges keep Node's exact legacy
//! arithmetic; a `window` selects whole local calendar days), reads the aggregated rows
//! through `Kernel::queries` and composes the snapshot (Node `usage-stats-builder`).
//! `v4/conversation/usage` is Node's `queryTaskUsage` fold surfaced as-is. The store owns
//! Node's `queryAppUsageWithRollup` rules (rollup first, raw tables only as a fallback, and
//! `usage_rollup_unavailable` when neither can answer correctly); this layer only maps that
//! error and logs a fallback.

use std::collections::{BTreeMap, HashMap};

use rust_cli_base::civil::{days_from_civil, days_in_month, format_date};
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::KernelError;
use rust_cli_kernel_api::store::{
    AppUsageDayRow, AppUsageFilters, AppUsageRows, AppUsageSpan, StoreError, StoreQueries,
    TaskUsageTotals, USAGE_ROLLUP_UNAVAILABLE,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Map, Value, json};

use crate::server::{Server, kernel_error};

/// Node keeps one `DAY_MS` per file; the planner, span math and day math must agree.
const DAY_MS: i64 = 86_400_000;
/// Node `APP_USAGE_MAX_WINDOW_DAYS`.
const MAX_WINDOW_DAYS: i64 = 800;
/// Node `appUsageFilterValuesSchema`: at most 50 values of at most 1024 characters each.
const MAX_FILTER_ITEMS: usize = 50;
const MAX_FILTER_CHARS: usize = 1024;

/// Node's zod failure carries a field-level detail after the dash; the code (-32602) is the
/// contract, the text mirrors Node's readable summary.
fn invalid(detail: impl std::fmt::Display) -> RpcError {
    RpcError::invalid_params(format!("Invalid params — {detail}"))
}

/// An inclusive local-day window (`appUsageWindowSchema`), already parsed to day indexes.
struct WindowDays {
    from_day: i64,
    to_day: i64,
}

/// `appUsageFiltersSchema`: four optional value lists; a non-empty one needs the rollup.
type Filters = AppUsageFilters;

/// `v4UsageStatsParamsSchema` after validation.
struct StatsParams {
    range: &'static str,
    time_zone: Option<String>,
    window: Option<WindowDays>,
    compare: bool,
    filters: Filters,
    include_hourly: bool,
    include_sessions: bool,
}

/// One query span (Node `UsageQuerySpan`).
struct Span {
    since: i64,
    until: i64,
    /// Set only for explicit custom windows (first local day index).
    window_start_day_index: Option<i64>,
    window: Option<WindowDays>,
}

/// Node `UsageQueryPlan`: the current span plus the optional preceding comparison span.
struct Plan {
    time_zone: String,
    tz_offset_ms: i64,
    span: Span,
    previous: Option<Span>,
}

/// Options for the snapshot builder (Node `BuildAppUsageOptions`).
struct SnapshotOptions<'a> {
    range: &'a str,
    time_zone: &'a str,
    tz_offset_ms: i64,
    generated_at: i64,
    since: i64,
    until: i64,
    window_start_day_index: Option<i64>,
}

/// Node `resolveTzOffsetMs` resolves any IANA zone via `Intl`. This workspace has no
/// time-zone database crate, so: the agent's own zone resolves through the injected clock
/// (DST-correct for the common case, where the App's zone equals the machine zone),
/// UTC/GMT and `Etc/GMT±N` fixed-offset zones resolve arithmetically (IANA keeps the POSIX
/// sign inversion), and any other name resolves to 0 like Node's catch branch. The
/// divergence (non-local IANA zones bucket as UTC days) is recorded in the patch notes.
fn tz_offset_ms(clock: &dyn Clock, zone: &str, at_ms: u64) -> i64 {
    let minutes: i32 = if zone.is_empty()
        || zone.eq_ignore_ascii_case("UTC")
        || zone.eq_ignore_ascii_case("GMT")
    {
        0
    } else if let Some(minutes) = etc_gmt_offset_minutes(zone) {
        minutes
    } else if zone == clock.time_zone() {
        clock.utc_offset_minutes(at_ms)
    } else {
        tracing::warn!(
            event = "usage.stats.tz.unresolved",
            "no time-zone database in this build; usage days fall back to UTC"
        );
        0
    };
    i64::from(minutes) * 60_000
}

/// `Etc/GMT` (0), `Etc/GMT-8` (UTC+8), `Etc/GMT+5` (UTC-5): the only zones decodable
/// without a tz database.
fn etc_gmt_offset_minutes(zone: &str) -> Option<i32> {
    let rest = zone.strip_prefix("Etc/GMT")?;
    if rest.is_empty() {
        return Some(0);
    }
    let (sign, digits) = match rest.as_bytes().first() {
        Some(b'+') => (-1_i32, &rest[1..]),
        Some(b'-') => (1_i32, &rest[1..]),
        _ => return None,
    };
    let (hours, minutes) = match digits.split_once(':') {
        Some((hours, minutes)) => (hours.parse::<i32>().ok()?, minutes.parse::<i32>().ok()?),
        None => (digits.parse::<i32>().ok()?, 0),
    };
    Some(sign * (hours * 60 + minutes))
}

/// A strict real calendar date `YYYY-MM-DD` (zod's round-trip check): `civil::parse_date`
/// accepts day 31 in every month, so the month length is checked here.
fn calendar_day(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let text = value.get(range)?;
        if !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        text.parse().ok()
    };
    let year = digits(0..4)? as i64;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    Some(days_from_civil(year, month, day))
}

/// `v4UsageStatsParamsSchema` (strict): manual validation keeps zod's exact semantics —
/// unknown keys and `null` for optional fields are errors, and `window` carries its
/// cross-field rules with Node's messages.
fn usage_stats_params(params: &Value) -> Result<StatsParams, RpcError> {
    let Some(object) = params.as_object() else {
        return Err(invalid("expected an object"));
    };
    const ALLOWED: [&str; 6] = [
        "range", "timeZone", "window", "compare", "filters", "include",
    ];
    if let Some(key) = object.keys().find(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(invalid(format!("Unrecognized key '{key}'")));
    }

    let range: &'static str = match object.get("range").and_then(Value::as_str) {
        Some("all") => "all",
        Some("7d") => "7d",
        Some("30d") => "30d",
        _ => return Err(invalid("range: expected one of \"all\", \"7d\", \"30d\"")),
    };

    let time_zone = match object.get("timeZone") {
        None => None,
        Some(value) => Some(
            value
                .as_str()
                .ok_or_else(|| invalid("timeZone: expected a string"))?
                .to_owned(),
        ),
    };

    let window = match object.get("window") {
        None => None,
        Some(value) => Some(window_days(value)?),
    };

    let compare = match object.get("compare") {
        None => false,
        Some(value) => value
            .as_bool()
            .ok_or_else(|| invalid("compare: expected a boolean"))?,
    };

    let filters = match object.get("filters") {
        None => Filters::default(),
        Some(value) => filters_value(value)?,
    };

    let (mut include_hourly, mut include_sessions) = (false, false);
    if let Some(value) = object.get("include") {
        let Some(items) = value.as_array() else {
            return Err(invalid("include: expected \"hourly\" or \"sessions\""));
        };
        if items.len() > 2 {
            return Err(invalid("include: at most 2 values"));
        }
        for item in items {
            match item.as_str() {
                Some("hourly") => include_hourly = true,
                Some("sessions") => include_sessions = true,
                _ => return Err(invalid("include: expected \"hourly\" or \"sessions\"")),
            }
        }
    }

    Ok(StatsParams {
        range,
        time_zone,
        window,
        compare,
        filters,
        include_hourly,
        include_sessions,
    })
}

/// `appUsageWindowSchema` (strict) with its two cross-field rules.
fn window_days(value: &Value) -> Result<WindowDays, RpcError> {
    let Some(object) = value.as_object() else {
        return Err(invalid("window: expected an object"));
    };
    if let Some(key) = object.keys().find(|key| *key != "from" && *key != "to") {
        return Err(invalid(format!("Unrecognized key 'window.{key}'")));
    }
    let from_day = object
        .get("from")
        .and_then(Value::as_str)
        .and_then(calendar_day)
        .ok_or_else(|| invalid("window.from: expected a real calendar date as YYYY-MM-DD"))?;
    let to_day = object
        .get("to")
        .and_then(Value::as_str)
        .and_then(calendar_day)
        .ok_or_else(|| invalid("window.to: expected a real calendar date as YYYY-MM-DD"))?;
    if from_day > to_day {
        return Err(invalid("window.from must not be after window.to"));
    }
    if to_day - from_day + 1 > MAX_WINDOW_DAYS {
        return Err(invalid(format!(
            "window must span at most {MAX_WINDOW_DAYS} days"
        )));
    }
    Ok(WindowDays { from_day, to_day })
}

/// `appUsageFiltersSchema` (strict).
fn filters_value(value: &Value) -> Result<Filters, RpcError> {
    let Some(object) = value.as_object() else {
        return Err(invalid("filters: expected an object"));
    };
    const ALLOWED: [&str; 4] = ["modelIds", "providerIds", "querySources", "workspaceKeys"];
    if let Some(key) = object.keys().find(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(invalid(format!("Unrecognized key 'filters.{key}'")));
    }
    let list = |key: &str| -> Result<Vec<String>, RpcError> {
        let Some(value) = object.get(key) else {
            return Ok(Vec::new());
        };
        let Some(items) = value.as_array() else {
            return Err(invalid(format!("{key}: expected an array of strings")));
        };
        if items.len() > MAX_FILTER_ITEMS {
            return Err(invalid(format!("{key}: at most {MAX_FILTER_ITEMS} values")));
        }
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let Some(text) = item.as_str() else {
                return Err(invalid(format!("{key}: expected an array of strings")));
            };
            if text.chars().count() > MAX_FILTER_CHARS {
                return Err(invalid(format!(
                    "{key}: values must be at most 1024 characters"
                )));
            }
            out.push(text.to_owned());
        }
        Ok(out)
    };
    Ok(Filters {
        model_ids: list("modelIds")?,
        provider_ids: list("providerIds")?,
        query_sources: list("querySources")?,
        workspace_keys: list("workspaceKeys")?,
    })
}

/// `v4ConversationUsageParamsSchema` (strict).
fn conversation_usage_params(params: &Value) -> Result<String, RpcError> {
    let Some(object) = params.as_object() else {
        return Err(invalid("expected an object"));
    };
    if let Some(key) = object.keys().find(|key| *key != "sessionId") {
        return Err(invalid(format!("Unrecognized key '{key}'")));
    }
    object
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|session| !session.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid("sessionId: expected a non-empty string"))
}

/// Local-midnight-treated-as-UTC day range to the instant range `[start, end]` for the
/// caller's offset (Node `spanForDays`).
fn span_for_days(first_day_index: i64, last_day_index: i64, tz_offset_ms: i64) -> Span {
    Span {
        since: first_day_index * DAY_MS - tz_offset_ms,
        until: (last_day_index + 1) * DAY_MS - tz_offset_ms - 1,
        window_start_day_index: Some(first_day_index),
        window: Some(WindowDays {
            from_day: first_day_index,
            to_day: last_day_index,
        }),
    }
}

/// Node `planUsageQuery`: default requests (no `window`) keep the exact legacy
/// rolling-range arithmetic; a `window` selects whole local days. `compare` adds the
/// immediately preceding span of equal length and is ignored for the all-time range.
fn plan_usage_query(clock: &dyn Clock, params: &StatsParams, now_ms: u64) -> Plan {
    let time_zone = params.time_zone.clone().unwrap_or_else(|| "UTC".to_owned());
    let tz_offset_ms = tz_offset_ms(clock, &time_zone, now_ms);
    let now = i64::try_from(now_ms).unwrap_or(i64::MAX);

    if let Some(window) = &params.window {
        let length = window.to_day - window.from_day + 1;
        let span = span_for_days(window.from_day, window.to_day, tz_offset_ms);
        let previous = params
            .compare
            .then(|| span_for_days(window.from_day - length, window.from_day - 1, tz_offset_ms));
        return Plan {
            time_zone,
            tz_offset_ms,
            span,
            previous,
        };
    }

    let range_days = match params.range {
        "7d" => 7,
        "30d" => 30,
        // "all": whatever the raw tables still hold.
        _ => {
            return Plan {
                time_zone,
                tz_offset_ms,
                span: Span {
                    since: 0,
                    until: now,
                    window_start_day_index: None,
                    window: None,
                },
                previous: None,
            };
        }
    };
    let since = now - range_days * DAY_MS;
    let previous = params.compare.then(|| Span {
        since: since - range_days * DAY_MS,
        until: since - 1,
        window_start_day_index: None,
        window: None,
    });
    Plan {
        time_zone,
        tz_offset_ms,
        span: Span {
            since,
            until: now,
            window_start_day_index: None,
            window: None,
        },
        previous,
    }
}

/// Local calendar window covered by a span, for labeling the previous period (Node
/// `describeSpanWindow`).
fn describe_span_window(span: &Span, tz_offset_ms: i64) -> Value {
    let (from_day, to_day) = span.window.as_ref().map_or_else(
        || {
            (
                (span.since + tz_offset_ms).div_euclid(DAY_MS),
                (span.until + tz_offset_ms).div_euclid(DAY_MS),
            )
        },
        |window| (window.from_day, window.to_day),
    );
    json!({"from": format_date(from_day), "to": format_date(to_day)})
}

/// Heatmap intensity (Node `levelFor`): quartiles of the busiest day.
fn level_for(tokens: i64, max: i64) -> i64 {
    if tokens <= 0 || max <= 0 {
        return 0;
    }
    let ratio = tokens as f64 / max as f64;
    if ratio > 0.75 {
        4
    } else if ratio > 0.5 {
        3
    } else if ratio > 0.25 {
        2
    } else {
        1
    }
}

/// A safe ratio (0 when the denominator is 0), like Node's ternaries.
fn rate(numerator: i64, denominator: i64) -> f64 {
    if denominator > 0 {
        numerator as f64 / denominator as f64
    } else {
        0.0
    }
}

/// Node `resolveUsageStartDayIndex`: the window's first day, else the range-derived start,
/// else (all-time) the earliest day with data, falling back to the end day when empty.
fn resolve_start_day_index(rows: &AppUsageRows, opts: &SnapshotOptions, end_day_index: i64) -> i64 {
    if let Some(window_start) = opts.window_start_day_index {
        return window_start;
    }
    if opts.range != "all" {
        return (opts.since + opts.tz_offset_ms).div_euclid(DAY_MS);
    }
    rows.days
        .iter()
        .map(|day| day.day_index)
        .chain(rows.day_models.iter().map(|day| day.day_index))
        .min()
        .unwrap_or(end_day_index)
}

/// Node `buildAppUsageSnapshot`: one `AppUsageSnapshot` value from the aggregated rows.
/// `inputTokens` in the usage database is already total input; the cache fields are only a
/// breakdown, so they do not widen the hit-rate denominator.
fn build_snapshot(rows: &AppUsageRows, opts: &SnapshotOptions) -> Value {
    let totals = &rows.totals;
    let turn_totals = &rows.turn_totals;
    let tool_totals = &rows.tool_totals;

    let cache_denominator = if totals.input_tokens > 0 {
        totals.input_tokens
    } else {
        totals.cache_creation_tokens + totals.cache_read_tokens
    };
    let cache_hit_rate = rate(totals.cache_read_tokens, cache_denominator);
    let model_error_rate = rate(totals.model_error_count, totals.model_request_count);
    let tool_error_rate = rate(tool_totals.tool_error_count, tool_totals.tool_call_count);

    let day_tokens: HashMap<i64, &AppUsageDayRow> =
        rows.days.iter().map(|day| (day.day_index, day)).collect();
    let end_day_index = (opts.until + opts.tz_offset_ms).div_euclid(DAY_MS);
    let start_day_index = resolve_start_day_index(rows, opts, end_day_index);

    // Walk backwards for activeDays / current streak / longest streak.
    let (mut active_days, mut current_streak_days, mut longest_streak_days) = (0_i64, 0_i64, 0_i64);
    let (mut running_streak_days, mut streak_broken) = (0_i64, false);
    for day_index in (start_day_index..=end_day_index).rev() {
        let tokens = day_tokens.get(&day_index).map_or(0, |day| day.total_tokens);
        if tokens > 0 {
            active_days += 1;
            running_streak_days += 1;
            longest_streak_days = longest_streak_days.max(running_streak_days);
            if !streak_broken {
                current_streak_days += 1;
            }
        } else if !streak_broken {
            streak_broken = true;
            running_streak_days = 0;
        } else {
            running_streak_days = 0;
        }
    }

    let max_tokens = rows
        .days
        .iter()
        .map(|day| day.total_tokens)
        .max()
        .unwrap_or(0);

    // Heatmap: slice from start to end in seven-day weeks; a trailing partial week is
    // padded with null days.
    let mut weeks: Vec<Value> = Vec::new();
    let mut week: Vec<Value> = Vec::new();
    for day_index in start_day_index..=end_day_index {
        let day = day_tokens.get(&day_index);
        week.push(json!({
            "date": format_date(day_index),
            "level": level_for(day.map_or(0, |day| day.total_tokens), max_tokens),
            "totalTokens": day.map_or(0, |day| day.total_tokens),
            "turnCount": day.map_or(0, |day| day.turn_count),
            "toolCallCount": day.map_or(0, |day| day.tool_call_count),
        }));
        if week.len() == 7 {
            weeks.push(json!({"weekIndex": weeks.len(), "days": week}));
            week = Vec::new();
        }
    }
    if !week.is_empty() {
        week.resize(7, Value::Null);
        weeks.push(json!({"weekIndex": weeks.len(), "days": week}));
    }

    // Trend: aggregate dayModels by day, then emit every day of the span.
    let mut daily_map: BTreeMap<i64, BTreeMap<Option<String>, i64>> = BTreeMap::new();
    for day_model in &rows.day_models {
        *daily_map
            .entry(day_model.day_index)
            .or_default()
            .entry(day_model.model_id.clone())
            .or_insert(0) += day_model.total_tokens;
    }
    let daily_model_usage: Vec<Value> = (start_day_index..=end_day_index)
        .map(|day_index| {
            let models = daily_map.get(&day_index).map_or(Vec::new(), |inner| {
                inner
                    .iter()
                    .map(|(model_id, total_tokens)| {
                        json!({"modelId": model_id, "totalTokens": total_tokens})
                    })
                    .collect()
            });
            json!({"date": format_date(day_index), "models": models})
        })
        .collect();

    // Model ranking + favorite.
    let total_model_tokens: i64 = rows.models.iter().map(|model| model.total_tokens).sum();
    let models: Vec<Value> = rows
        .models
        .iter()
        .map(|model| {
            json!({
                "modelId": model.model_id,
                "totalTokens": model.total_tokens,
                "inputTokens": model.input_tokens,
                "outputTokens": model.output_tokens,
                "requestCount": model.request_count,
                "share": rate(model.total_tokens, total_model_tokens),
            })
        })
        .collect();
    let favorite_model = rows.models.first().map(|model| {
        json!({
            "modelId": model.model_id,
            "totalTokens": model.total_tokens,
            "share": rate(model.total_tokens, total_model_tokens),
        })
    });

    let tools: Vec<Value> = rows
        .tools
        .iter()
        .map(|tool| {
            json!({
                "toolName": tool.tool_name,
                "callCount": tool.call_count,
                "errorCount": tool.error_count,
                "errorRate": rate(tool.error_count, tool.call_count),
                "avgDurationMs": tool.avg_duration_ms,
            })
        })
        .collect();

    json!({
        "range": opts.range,
        "generatedAt": opts.generated_at,
        "timeZone": opts.time_zone,
        "source": "agent-db",
        "summary": {
            "totalTokens": totals.total_tokens,
            "inputTokens": totals.input_tokens,
            "outputTokens": totals.output_tokens,
            "reasoningTokens": totals.reasoning_tokens,
            "cacheCreationTokens": totals.cache_creation_tokens,
            "cacheReadTokens": totals.cache_read_tokens,
            "cacheHitRate": cache_hit_rate,
            "totalSessions": turn_totals.total_sessions,
            "totalTurns": turn_totals.total_turns,
            "toolCallCount": tool_totals.tool_call_count,
            "toolErrorRate": tool_error_rate,
            "modelErrorRate": model_error_rate,
            "avgTimeToFirstTokenMs": totals.avg_time_to_first_token_ms,
            "avgTurnDurationMs": turn_totals.avg_turn_duration_ms,
            "activeDays": active_days,
            "currentStreakDays": current_streak_days,
            "longestSessionMs": turn_totals.longest_session_ms,
            "longestStreakDays": longest_streak_days,
            "peakDayTokens": max_tokens,
            "favoriteModel": favorite_model,
        },
        "heatmap": {
            "startDate": format_date(start_day_index),
            "endDate": format_date(end_day_index),
            "maxTokens": max_tokens,
            "weeks": weeks,
        },
        "dailyModelUsage": daily_model_usage,
        "models": models,
        "tools": tools,
    })
}

/// Node `dailyTokenTotals`: each previous day's model tokens, aligned to the current
/// period's length (pad with zeros, trim the tail).
fn daily_token_totals(previous: &Value, length: usize) -> Vec<i64> {
    let totals: Vec<i64> = previous["dailyModelUsage"]
        .as_array()
        .map_or(Vec::new(), |days| {
            days.iter()
                .map(|day| {
                    day["models"].as_array().map_or(0, |models| {
                        models
                            .iter()
                            .map(|model| model["totalTokens"].as_i64().unwrap_or(0))
                            .sum()
                    })
                })
                .collect()
        });
    (0..length)
        .map(|index| totals.get(index).copied().unwrap_or(0))
        .collect()
}

/// The rollup-only extras attach only when the store returned them (Node: `if (result.facets)`
/// and friends); the raw-table fallback leaves them absent.
fn attach_extras(snapshot: &mut Value, rows: &AppUsageRows) {
    if let Some(facets) = &rows.facets {
        snapshot["facets"] = json!({
            "models": facets.models,
            "providers": facets.providers,
            "querySources": facets.query_sources,
            "workspaces": facets.workspaces,
        });
    }
    if let Some(hourly_tokens) = &rows.hourly_tokens {
        snapshot["hourlyTokens"] = json!(hourly_tokens);
    }
    if let Some(sessions) = &rows.top_sessions {
        snapshot["topSessions"] = Value::Array(
            sessions
                .iter()
                .map(|session| {
                    json!({
                        "sessionId": session.session_id,
                        "title": session.title,
                        "workspaceKey": session.workspace_key,
                        "totalTokens": session.total_tokens,
                        "turnCount": session.turn_count,
                        "durationMs": session.duration_ms,
                    })
                })
                .collect(),
        );
    }
}

/// One span read (Node `queryStore` + `queryAppUsageWithRollup`'s loud-failure rules): a
/// bounded span reaching past the raw retention fails with Node's exact error instead of
/// answering truncated history, a store without the usage query answers empty like Node's
/// missing-store guard, and a raw-table fallback is logged.
#[allow(clippy::too_many_arguments)]
async fn query_span(
    queries: &dyn StoreQueries,
    span: &Span,
    tz_offset_ms: i64,
    filters: &Filters,
    range: &str,
    include_facets: bool,
    hourly: bool,
    top_sessions: bool,
) -> Result<AppUsageRows, RpcError> {
    let input = AppUsageSpan {
        since_ms: span.since,
        until_ms: span.until,
        tz_offset_ms,
        filters: filters.clone(),
        include_facets,
        hourly,
        top_sessions,
    };
    match queries.app_usage(input).await {
        Ok(rows) => {
            if let Some(reason) = &rows.rollup_fallback_reason {
                // The raw tables only hold ~30 days; make a persistently missing rollup
                // visible in the logs, like Node's warn.
                tracing::warn!(
                    event = "usage.stats.rollupFallback",
                    reason = reason.as_str(),
                    range,
                    "App Usage rollup unavailable, answered from raw usage tables"
                );
            }
            Ok(rows)
        }
        Err(StoreError::Unsupported { .. }) => Ok(AppUsageRows::default()),
        // Node `queryAppUsageWithRollup`: neither the rollup nor the raw tables can answer this
        // read correctly (filters, history past the raw retention, detached usage state).
        Err(StoreError::Storage { message }) if message == USAGE_ROLLUP_UNAVAILABLE => {
            Err(RpcError::internal(USAGE_ROLLUP_UNAVAILABLE))
        }
        Err(error) => Err(kernel_error(&KernelError::from(error))),
    }
}

/// `v4/usage/stats` (`v4UsageStatsParamsSchema` → `AppUsageSnapshot`).
pub(crate) async fn usage_stats(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let parsed = usage_stats_params(params)?;
    let now_ms = server.context.now();
    let now = i64::try_from(now_ms).unwrap_or(i64::MAX);
    let plan = plan_usage_query(server.context.clock.as_ref(), &parsed, now_ms);
    let queries = server.kernel.queries();

    // Facet options are only needed alongside the lifetime snapshot, which feeds the
    // filter menus; include extras apply to the main span only.
    let wants_facets = parsed.range == "all" && parsed.window.is_none();
    let rows = query_span(
        queries.as_ref(),
        &plan.span,
        plan.tz_offset_ms,
        &parsed.filters,
        parsed.range,
        wants_facets,
        parsed.include_hourly,
        parsed.include_sessions,
    )
    .await?;
    let options = |span: &Span| SnapshotOptions {
        range: parsed.range,
        time_zone: &plan.time_zone,
        tz_offset_ms: plan.tz_offset_ms,
        generated_at: now,
        since: span.since,
        until: span.until,
        window_start_day_index: span.window_start_day_index,
    };
    let mut snapshot = build_snapshot(&rows, &options(&plan.span));
    attach_extras(&mut snapshot, &rows);

    if plan.span.window.is_none() && plan.previous.is_none() {
        return Ok(snapshot);
    }

    let previous = match &plan.previous {
        Some(span) => {
            let rows = query_span(
                queries.as_ref(),
                span,
                plan.tz_offset_ms,
                &parsed.filters,
                parsed.range,
                false,
                false,
                false,
            )
            .await?;
            Some(build_snapshot(&rows, &options(span)))
        }
        None => None,
    };
    if let Some(window) = &plan.span.window {
        snapshot["window"] = json!({
            "from": format_date(window.from_day),
            "to": format_date(window.to_day),
        });
    }
    if let (Some(span), Some(previous)) = (&plan.previous, &previous) {
        snapshot["previous"] = json!({
            "window": describe_span_window(span, plan.tz_offset_ms),
            "summary": previous["summary"].clone(),
            "dailyTokens": daily_token_totals(
                previous,
                snapshot["dailyModelUsage"]
                    .as_array()
                    .map_or(0, Vec::len),
            ),
        });
    }
    Ok(snapshot)
}

/// `v4/conversation/usage` (`v4ConversationUsageResultSchema`).
pub(crate) async fn conversation_usage(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let session = conversation_usage_params(params)?;
    let totals = match server
        .kernel
        .queries()
        .task_usage(&SessionId::new(&session))
        .await
    {
        Ok(totals) => totals,
        // A store without the task-usage query answers all zeros, like Node's
        // missing-usageStore guard.
        Err(StoreError::Unsupported { .. }) => TaskUsageTotals::default(),
        Err(error) => return Err(kernel_error(&KernelError::from(error))),
    };
    let mut baselines = Map::new();
    for (source, value) in &totals.input_baseline_by_source {
        baselines.insert(source.clone(), json!(value));
    }
    Ok(json!({
        "sessionId": session,
        "totalTokens": totals.total_tokens,
        "inputTokens": totals.input_tokens,
        "outputTokens": totals.output_tokens,
        "reasoningTokens": totals.reasoning_tokens,
        "cacheCreationTokens": totals.cache_creation_tokens,
        "cacheReadTokens": totals.cache_read_tokens,
        "modelRequestCount": totals.model_request_count,
        "modelErrorCount": totals.model_error_count,
        "inputBaselineBySource": Value::Object(baselines),
    }))
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;
