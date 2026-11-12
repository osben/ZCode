//! `usage_stats` / `conversation_usage` 行为（Node `usage-stats-request` / `-builder` /
//! `-run` 的用例移植）：计划区间算术（预置滚动、整日本地窗口、compare）、快照组装
//! （汇总/热图/日序列/份额）、没有 rollup 时的大声失败、以及两种参数校验。

use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use rust_cli_base::TaskScope;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{CreateSession, Kernel, KernelError, SessionHandle};
use rust_cli_kernel_api::store::{
    AppUsageDayModelRow, AppUsageDayRow, AppUsageFacets, AppUsageModelRow, AppUsageRows,
    AppUsageSessionRow, AppUsageSpan, AppUsageToolRow, AppUsageToolTotals, AppUsageTotals,
    AppUsageTurnTotals, SessionFilter, SessionSummary, StoreError, StoreQueries, TaskUsageTotals,
    USAGE_ROLLUP_UNAVAILABLE,
};
use rust_cli_kernel_api::testing::selection;
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};

use super::*;
use crate::context::Context;
use crate::server::{Defaults, Server};

/// 一小时（毫秒）。
const HOUR: i64 = 3_600_000;

/// Node 测试的基准时刻：2026-07-20T12:00:00Z。
fn now_ms() -> u64 {
    (days_from_civil(2026, 7, 20) * DAY_MS + 12 * HOUR) as u64
}

/// 时钟替身：now 与时区按用例固定（计划算术两者都读）。
struct SetClock {
    now_ms: u64,
    zone: &'static str,
    offset_minutes: i32,
}

impl Clock for SetClock {
    fn now_ms(&self) -> u64 {
        self.now_ms
    }

    fn time_zone(&self) -> String {
        self.zone.to_owned()
    }

    fn utc_offset_minutes(&self, _at_ms: u64) -> i32 {
        self.offset_minutes
    }
}

fn utc_clock() -> SetClock {
    SetClock {
        now_ms: now_ms(),
        zone: "UTC",
        offset_minutes: 0,
    }
}

/// 存储替身：记录服务过的区间；第一个区间回 `rows`（按请求旗标附挂 rollup 额外字段），
/// 之后的区间回 `previous_rows`。`unsupported_*` 模拟“没有用量查询的存储”。
struct FixedQueries {
    spans: StdMutex<Vec<AppUsageSpan>>,
    sessions: StdMutex<Vec<String>>,
    rows: AppUsageRows,
    previous_rows: AppUsageRows,
    facets: Option<AppUsageFacets>,
    hourly: Option<Vec<i64>>,
    top_sessions: Option<Vec<AppUsageSessionRow>>,
    task: TaskUsageTotals,
    unsupported_usage: bool,
    unavailable_usage: bool,
    unsupported_task: bool,
}

impl FixedQueries {
    fn new(rows: AppUsageRows) -> Self {
        Self {
            spans: StdMutex::new(Vec::new()),
            sessions: StdMutex::new(Vec::new()),
            rows,
            previous_rows: AppUsageRows::default(),
            facets: None,
            hourly: None,
            top_sessions: None,
            task: TaskUsageTotals::default(),
            unsupported_usage: false,
            unavailable_usage: false,
            unsupported_task: false,
        }
    }
}

#[async_trait]
impl StoreQueries for FixedQueries {
    async fn metering(
        &self,
        _session: &SessionId,
    ) -> Result<rust_cli_kernel_api::metering::SessionMetering, StoreError> {
        Err(StoreError::Unsupported {
            what: "metering".to_owned(),
        })
    }

    async fn request_stats(
        &self,
        _session: &SessionId,
    ) -> Result<rust_cli_kernel_api::metering::RequestStats, StoreError> {
        Err(StoreError::Unsupported {
            what: "request stats".to_owned(),
        })
    }

    async fn activity(
        &self,
        _query: rust_cli_kernel_api::metering::ActivityQuery,
    ) -> Result<rust_cli_kernel_api::metering::ActivityStats, StoreError> {
        Err(StoreError::Unsupported {
            what: "activity".to_owned(),
        })
    }

