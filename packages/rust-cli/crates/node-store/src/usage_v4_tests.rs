//! `usage_v4` 的 SQL：跨会话聚合、按本地日分桶、任务用量按来源增量累计（Node
//! `queryAppUsage` / `queryTaskUsage` 的行级行为；快照组装在协议层测试）。

use rust_cli_base::civil::days_from_civil;
use rust_cli_kernel_api::store::AppUsageSpan;

use super::{app_usage, task_usage};
use crate::repo::usage::{ModelRow, ToolRow, TurnRow};

/// 一天的毫秒数（与被测 SQL 绑定的 DAY_MS 相同）。
const DAY_MS: i64 = 86_400_000;

/// 一个空库（迁移齐全）。
fn empty() -> (tempfile::TempDir, rusqlite::Connection) {
    let dir = tempfile::tempdir().unwrap();
    let (conn, _) = crate::repo::open::open(
        &dir.path().join("db.sqlite"),
        crate::repo::open::MIGRATION_LOCK_WAIT,
        1,
    )
    .unwrap();
    // The usage tables reference `session(id)`: seed the sessions the cases write rows for.
    for id in ["s1", "s2"] {
        conn.execute(
            "insert into session (id, project_id, slug, directory, path, title, version,
               time_created, time_updated)
             values (?, 'proj_x', ?, '/w', '/w', ?, '0.1.0', 1000, 1000)",
            rusqlite::params![id, id, id],
        )
        .unwrap();
    }
    (dir, conn)
}

/// `day(y, m, d)` 那天的 0 点（UTC 毫秒）。
fn day(year: i64, month: u32, day: u32) -> i64 {
    days_from_civil(year, month, day) * DAY_MS
}

