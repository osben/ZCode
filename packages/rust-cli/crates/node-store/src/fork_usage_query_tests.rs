//! `fork_usage_query` 的读路径：rollup 优先并在读取前重算、过滤器收窄、超原始保留期的窗口
//! 由 rollup 回答、分离态 / 过滤 / 超期窗口下的强制失败按 `usage_rollup_unavailable` 拒绝、
//! 无过滤窗口失败时回退原始表并携带原因（Node `queryAppUsageWithRollup` 的行为）。

use rust_cli_base::civil::days_from_civil;
use rust_cli_kernel_api::store::{
    AppUsageFilters, AppUsageSpan, StoreError, USAGE_ROLLUP_UNAVAILABLE,
};

use super::query_with_rollup;
use crate::fork_usage_rollup::ensure_detached_schema;
use crate::repo::usage::{ModelRow, ToolRow, TurnRow};

const DAY_MS: i64 = 86_400_000;
const HOUR_MS: i64 = 3_600_000;

/// A fixed "now" (2026-11-08 UTC): every read recomputes with it, so the prune window and the
/// 30-day raw-retention check are deterministic (rows must stay within the two-year retention).
fn now() -> i64 {
    days_from_civil(2026, 11, 8) * DAY_MS
}

fn day(year: i64, month: u32, day: u32) -> i64 {
    days_from_civil(year, month, day) * DAY_MS
}

/// An empty migrated database; the usage tables reference `session(id)`, so seed the two
/// workspaces the cases write rows for.
fn empty() -> (tempfile::TempDir, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    let (conn, _) = crate::repo::open::open(
        &dir.path().join("db.sqlite"),
        crate::repo::open::MIGRATION_LOCK_WAIT,
        1,
    )
    .unwrap();
    for (id, directory, title) in [("s1", "/w1", "Alpha"), ("s2", "/w2", "Beta")] {
        conn.execute(
            "insert into session (id, project_id, slug, directory, path, title, version,
               time_created, time_updated)
             values (?, 'proj_x', ?, ?, ?, ?, '0.1.0', 1000, 1000)",
            rusqlite::params![id, id, directory, directory, title],
        )
        .unwrap();
    }
    (dir, conn)
}

/// A completed request row; individual columns are overridden per case.
fn model_row(id: &str, session: &str, model: &str, started_at: i64) -> ModelRow {
    ModelRow {
        id: id.to_owned(),
        logical_request_id: format!("{id}-logical"),
        session_id: session.to_owned(),
        query_source: "main_turn".to_owned(),
        provider_id: "provider".to_owned(),
        model_id: model.to_owned(),
        status: "completed",
        started_at,
        input_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        computed_total_tokens: 0,
        ..ModelRow::default()
    }
}

fn turn_row(session: &str, turn: &str, status: &'static str, started_at: i64) -> TurnRow {
    TurnRow {
        session_id: session.to_owned(),
        turn_id: turn.to_owned(),
        status,
        started_at,
        duration_ms: Some(1_000),
        computed_total_tokens: 0,
        ..TurnRow::default()
    }
}

fn tool_row(id: &str, session: &str, name: &str, started_at: i64, status: &'static str) -> ToolRow {
    ToolRow {
        id: id.to_owned(),
        session_id: session.to_owned(),
        tool_call_id: format!("{id}-call"),
        tool_name: name.to_owned(),
        status,
        started_at,
        duration_ms: Some(100),
        ..ToolRow::default()
    }
}

fn span(since: i64, until: i64) -> AppUsageSpan {
    AppUsageSpan {
        since_ms: since,
        until_ms: until,
        tz_offset_ms: 0,
        filters: AppUsageFilters::default(),
        include_facets: false,
        hourly: false,
        top_sessions: false,
    }
}

/// Seeds both workspaces at `at`: model a (500 tokens, s1), model b (300 tokens, error, s2),
/// one completed and one running turn, one tool call each.
fn seed_two_workspaces(conn: &rusqlite::Connection, at: i64) {
    let mut m1 = model_row("m1", "s1", "a", at);
    m1.input_tokens = 300;
    m1.output_tokens = 200;
    m1.computed_total_tokens = 500;
    m1.time_to_first_token_ms = Some(100);
    let mut m2 = model_row("m2", "s2", "b", at + 60_000);
    m2.input_tokens = 100;
    m2.output_tokens = 200;
    m2.computed_total_tokens = 300;
    m2.status = "error";
    m2.time_to_first_token_ms = Some(300);
    for row in [&m1, &m2] {
        crate::repo::usage::record_model(conn, row).unwrap();
    }
    let mut t1 = turn_row("s1", "t1", "completed", at);
    t1.computed_total_tokens = 500;
    let mut t2 = turn_row("s2", "t2", "running", at + 5_000);
    t2.duration_ms = None;
    t2.computed_total_tokens = 300;
    for row in [&t1, &t2] {
        crate::repo::usage::upsert_turn(conn, row).unwrap();
    }
    crate::repo::usage::upsert_tool(conn, &tool_row("x1", "s1", "Read", at, "completed")).unwrap();
    crate::repo::usage::upsert_tool(conn, &tool_row("x2", "s2", "Bash", at + 10_000, "error"))
        .unwrap();
}