    async fn put_record(
        &self,
        _session: &SessionId,
        _record: &rust_cli_kernel_api::store::FrontendRecord,
    ) -> Result<(), StoreError> {
        Err(StoreError::Unsupported {
            what: "put record".to_owned(),
        })
    }

    async fn records(
        &self,
        _session: &SessionId,
        _kind: &str,
    ) -> Result<Vec<rust_cli_kernel_api::store::FrontendRecord>, StoreError> {
        Err(StoreError::Unsupported {
            what: "records".to_owned(),
        })
    }

    async fn app_usage(&self, span: AppUsageSpan) -> Result<AppUsageRows, StoreError> {
        let first = {
            let mut spans = self.spans.lock().unwrap();
            spans.push(span.clone());
            spans.len() == 1
        };
        if self.unsupported_usage {
            return Err(StoreError::Unsupported {
                what: "app usage".to_owned(),
            });
        }
        if self.unavailable_usage {
            return Err(StoreError::Storage {
                message: USAGE_ROLLUP_UNAVAILABLE.to_owned(),
            });
        }
        let mut rows = if first {
            self.rows.clone()
        } else {
            self.previous_rows.clone()
        };
        if span.include_facets {
            rows.facets = self.facets.clone();
        }
        if span.hourly {
            rows.hourly_tokens = self.hourly.clone();
        }
        if span.top_sessions {
            rows.top_sessions = self.top_sessions.clone();
        }
        Ok(rows)
    }

    async fn task_usage(&self, session: &SessionId) -> Result<TaskUsageTotals, StoreError> {
        self.sessions
            .lock()
            .unwrap()
            .push(session.as_str().to_owned());
        if self.unsupported_task {
            return Err(StoreError::Unsupported {
                what: "task usage".to_owned(),
            });
        }
        Ok(self.task.clone())
    }
}

/// 内核替身：这里只有 `queries` 有意义；会话不会被打开。
struct UsageKernel {
    queries: Arc<FixedQueries>,
}

#[async_trait]
impl Kernel for UsageKernel {
    fn queries(&self) -> Arc<dyn StoreQueries> {
        self.queries.clone()
    }