/// 一条完成的请求行；个别列在用例里改写。
fn model_row(id: &str, session: &str, source: &str, model: &str, started_at: i64) -> ModelRow {
    ModelRow {
        id: id.to_owned(),
        logical_request_id: format!("{id}-logical"),
        session_id: session.to_owned(),
        query_source: source.to_owned(),
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

fn span(since: i64, until: i64, tz_offset_ms: i64) -> AppUsageSpan {
    AppUsageSpan {
        since_ms: since,
        until_ms: until,
        tz_offset_ms,
        filters: Default::default(),
        include_facets: false,
        hourly: false,
        top_sessions: false,
    }
}

/// 聚合与本地日分桶：总数、模型 / 工具排序、天数与日模型、原始读必带回退原因。
#[test]
fn app_usage_aggregates_the_span_into_local_days() {
    let (_dir, conn) = empty();
    let d0 = day(2026, 7, 1);
    let d1 = day(2026, 7, 2);

    let mut m1 = model_row("m1", "s1", "main_turn", "a", d0 + 1_000);
    m1.input_tokens = 300;
    m1.output_tokens = 200;
    m1.computed_total_tokens = 500;
    m1.time_to_first_token_ms = Some(100);
    let mut m2 = model_row("m2", "s1", "main_turn", "a", d0 + 2_000);
    m2.input_tokens = 100;
    m2.output_tokens = 200;
    m2.computed_total_tokens = 300;
    m2.status = "error";
    let mut m3 = model_row("m3", "s2", "main_turn", "b", d1 + 5_000);
    m3.input_tokens = 50;
    m3.output_tokens = 150;
    m3.computed_total_tokens = 200;
    m3.time_to_first_token_ms = Some(200);
    for row in [&m1, &m2, &m3] {
        crate::repo::usage::record_model(&conn, row).unwrap();
    }

    let t1 = TurnRow {
        session_id: "s1".to_owned(),
        turn_id: "t1".to_owned(),
        status: "completed",
        started_at: d0,
        duration_ms: Some(1_000),
        ..TurnRow::default()
    };
    let t2 = TurnRow {
        session_id: "s1".to_owned(),
        turn_id: "t2".to_owned(),
        status: "completed",
        started_at: d0 + 10,
        duration_ms: Some(500),
        ..TurnRow::default()
    };
    let t3 = TurnRow {
        session_id: "s2".to_owned(),
        turn_id: "t3".to_owned(),
        status: "running",
        started_at: d1,
        duration_ms: None,
        ..TurnRow::default()
    };
    for row in [&t1, &t2, &t3] {
        crate::repo::usage::upsert_turn(&conn, row).unwrap();
    }

    let tool =
        |id: &str, session: &str, name: &str, at: i64, status: &'static str, ms: i64| ToolRow {
            id: id.to_owned(),
            session_id: session.to_owned(),
            tool_call_id: format!("{id}-call"),
            tool_name: name.to_owned(),
            status,
            started_at: at,
            duration_ms: Some(ms),
            ..ToolRow::default()
        };
    for row in [
        tool("x1", "s1", "Read", d0, "completed", 100),
        tool("x2", "s1", "Read", d0 + 5, "error", 300),
        tool("x3", "s2", "Bash", d1, "completed", 200),
    ] {
        crate::repo::usage::upsert_tool(&conn, &row).unwrap();
    }

    let rows = app_usage(&conn, &span(d0, d1 + 10_000, 0)).unwrap();

    assert_eq!(rows.totals.total_tokens, 1_000);
    assert_eq!(rows.totals.input_tokens, 450);
    assert_eq!(rows.totals.output_tokens, 550);
    assert_eq!(rows.totals.model_request_count, 3);
    assert_eq!(rows.totals.model_error_count, 1);
    assert_eq!(rows.totals.avg_time_to_first_token_ms, Some(150.0));

    assert_eq!(rows.turn_totals.total_sessions, 2);
    assert_eq!(rows.turn_totals.total_turns, 3);
    assert_eq!(rows.turn_totals.avg_turn_duration_ms, Some(750.0));
    // 最长会话按“完成轮次时长之和”取（s1 = 1500）。
    assert_eq!(rows.turn_totals.longest_session_ms, 1_500);

    assert_eq!(rows.tool_totals.tool_call_count, 3);
    assert_eq!(rows.tool_totals.tool_error_count, 1);

    // 模型按总量降序；工具按调用数降序。
    assert_eq!(rows.models[0].model_id, Some("a".to_owned()));
    assert_eq!(rows.models[0].total_tokens, 800);
    assert_eq!(rows.models[0].request_count, 2);
    assert_eq!(rows.models[1].model_id, Some("b".to_owned()));
    assert_eq!(rows.models[1].total_tokens, 200);
    assert_eq!(rows.tools[0].tool_name, "Read");
    assert_eq!(rows.tools[0].call_count, 2);
    assert_eq!(rows.tools[0].error_count, 1);
    assert_eq!(rows.tools[0].avg_duration_ms, Some(200.0));
    assert_eq!(rows.tools[1].tool_name, "Bash");

    // 三张表按 dayIndex 合并。
    assert_eq!(rows.days.len(), 2);
    assert_eq!(rows.days[0].day_index, days_from_civil(2026, 7, 1));
    assert_eq!(
        (
            rows.days[0].total_tokens,
            rows.days[0].turn_count,
            rows.days[0].tool_call_count
        ),
        (800, 2, 2)
    );
    assert_eq!(
        (
            rows.days[1].total_tokens,
            rows.days[1].turn_count,
            rows.days[1].tool_call_count
        ),
        (200, 1, 1)
    );
    assert_eq!(rows.day_models.len(), 2);
    assert_eq!(
        (
            rows.day_models[0].day_index,
            rows.day_models[0].model_id.as_deref(),
            rows.day_models[0].total_tokens
        ),
        (days_from_civil(2026, 7, 1), Some("a"), 800)
    );

    // 原始表读不带回退原因（由 `fork_usage_query` 的调用方在回退时写入）；额外字段保持缺席。
    assert!(rows.rollup_fallback_reason.is_none());
    assert!(rows.facets.is_none());
    assert!(rows.hourly_tokens.is_none());
    assert!(rows.top_sessions.is_none());
}

/// 固定偏移分桶（Node 只做固定偏移；DST 误差已接受）：UTC 20:00 在 +5:30 是次日 01:30。
#[test]
fn app_usage_buckets_days_by_the_fixed_offset() {
    let (_dir, conn) = empty();
    let kolkata = 5 * 3_600_000 + 30 * 60_000;
    let at = day(2026, 7, 1) + 20 * 3_600_000;
    crate::repo::usage::record_model(&conn, &{
        let mut row = model_row("m1", "s1", "main_turn", "a", at);
        row.computed_total_tokens = 42;
        row
    })
    .unwrap();

    let rows = app_usage(&conn, &span(at - 1, at + 1, kolkata)).unwrap();
    assert_eq!(rows.days.len(), 1);
    assert_eq!(rows.days[0].day_index, days_from_civil(2026, 7, 2));
    assert_eq!(rows.days[0].total_tokens, 42);
    assert_eq!(rows.day_models[0].day_index, days_from_civil(2026, 7, 2));
}

/// 任务用量：同来源按增量计、压缩只降基线、未知来源全额并保留缓存列、错误计数。
#[test]
fn task_usage_counts_incremental_inputs_per_source() {
    let (_dir, conn) = empty();
    let row = |id: &str, source: &str, input: i64, output: i64, computed: i64| {
        let mut row = model_row(id, "s1", source, "a", 1_000);
        row.input_tokens = input;
        row.output_tokens = output;
        row.computed_total_tokens = computed;
        row
    };

    // started_at 相同时按 id 升序处理（与 Node 的 order by 一致）。
    let mut r1 = row("r1", "main_turn", 1_000, 50, 1_050);
    r1.started_at = 1_000;
    let mut r2 = row("r2", "main_turn", 800, 50, 850);
    r2.started_at = 2_000;
    let mut r3 = row("r3", "main_turn", 900, 50, 950);
    r3.started_at = 3_000;
    let mut r4 = row("r4", "subagent", 400, 20, 420);
    r4.started_at = 4_000;
    let mut r5 = row("r5", "session_title", 10, 30, 40);
    r5.started_at = 5_000;
    r5.cache_creation_input_tokens = 5;
    r5.cache_read_input_tokens = 7;
    let mut r6 = row("r6", "main_turn", 10, 0, 10);
    r6.started_at = 6_000;
    r6.status = "error";
    for row in [&r1, &r2, &r3, &r4, &r5, &r6] {
        crate::repo::usage::record_model(&conn, row).unwrap();
    }

    let totals = task_usage(&conn, "s1").unwrap();
    // r1 全额（基线建立）；r2 压缩后低于基线只降基线；r3 按新基线增量；r4 独立来源全额；
    // r5 未知来源全额并把缓存列计入；r6 错误请求（input 10 ≤ 基线 900 → 增量 0，非输入 0）。
    assert_eq!(totals.total_tokens, (1_050 + 50 + 150 + 420 + 40));
    assert_eq!(totals.input_tokens, (1_000 + 100 + 400 + 10));
    assert_eq!(totals.output_tokens, (50 + 50 + 50 + 20 + 30));
    assert_eq!(totals.cache_creation_tokens, 5);
    assert_eq!(totals.cache_read_tokens, 7);
    assert_eq!(totals.model_request_count, 6);
    assert_eq!(totals.model_error_count, 1);
    assert_eq!(
        totals.input_baseline_by_source,
        // Node lowers the baseline on every row of the source, error rows included (r6).
        vec![("main_turn".to_owned(), 10), ("subagent".to_owned(), 400)]
    );
}

/// 供应商总量优先于计算总量；没有行的会话是全零结果，不是错误。
#[test]
fn task_usage_prefers_the_provider_total_and_answers_zero_for_an_empty_session() {
    let (_dir, conn) = empty();
    let mut row = model_row("m1", "s1", "main_turn", "a", 1_000);
    row.input_tokens = 100;
    row.output_tokens = 300;
    row.computed_total_tokens = 400;
    row.provider_total_tokens = Some(500);
    crate::repo::usage::record_model(&conn, &row).unwrap();

    let totals = task_usage(&conn, "s1").unwrap();
    assert_eq!(totals.total_tokens, 500);
    assert_eq!(totals.input_tokens, 100);

    let empty = task_usage(&conn, "missing").unwrap();
    assert_eq!(empty.total_tokens, 0);
    assert_eq!(empty.model_request_count, 0);
    assert!(empty.input_baseline_by_source.is_empty());
}