/// The rollup answers after its read recompute and matches the raw-table aggregation.
#[test]
fn rollup_answers_after_recompute_and_matches_the_raw_tables() {
    let (_dir, conn) = empty();
    let at = day(2026, 11, 7) + 10 * HOUR_MS;
    seed_two_workspaces(&conn, at);

    let window = span(at - HOUR_MS, at + HOUR_MS);
    let rolled = query_with_rollup(&conn, &window, now() as u64).unwrap();
    assert!(rolled.rollup_fallback_reason.is_none());

    let raw = crate::usage_v4::app_usage(&conn, &window).unwrap();
    assert_eq!(rolled.totals, raw.totals);
    assert_eq!(rolled.turn_totals, raw.turn_totals);
    assert_eq!(rolled.tool_totals, raw.tool_totals);
    assert_eq!(rolled.models, raw.models);
    assert_eq!(rolled.tools, raw.tools);
    assert_eq!(rolled.days, raw.days);
    assert_eq!(rolled.day_models, raw.day_models);

    assert_eq!(rolled.totals.total_tokens, 800);
    assert_eq!(rolled.totals.model_request_count, 2);
    assert_eq!(rolled.totals.model_error_count, 1);
    assert_eq!(rolled.totals.avg_time_to_first_token_ms, Some(200.0));
    assert_eq!(rolled.turn_totals.total_sessions, 2);
    assert_eq!(rolled.turn_totals.total_turns, 2);
    assert_eq!(rolled.turn_totals.longest_session_ms, 1_000);
}

/// Model and workspace filters narrow the rollup answer (only the rollup can answer them).
#[test]
fn filters_narrow_the_rollup_answer() {
    let (_dir, conn) = empty();
    let at = day(2026, 11, 7) + 10 * HOUR_MS;
    seed_two_workspaces(&conn, at);

    let mut by_model = span(at - HOUR_MS, at + HOUR_MS);
    by_model.filters.model_ids = vec!["a".to_owned()];
    let rows = query_with_rollup(&conn, &by_model, now() as u64).unwrap();
    assert!(rows.rollup_fallback_reason.is_none());
    assert_eq!(rows.totals.total_tokens, 500);
    assert_eq!(rows.models.len(), 1);
    assert_eq!(rows.models[0].model_id.as_deref(), Some("a"));
    // Node `buildWhere`: model filters apply to the bucket scope only, so the turn view (the
    // workspace scope) still counts both sessions.
    assert_eq!(rows.turn_totals.total_sessions, 2);

    let mut by_workspace = span(at - HOUR_MS, at + HOUR_MS);
    by_workspace.filters.workspace_keys = vec!["/w2".to_owned()];
    let rows = query_with_rollup(&conn, &by_workspace, now() as u64).unwrap();
    assert!(rows.rollup_fallback_reason.is_none());
    assert_eq!(rows.totals.total_tokens, 300);
    assert_eq!(rows.models[0].model_id.as_deref(), Some("b"));
    assert_eq!(rows.tool_totals.tool_call_count, 1);
}

/// A bounded window past the 30-day raw retention stays answerable from the rollup (the raw
/// fallback would be refused loudly instead).
#[test]
fn windows_past_raw_retention_answer_from_the_rollup() {
    let (_dir, conn) = empty();
    let at = now() - 40 * DAY_MS;
    let mut row = model_row("old", "s1", "a", at);
    row.input_tokens = 400;
    row.output_tokens = 100;
    row.computed_total_tokens = 500;
    crate::repo::usage::record_model(&conn, &row).unwrap();

    let rows = query_with_rollup(
        &conn,
        &span(now() - 45 * DAY_MS, now() - 35 * DAY_MS),
        now() as u64,
    )
    .unwrap();
    assert!(rows.rollup_fallback_reason.is_none());
    assert_eq!(rows.totals.total_tokens, 500);
    assert_eq!(rows.totals.model_request_count, 1);
}