    async fn create_session(&self, _request: CreateSession) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "create".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Err(KernelError::Unsupported {
            what: "open".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError> {
        Ok(Vec::new())
    }
}

/// 组装被测服务器（会话泵在 scope 的任务里，scope 要活到断言之后）。
fn server(clock: SetClock, queries: Arc<FixedQueries>) -> (TaskScope, Arc<Server>) {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(clock)));
    let server = Arc::new(Server::new(
        context,
        Arc::new(UsageKernel { queries }),
        scope.spawner(),
        Defaults {
            selection: selection(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    (scope, server)
}

fn stats(range: &'static str) -> StatsParams {
    StatsParams {
        range,
        time_zone: None,
        window: None,
        compare: false,
        filters: Filters::default(),
        include_hourly: false,
        include_sessions: false,
    }
}

/// Node builder 用例 1 的行（两天活跃的 7 天区间）。
fn builder_rows() -> AppUsageRows {
    AppUsageRows {
        totals: AppUsageTotals {
            total_tokens: 1000,
            input_tokens: 800,
            output_tokens: 200,
            reasoning_tokens: 50,
            cache_creation_tokens: 100,
            cache_read_tokens: 600,
            model_request_count: 10,
            model_error_count: 2,
            avg_time_to_first_token_ms: Some(120.0),
        },
        turn_totals: AppUsageTurnTotals {
            total_sessions: 3,
            total_turns: 12,
            avg_turn_duration_ms: Some(1500.0),
            longest_session_ms: 3500,
        },
        tool_totals: AppUsageToolTotals {
            tool_call_count: 20,
            tool_error_count: 5,
        },
        models: vec![
            AppUsageModelRow {
                model_id: Some("a".to_owned()),
                total_tokens: 800,
                input_tokens: 600,
                output_tokens: 200,
                request_count: 8,
            },
            AppUsageModelRow {
                model_id: Some("b".to_owned()),
                total_tokens: 200,
                input_tokens: 200,
                output_tokens: 0,
                request_count: 2,
            },
        ],
        tools: vec![AppUsageToolRow {
            tool_name: "Read".to_owned(),
            call_count: 12,
            error_count: 2,
            avg_duration_ms: Some(100.0),
        }],
        days: vec![
            AppUsageDayRow {
                day_index: 6,
                total_tokens: 400,
                turn_count: 5,
                tool_call_count: 8,
            },
            AppUsageDayRow {
                day_index: 7,
                total_tokens: 600,
                turn_count: 7,
                tool_call_count: 12,
            },
        ],
        day_models: vec![
            AppUsageDayModelRow {
                day_index: 7,
                model_id: Some("a".to_owned()),
                total_tokens: 500,
            },
            AppUsageDayModelRow {
                day_index: 7,
                model_id: Some("b".to_owned()),
                total_tokens: 100,
            },
        ],
        ..AppUsageRows::default()
    }
}

fn builder_options(range: &str, since: i64, until: i64) -> SnapshotOptions<'_> {
    SnapshotOptions {
        range,
        time_zone: "UTC",
        tz_offset_ms: 0,
        generated_at: 1_000,
        since,
        until,
        window_start_day_index: None,
    }
}

/// 快照组装（Node builder 用例 1）：命中率、连胜、热图周填充、日序列与份额。
#[test]
fn the_snapshot_composes_summary_heatmap_daily_series_and_shares() {
    let snapshot = build_snapshot(&builder_rows(), &builder_options("7d", 0, 7 * DAY_MS));

    let summary = &snapshot["summary"];
    assert_eq!(summary["totalTokens"], json!(1000));
    // inputTokens 已是全部输入：缓存列只作分母回退（800 > 0 → 600/800）。
    assert_eq!(summary["cacheHitRate"], json!(0.75));
    assert_eq!(summary["modelErrorRate"], json!(0.2));
    assert_eq!(summary["toolErrorRate"], json!(0.25));
    assert_eq!(summary["activeDays"], json!(2));
    assert_eq!(summary["currentStreakDays"], json!(2));
    assert_eq!(summary["longestStreakDays"], json!(2));
    assert_eq!(summary["peakDayTokens"], json!(600));
    assert_eq!(summary["longestSessionMs"], json!(3500));
    assert_eq!(
        summary["favoriteModel"],
        json!({"modelId": "a", "totalTokens": 800, "share": 0.8})
    );
    assert_eq!(snapshot["source"], json!("agent-db"));

    // 热图：从第 0 天到第 7 天共 8 格 → 两周，末周用 null 补齐。
    let heatmap = &snapshot["heatmap"];
    assert_eq!(heatmap["startDate"], json!("1970-01-01"));
    assert_eq!(heatmap["endDate"], json!("1970-01-08"));
    assert_eq!(heatmap["maxTokens"], json!(600));
    assert_eq!(heatmap["weeks"].as_array().unwrap().len(), 2);
    let second = &heatmap["weeks"][1]["days"];
    assert_eq!(second.as_array().unwrap().len(), 7);
    assert_eq!(second[6], Value::Null);
    assert_eq!(second[0]["date"], json!("1970-01-08"));
    assert_eq!(second[0]["level"], json!(4));
    assert_eq!(heatmap["weeks"][0]["days"][6]["date"], json!("1970-01-07"));
    assert_eq!(heatmap["weeks"][0]["days"][6]["level"], json!(3));
    assert_eq!(heatmap["weeks"][0]["days"][5]["level"], json!(0));

    // 日序列：区间内每天一项；最后一天带两个模型。
    let daily = snapshot["dailyModelUsage"].as_array().unwrap();
    assert_eq!(daily.len(), 8);
    assert_eq!(daily[6]["models"], json!([]));
    assert_eq!(
        daily[7]["models"],
        json!([
            {"modelId": "a", "totalTokens": 500},
            {"modelId": "b", "totalTokens": 100}
        ])
    );
    assert_eq!(snapshot["models"][0]["share"], json!(0.8));
    assert_eq!(snapshot["models"][1]["share"], json!(0.2));
    assert_eq!(snapshot["tools"][0]["errorRate"], json!(2.0 / 12.0));
}

/// 全时区间从第一个有数据的天开始；中断后 currentStreak 清零、longest 保留（Node 用例 2）。
#[test]
fn an_all_time_span_starts_at_the_first_active_day_and_counts_streaks() {
    let rows = AppUsageRows {
        days: [(1_i64, 100_i64), (2, 300), (4, 200), (5, 800), (6, 700)]
            .into_iter()
            .map(|(day_index, total_tokens)| AppUsageDayRow {
                day_index,
                total_tokens,
                turn_count: 0,
                tool_call_count: 0,
            })
            .collect(),
        ..Default::default()
    };
    let snapshot = build_snapshot(&rows, &builder_options("all", 0, 7 * DAY_MS));
    assert_eq!(snapshot["heatmap"]["startDate"], json!("1970-01-02"));
    assert_eq!(snapshot["summary"]["peakDayTokens"], json!(800));
    assert_eq!(snapshot["summary"]["longestStreakDays"], json!(3));
    assert_eq!(snapshot["summary"]["currentStreakDays"], json!(0));
    assert_eq!(snapshot["summary"]["activeDays"], json!(5));
    assert_eq!(snapshot["dailyModelUsage"].as_array().unwrap().len(), 7);
}

/// 预置区间的旧算术保持不变：since = now − N 天，compare 给前一段等长区间。
#[test]
fn preset_ranges_keep_the_legacy_rolling_arithmetic() {
    let now = now_ms() as i64;
    let clock = utc_clock();
    let plan = plan_usage_query(&clock, &stats("7d"), now as u64);
    assert_eq!(plan.span.since, now - 7 * DAY_MS);
    assert_eq!(plan.span.until, now);
    assert!(plan.previous.is_none());
    assert_eq!(plan.time_zone, "UTC");
    assert_eq!(plan.tz_offset_ms, 0);

    let mut compare = stats("30d");
    compare.compare = true;
    let plan = plan_usage_query(&clock, &compare, now as u64);
    let previous = plan.previous.unwrap();
    assert_eq!(previous.since, now - 60 * DAY_MS);
    assert_eq!(previous.until, now - 30 * DAY_MS - 1);
    assert!(previous.window.is_none());

    // all-time：since = 0，compare 被忽略。
    let mut all = stats("all");
    all.compare = true;
    let plan = plan_usage_query(&clock, &all, now as u64);
    assert_eq!((plan.span.since, plan.span.until), (0, now));
    assert!(plan.previous.is_none());
}

/// 窗口选整本地日；compare 给紧邻的前一段等长窗口（Kolkata +5:30）。
#[test]
fn a_window_selects_whole_local_days_in_the_request_zone() {
    let now = now_ms();
    let clock = SetClock {
        now_ms: now,
        zone: "Asia/Kolkata",
        offset_minutes: 330,
    };
    let kolkata = 5 * HOUR + 30 * 60_000;
    let mut params = stats("all");
    params.time_zone = Some("Asia/Kolkata".to_owned());
    params.window = Some(WindowDays {
        from_day: days_from_civil(2026, 7, 1),
        to_day: days_from_civil(2026, 7, 3),
    });
    let plan = plan_usage_query(&clock, &params, now);
    assert_eq!(plan.tz_offset_ms, kolkata);
    assert_eq!(
        plan.span.since,
        days_from_civil(2026, 7, 1) * DAY_MS - kolkata
    );
    assert_eq!(
        plan.span.until,
        days_from_civil(2026, 7, 4) * DAY_MS - kolkata - 1
    );
    assert_eq!(
        plan.span.window_start_day_index,
        Some(days_from_civil(2026, 7, 1))
    );

    params.compare = true;
    let plan = plan_usage_query(&clock, &params, now);
    let previous = plan.previous.unwrap();
    assert_eq!(
        describe_span_window(&previous, plan.tz_offset_ms),
        json!({"from": "2026-06-28", "to": "2026-06-30"})
    );
}

/// 解析不了的 IANA 区退到 UTC 天（与 Node 的 catch 分支一致）；Etc/GMT±N 按符号反转。
#[test]
fn an_unresolvable_zone_falls_back_to_utc_days() {
    let now = now_ms();
    let clock = utc_clock();
    let mut params = stats("7d");
    params.time_zone = Some("America/New_York".to_owned());
    let plan = plan_usage_query(&clock, &params, now);
    assert_eq!(plan.tz_offset_ms, 0);

    assert_eq!(tz_offset_ms(&clock, "Etc/GMT-8", now), 8 * HOUR);
    assert_eq!(tz_offset_ms(&clock, "Etc/GMT+5", now), -5 * HOUR);
    assert_eq!(tz_offset_ms(&clock, "utc", now), 0);
}

/// 默认请求就是旧的单次查询：无 window / previous 回显。
#[tokio::test]
async fn a_default_request_makes_one_query_and_answers_the_legacy_snapshot() {
    let queries = Arc::new(FixedQueries::new(builder_rows()));
    let (scope, server) = server(utc_clock(), queries.clone());
    let snapshot = usage_stats(&server, &json!({"range": "7d"})).await.unwrap();
    assert_eq!(snapshot["range"], json!("7d"));
    assert_eq!(snapshot["generatedAt"], json!(now_ms() as i64));
    assert_eq!(snapshot["summary"]["totalTokens"], json!(1000));
    assert!(snapshot.get("window").is_none());
    assert!(snapshot.get("previous").is_none());
    assert!(snapshot.get("facets").is_none());
    let spans = queries.spans.lock().unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].since_ms, now_ms() as i64 - 7 * DAY_MS);
    assert!(!spans[0].include_facets);
    drop(spans);
    drop((scope, server));
}

/// 窗口请求回显窗口，日序列一天一项。
#[tokio::test]
async fn a_window_request_echoes_the_window_and_series_per_day() {
    let queries = Arc::new(FixedQueries::new(builder_rows()));
    let (scope, server) = server(utc_clock(), queries.clone());
    let snapshot = usage_stats(
        &server,
        &json!({
            "range": "30d",
            "timeZone": "UTC",
            "window": {"from": "2026-07-01", "to": "2026-07-05"},
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        snapshot["window"],
        json!({"from": "2026-07-01", "to": "2026-07-05"})
    );
    assert_eq!(snapshot["dailyModelUsage"].as_array().unwrap().len(), 5);
    assert_eq!(snapshot["dailyModelUsage"][0]["date"], json!("2026-07-01"));
    assert_eq!(snapshot["heatmap"]["startDate"], json!("2026-07-01"));
    let spans = queries.spans.lock().unwrap();
    assert_eq!(spans.len(), 1);
    assert_eq!(spans[0].since_ms, days_from_civil(2026, 7, 1) * DAY_MS);
    drop(spans);
    drop((scope, server));
}

/// compare 查两段区间：前一段不带 include 旗标，日序列与主区间逐日对齐。
#[tokio::test]
async fn a_compare_request_queries_the_previous_span_and_aligns_its_days() {
    let mut previous = AppUsageRows::default();
    previous.totals.total_tokens = 7;
    previous.day_models = vec![AppUsageDayModelRow {
        day_index: days_from_civil(2026, 7, 13),
        model_id: Some("a".to_owned()),
        total_tokens: 7,
    }];
    let mut store = FixedQueries::new(builder_rows());
    store.previous_rows = previous;
    let queries = Arc::new(store);
    let (scope, server) = server(utc_clock(), queries.clone());
    let snapshot = usage_stats(&server, &json!({"range": "7d", "compare": true}))
        .await
        .unwrap();
    let spans = queries.spans.lock().unwrap();
    assert_eq!(spans.len(), 2);
    assert_eq!(spans[1].since_ms, now_ms() as i64 - 14 * DAY_MS);
    assert!(!spans[1].include_facets && !spans[1].hourly && !spans[1].top_sessions);
    drop(spans);
    assert_eq!(
        snapshot["previous"]["window"],
        json!({"from": "2026-07-06", "to": "2026-07-13"})
    );
    assert_eq!(snapshot["previous"]["summary"]["totalTokens"], json!(7));
    // 主序列 8 天（2026-07-13…07-20）；前一段的量在它的最后一天（07-13），与主段的末位对齐。
    assert_eq!(
        snapshot["previous"]["dailyTokens"],
        json!([0, 0, 0, 0, 0, 0, 0, 7])
    );
    drop((scope, server));
}

/// 全时快照才带 facets；include 的额外字段只挂在主区间上。
#[tokio::test]
async fn the_lifetime_snapshot_carries_facets_and_requested_extras() {
    let mut store = FixedQueries::new(AppUsageRows::default());
    store.facets = Some(AppUsageFacets {
        models: vec!["a".to_owned()],
        providers: Vec::new(),
        query_sources: vec!["main_turn".to_owned()],
        workspaces: Vec::new(),
    });
    store.hourly = Some(vec![5_i64; 168]);
    store.top_sessions = Some(vec![AppUsageSessionRow {
        session_id: "s1".to_owned(),
        title: Some("t".to_owned()),
        workspace_key: "/w".to_owned(),
        total_tokens: 9,
        turn_count: 1,
        duration_ms: 100,
    }]);
    let queries = Arc::new(store);
    let (scope, server) = server(utc_clock(), queries.clone());
    let snapshot = usage_stats(
        &server,
        &json!({"range": "all", "include": ["hourly", "sessions"]}),
    )
    .await
    .unwrap();
    assert_eq!(
        snapshot["facets"],
        json!({"models": ["a"], "providers": [], "querySources": ["main_turn"], "workspaces": []})
    );
    assert_eq!(snapshot["hourlyTokens"].as_array().unwrap().len(), 168);
    assert_eq!(snapshot["topSessions"][0]["sessionId"], json!("s1"));
    let spans = queries.spans.lock().unwrap();
    assert_eq!(spans.len(), 1);
    assert!(spans[0].include_facets && spans[0].hourly && spans[0].top_sessions);
    drop(spans);
    drop((scope, server));
}

/// The store owns Node's rollup-first rules: the filters reach every span unchanged, and the
/// store's `usage_rollup_unavailable` surfaces as Node's internal error instead of a generic
/// storage failure.
#[tokio::test]
async fn filters_reach_the_store_and_its_unavailable_error_is_node_s() {
    let queries = Arc::new(FixedQueries::new(builder_rows()));
    let (scope, filtered) = server(utc_clock(), queries.clone());
    usage_stats(
        &filtered,
        &json!({"range": "7d", "compare": true, "filters": {"modelIds": ["a"], "workspaceKeys": ["w"]}}),
    )
    .await
    .unwrap();
    let spans = queries.spans.lock().unwrap().clone();
    assert_eq!(spans.len(), 2);
    for span in &spans {
        assert_eq!(span.filters.model_ids, ["a"]);
        assert_eq!(span.filters.workspace_keys, ["w"]);
        assert!(span.filters.provider_ids.is_empty());
    }
    drop((scope, filtered));

    let mut unavailable = FixedQueries::new(builder_rows());
    unavailable.unavailable_usage = true;
    let (scope, server) = server(utc_clock(), Arc::new(unavailable));
    let error = usage_stats(&server, &json!({"range": "7d"}))
        .await
        .unwrap_err();
    assert_eq!(
        (error.code, error.message.as_str()),
        (-32603, "usage_rollup_unavailable")
    );
    drop((scope, server));
}

/// 没有用量查询的存储给空快照（Node 缺 usageStore 的护栏）。
#[tokio::test]
async fn a_store_without_the_usage_query_answers_the_empty_snapshot() {
    let mut store = FixedQueries::new(AppUsageRows::default());
    store.unsupported_usage = true;
    let queries = Arc::new(store);
    let (scope, server) = server(utc_clock(), queries.clone());
    let snapshot = usage_stats(&server, &json!({"range": "7d"})).await.unwrap();
    assert_eq!(snapshot["summary"]["totalTokens"], json!(0));
    assert_eq!(snapshot["models"], json!([]));
    assert_eq!(snapshot["summary"]["avgTimeToFirstTokenMs"], Value::Null);
    drop((scope, server));
}

/// 参数按 zod 严格校验（-32602）：未知键、坏枚举、不实的日历日、窗口顺序与跨度。
#[tokio::test]
async fn usage_stats_params_follow_the_zod_schema() {
    let (scope, server) = server(
        utc_clock(),
        Arc::new(FixedQueries::new(AppUsageRows::default())),
    );
    for params in [
        json!({}),
        json!({"range": "90d"}),
        json!({"range": "7d", "extra": 1}),
        json!({"range": "7d", "timeZone": 5}),
        json!({"range": "7d", "window": {"from": "2026-02-30", "to": "2026-03-01"}}),
        json!({"range": "7d", "window": {"from": "2026-07-05", "to": "2026-07-01"}}),
        json!({"range": "7d", "window": {"from": "2024-01-01", "to": "2026-07-05"}}),
        json!({"range": "7d", "window": {"from": "2026-07-01", "to": "2026-07-05", "extra": 1}}),
        json!({"range": "7d", "compare": "yes"}),
        json!({"range": "7d", "include": ["hourly", "sessions", "other"]}),
        json!({"range": "7d", "include": "hourly"}),
        json!({"range": "7d", "filters": {"modelIds": [0]}}),
        json!({"range": "7d", "filters": {"unknown": []}}),
        json!("not an object"),
    ] {
        let error = usage_stats(&server, &params).await.unwrap_err();
        assert_eq!(error.code, -32602, "{params}");
        assert!(error.message.starts_with("Invalid params — "), "{params}");
    }
    drop((scope, server));
}

/// 会话用量：折叠总数原样上送，基线映射按首见顺序。
#[tokio::test]
async fn conversation_usage_returns_the_fold_totals() {
    let mut store = FixedQueries::new(AppUsageRows::default());
    store.task = TaskUsageTotals {
        total_tokens: 1710,
        input_tokens: 1510,
        output_tokens: 200,
        reasoning_tokens: 30,
        cache_creation_tokens: 5,
        cache_read_tokens: 7,
        model_request_count: 6,
        model_error_count: 1,
        input_baseline_by_source: vec![("main_turn".to_owned(), 900), ("subagent".to_owned(), 400)],
    };
    let queries = Arc::new(store);
    let (scope, server) = server(utc_clock(), queries.clone());
    let result = conversation_usage(&server, &json!({"sessionId": "sess_1"}))
        .await
        .unwrap();
    assert_eq!(
        result,
        json!({
            "sessionId": "sess_1",
            "totalTokens": 1710,
            "inputTokens": 1510,
            "outputTokens": 200,
            "reasoningTokens": 30,
            "cacheCreationTokens": 5,
            "cacheReadTokens": 7,
            "modelRequestCount": 6,
            "modelErrorCount": 1,
            "inputBaselineBySource": {"main_turn": 900, "subagent": 400},
        })
    );
    assert_eq!(*queries.sessions.lock().unwrap(), vec!["sess_1".to_owned()]);

    for params in [
        json!({}),
        json!({"sessionId": ""}),
        json!({"sessionId": "s", "other": 1}),
        json!(null),
    ] {
        assert_eq!(
            conversation_usage(&server, &params).await.unwrap_err().code,
            -32602,
            "{params}"
        );
    }
    drop((scope, server));
}

/// 没有任务用量查询的存储给全零（Node 缺 usageStore 的护栏）。
#[tokio::test]
async fn a_store_without_the_task_usage_query_answers_zeros() {
    let mut store = FixedQueries::new(AppUsageRows::default());
    store.unsupported_task = true;
    let queries = Arc::new(store);
    let (scope, server) = server(utc_clock(), queries.clone());
    let result = conversation_usage(&server, &json!({"sessionId": "s"}))
        .await
        .unwrap();
    assert_eq!(result["totalTokens"], json!(0));
    assert_eq!(result["modelRequestCount"], json!(0));
    assert_eq!(result["inputBaselineBySource"], json!({}));
    drop((scope, server));
}