/// Detached usage state plus a forced recompute failure fails loudly: the raw tables would
/// under-count erased sessions. Filters do the same even without detached state, while an
/// unfiltered recent window falls back to the raw tables carrying the failure reason.
#[test]
fn forced_failures_fail_loudly_or_fall_back_with_a_reason() {
    let t = now();
    let n = t as u64;

    // Detached state (a protected bucket) + a recompute skipped by the surrounding transaction.
    let (_dir, conn) = empty();
    ensure_detached_schema(&conn, n).unwrap();
    conn.execute(
        "insert into fork_usage_protected_bucket (kind, bucket_start, workspace_key)
         values ('model', 0, '/w')",
        [],
    )
    .unwrap();
    conn.execute_batch("begin immediate").unwrap();
    let error = query_with_rollup(&conn, &span(t - 7 * DAY_MS, t), n).unwrap_err();
    let StoreError::Storage { message } = error else {
        panic!("expected usage_rollup_unavailable, got {error:?}")
    };
    assert_eq!(message, USAGE_ROLLUP_UNAVAILABLE);

    // Active filters + the same forced failure: the raw fallback would ignore them.
    let (_dir, conn) = empty();
    conn.execute_batch("begin immediate").unwrap();
    let mut filtered = span(t - 7 * DAY_MS, t);
    filtered.filters.model_ids = vec!["a".to_owned()];
    let error = query_with_rollup(&conn, &filtered, n).unwrap_err();
    let StoreError::Storage { message } = error else {
        panic!("expected usage_rollup_unavailable, got {error:?}")
    };
    assert_eq!(message, USAGE_ROLLUP_UNAVAILABLE);

    // No filters, recent window: the raw tables answer, stamped with the failure reason.
    let (_dir, conn) = empty();
    let at = day(2026, 11, 7) + 10 * HOUR_MS;
    seed_two_workspaces(&conn, at);
    conn.execute_batch("begin immediate").unwrap();
    let rows = query_with_rollup(&conn, &span(at - HOUR_MS, at + HOUR_MS), n).unwrap();
    assert_eq!(
        rows.rollup_fallback_reason.as_deref(),
        Some("database_in_transaction")
    );
    assert_eq!(rows.totals.total_tokens, 800);
    assert!(rows.facets.is_none());
}

/// The rollup-only extras: facets ignore the active filters, the hourly grid is a 7x24 cell
/// array indexed by weekday*24+hour, and top sessions join the live session titles.
#[test]
fn facets_hourly_and_top_sessions_match_the_node_shapes() {
    let (_dir, conn) = empty();
    let at = day(2026, 11, 3) + 10 * HOUR_MS + 30 * 60_000; // 10:30 UTC, on the 15-minute grid
    seed_two_workspaces(&conn, at);

    let mut full = span(day(2026, 11, 3), day(2026, 11, 4));
    full.include_facets = true;
    full.hourly = true;
    full.top_sessions = true;
    // Facets deliberately ignore the active filters so choices never vanish.
    full.filters.model_ids = vec!["a".to_owned()];
    let rows = query_with_rollup(&conn, &full, now() as u64).unwrap();

    let facets = rows.facets.as_ref().unwrap();
    assert_eq!(facets.models, vec!["a".to_owned(), "b".to_owned()]);
    assert_eq!(facets.providers, vec!["provider".to_owned()]);
    assert_eq!(facets.query_sources, vec!["main_turn".to_owned()]);
    assert_eq!(facets.workspaces, vec!["/w1".to_owned(), "/w2".to_owned()]);

    let cells = rows.hourly_tokens.as_ref().unwrap();
    assert_eq!(cells.len(), 7 * 24);
    let weekday = (at / DAY_MS + 4) % 7;
    let hour = (at % DAY_MS) / HOUR_MS;
    // The hourly grid uses the bucket scope, so it follows the active model filter (500),
    // unlike the facets above.
    assert_eq!(cells[(weekday * 24 + hour) as usize], 500);
    assert_eq!(cells.iter().sum::<i64>(), 500);

    let top = rows.top_sessions.as_ref().unwrap();
    assert_eq!(top.len(), 2);
    assert_eq!(top[0].session_id, "s1");
    assert_eq!(top[0].title.as_deref(), Some("Alpha"));
    assert_eq!(top[0].workspace_key, "/w1");
    assert_eq!(top[0].total_tokens, 500);
    assert_eq!(top[0].turn_count, 1);
    assert_eq!(top[0].duration_ms, 1_000);
    assert_eq!(top[1].session_id, "s2");
    assert_eq!(top[1].total_tokens, 300);
}
