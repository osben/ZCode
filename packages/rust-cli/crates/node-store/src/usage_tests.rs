//! 用量事实 → Node 用量表（usage.md §2）：逐列的取值、同批提交、轮次聚合、保留期。
use rust_cli_base::models::GLM_5_3;
use rust_cli_kernel_api::ids::{MessageId, SessionId, ToolUseId};
use rust_cli_kernel_api::message::{StopReason, Usage};
use rust_cli_kernel_api::metering::{CallStatus, ModelCall, ToolCall};
use rust_cli_kernel_api::model::{ModelError, ModelSelection, QuerySource};
use rust_cli_kernel_api::store::{Fact, SessionKind, SessionStore, StoreQueries};
use serde_json::{Value, json};

use crate::tests::{TestStore, assistant, batch, meta, started, text, user};

fn sid() -> SessionId {
    SessionId::new("sess_1")
}

fn usage() -> Usage {
    Usage {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
    }
}

/// 请求时的选择（与会话的选择不同：行里取请求时的快照）。
fn requested() -> ModelSelection {
    ModelSelection {
        reasoning: Some("max".into()),
        ..ModelSelection::new("anthropic", GLM_5_3)
    }
}

fn call(message: &str, status: CallStatus) -> ModelCall {
    ModelCall {
        first_token_at_ms: Some(2_300),
        // 只在内存里的首个内容（早于首字）：用量表不写它，下面的列照旧按首字（修复线 F105）。
        first_content_at_ms: Some(2_200),
        stop_reason: Some(StopReason::ToolUse),
        tool_calls: 2,
        usage: Some(usage()),
        ..ModelCall::new(
            MessageId::new(message),
            QuerySource::MainThread,
            requested(),
            2_000,
            2_900,
            status,
        )
    }
}

fn tool(id: &str, status: CallStatus) -> ToolCall {
    ToolCall {
        tool_use: ToolUseId::new(id),
        name: "Read".into(),
        started_at_ms: 3_000,
        completed_at_ms: 3_400,
        status,
        output_bytes: 42,
    }
}

/// 一行转成 `{列名: 值}`。
fn row(t: &TestStore, sql: &str) -> Value {
    let conn = t.connection();
    let statement = conn.prepare(sql).unwrap();
    let values = t.rows(sql).into_iter().next().expect("one row");
    Value::Object(
        statement
            .column_names()
            .iter()
            .map(|n| (*n).to_owned())
            .zip(values)
            .collect(),
    )
}

/// 当前轮的 `anchor.turnId`（user 消息的记录）。
fn turn_of(t: &TestStore, message: &str) -> Value {
    let data = t.rows(&format!("select data from message where id = '{message}'"));
    let data: Value = serde_json::from_str(data[0][0].as_str().unwrap()).unwrap();
    data["anchor"]["turnId"].clone()
}

async fn commit(t: &TestStore, session: &SessionId, facts: Vec<Fact>) {
    t.store.commit(session, batch(None, facts)).await.unwrap();
}

#[tokio::test]
async fn a_model_call_is_a_node_model_usage_row_in_the_assistant_batch() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    t.source.at(1_500);
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    t.source.at(3_000);
    let model = call("msg_a1", CallStatus::Completed);
    commit(
        &t,
        &sid(),
        vec![
            assistant("msg_a1", vec![text("ok")], Some(usage())),
            Fact::ModelCalled { call: model },
        ],
    )
    .await;
    let got = row(&t, "select * from model_usage");
    assert_eq!(
        got,
        json!({
            "id": "usage_model_main_turn_msg_a1_0",
            "logical_request_id": "msg_a1",
            "attempt_index": 0,
            "session_id": "sess_1",
            "turn_id": turn_of(&t, "msg_u1"),
            "trace_id": "sess_1",
            "span_id": null,
            "assistant_message_id": "msg_a1",
            "parent_user_message_id": "msg_u1",
            "query_source": "main_turn",
            "provider_id": "anthropic",
            "model_id": GLM_5_3,
            "variant": "max",
            "agent": "zcode-agent",
            "mode": "build",
            "task_type": "interactive",
            "status": "completed",
            "started_at": 2_000,
            "first_token_at": 2_300,
            "completed_at": 2_900,
            "duration_ms": 900,
            "time_to_first_token_ms": 300,
            "finish_reason": "tool-calls",
            "tool_call_count": 2,
            "input_tokens": 15,
            "output_tokens": 5,
            "reasoning_tokens": 0,
            "cache_creation_input_tokens": 3,
            "cache_read_input_tokens": 2,
            "provider_total_tokens": 20,
            "computed_total_tokens": 20,
            "retry_count": 0,
            "retryable": 0,
            "cancelled_by_user": 0,
            "context_exceeded": 0,
            "error_type": null,
            "error_code": null,
            "error_message": null,
            "raw_usage_json": "{\"inputTokens\":15,\"outputTokens\":5,\"totalTokens\":20,\"cacheReadTokens\":2,\"cacheWriteTokens\":3}",
            "provider_metadata_json": null,
        })
    );
}

#[tokio::test]
async fn a_failed_request_without_a_message_still_writes_its_row() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    let mut failed = call("msg_a1", CallStatus::Error);
    failed.usage = None;
    failed.stop_reason = None;
    failed.first_token_at_ms = None;
    failed.retries = 2;
    failed.error = Some(ModelError::Server {
        status: 529,
        message: "overloaded".into(),
    });
    commit(&t, &sid(), vec![Fact::ModelCalled { call: failed }]).await;
    let got = row(
        &t,
        "select assistant_message_id, status, finish_reason, retry_count, retryable, error_type,
                error_code, error_message, raw_usage_json, input_tokens, provider_total_tokens,
                first_token_at, time_to_first_token_ms from model_usage",
    );
    assert_eq!(
        got,
        json!({
            "assistant_message_id": null, "status": "error", "finish_reason": null,
            "retry_count": 2, "retryable": 1, "error_type": "server", "error_code": "529",
            "error_message": "server error 529: overloaded", "raw_usage_json": null,
            "input_tokens": 0, "provider_total_tokens": null, "first_token_at": null,
            "time_to_first_token_ms": null,
        })
    );
}

#[tokio::test]
async fn an_interrupted_or_too_long_request_sets_its_flags() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    let mut cancelled = call("msg_a1", CallStatus::Cancelled);
    cancelled.usage = None;
    let mut long = call("msg_a2", CallStatus::Error);
    long.error = Some(ModelError::PromptTooLong {
        message: "prompt is too long".into(),
    });
    commit(&t, &sid(), vec![Fact::ModelCalled { call: cancelled }]).await;
    commit(&t, &sid(), vec![Fact::ModelCalled { call: long }]).await;
    assert_eq!(
        t.rows(
            "select status, cancelled_by_user, context_exceeded, retryable from model_usage
              order by logical_request_id"
        ),
        vec![
            vec![json!("cancelled"), json!(1), json!(0), json!(0)],
            vec![json!("error"), json!(0), json!(1), json!(0)],
        ]
    );
}

/// 旁路请求的 `query_source` 与行 ID 用 Node 的名字（工作线 F71，usage.md §2.1）：标题 `session_title`、WebFetch 摘要
/// `web_fetch_processing`；Node 没有对应用途的旁路照原样。以前写的是本工程的名字。
#[tokio::test]
async fn side_requests_use_the_node_names() {
    use rust_cli_kernel_api::side_request::SideSource;
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    for (message, side) in [
        ("msg_t1", SideSource::SessionTitle),
        ("msg_w1", SideSource::WebFetch),
        ("msg_h1", SideSource::HookPrompt),
    ] {
        let mut side_call = call(message, CallStatus::Completed);
        side_call.source = QuerySource::Side(side);
        commit(&t, &sid(), vec![Fact::ModelCalled { call: side_call }]).await;
    }
    assert_eq!(
        t.rows("select id, query_source from model_usage order by logical_request_id"),
        vec![
            vec![
                json!("usage_model_hook_prompt_msg_h1_0"),
                json!("hook_prompt")
            ],
            vec![
                json!("usage_model_session_title_msg_t1_0"),
                json!("session_title")
            ],
            vec![
                json!("usage_model_web_fetch_processing_msg_w1_0"),
                json!("web_fetch_processing")
            ],
        ]
    );
}

#[tokio::test]
async fn a_tool_call_is_the_node_settled_tool_usage_row() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    commit(
        &t,
        &sid(),
        vec![
            Fact::ToolCalled {
                call: tool("toolu_1", CallStatus::Completed),
            },
            Fact::ToolCalled {
                call: tool("toolu_2", CallStatus::Cancelled),
            },
        ],
    )
    .await;
    let got = row(
        &t,
        "select * from tool_usage where tool_call_id = 'toolu_1'",
    );
    assert_eq!(
        got,
        json!({
            "id": "usage_tool_sess_1_toolu_1", "session_id": "sess_1", "turn_id": turn_of(&t, "msg_u1"),
            "trace_id": "sess_1", "tool_call_id": "toolu_1", "tool_name": "Read",
            "side_effect_scope": null, "read_only": null, "destructive": null,
            "approval_status": "none", "status": "completed", "started_at": 3_000,
            "first_output_at": 3_400, "completed_at": 3_400, "duration_ms": 400,
            "time_to_first_output_ms": 400, "exit_code": null, "output_bytes": 42,
            "stdout_bytes": 0, "stderr_bytes": 0, "truncated": 0, "retry_count": 0,
            "retryable": 0, "cancelled_by_user": 0, "error_type": null, "error_code": null,
            "error_message": null,
        })
    );
    assert_eq!(
        t.rows("select status, cancelled_by_user from tool_usage where tool_call_id = 'toolu_2'"),
        vec![vec![json!("error"), json!(1)]]
    );
}

#[tokio::test]
async fn a_turn_aggregates_its_rows_and_keeps_the_earliest_start() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    // 输入消息的 id 带创建毫秒：msg_<36 进制>_…；1_000 → "rs"。
    t.source.at(5_000);
    commit(&t, &sid(), vec![user("msg_rs_u1", "hi")]).await;
    let mut first = call("msg_a1", CallStatus::Completed);
    first.retries = 1;
    let mut second = call("msg_a2", CallStatus::Completed);
    second.started_at_ms = 3_500;
    second.first_token_at_ms = Some(3_600);
    commit(
        &t,
        &sid(),
        vec![
            Fact::ModelCalled { call: first },
            Fact::ToolCalled {
                call: tool("toolu_1", CallStatus::Error),
            },
            Fact::ToolCalled {
                call: tool("toolu_2", CallStatus::Completed),
            },
            Fact::ModelCalled { call: second },
        ],
    )
    .await;
    t.source.at(6_000);
    commit(
        &t,
        &sid(),
        vec![Fact::TurnEnded {
            status: CallStatus::Completed,
        }],
    )
    .await;
    let got = row(&t, "select * from turn_usage");
    assert_eq!(
        got,
        json!({
            "session_id": "sess_1", "turn_id": turn_of(&t, "msg_rs_u1"), "trace_id": "sess_1",
            "user_message_id": "msg_rs_u1", "status": "completed", "started_at": 1_000,
            "first_model_start_at": 2_000, "first_token_at": 2_300, "completed_at": 6_000,
            "duration_ms": 5_000, "time_to_first_token_ms": 1_300, "model_request_count": 2,
            "model_retry_count": 1, "tool_call_count": 2, "tool_error_count": 1,
            "input_tokens": 30, "output_tokens": 10, "reasoning_tokens": 0,
            "cache_creation_input_tokens": 6, "cache_read_input_tokens": 4,
            "computed_total_tokens": 40, "retryable": 0, "cancelled_by_user": 0,
            "context_exceeded": 0, "error_type": null, "error_code": null,
        })
    );
    // 后台通知开的回合没有新的真实输入：同一轮，计数覆盖整轮，开始时间不变（usage.md D7）。
    let mut later = call("msg_a3", CallStatus::Completed);
    later.started_at_ms = 7_000;
    commit(&t, &sid(), vec![Fact::ModelCalled { call: later }]).await;
    t.source.at(8_000);
    commit(
        &t,
        &sid(),
        vec![Fact::TurnEnded {
            status: CallStatus::Cancelled,
        }],
    )
    .await;
    assert_eq!(
        t.rows(
            "select started_at, completed_at, duration_ms, model_request_count, status,
                    cancelled_by_user from turn_usage"
        ),
        vec![vec![
            json!(1_000),
            json!(8_000),
            json!(7_000),
            json!(3),
            json!("cancelled"),
            json!(1)
        ]]
    );
}

/// 会话标题的行（工作线 F73，usage.md §2.1.1）在输入的这一轮里，但回合用量只数主循环的请求（Node 的回合用量按回合
/// 自己的请求事件数，标题有自己的事件列表）。
#[tokio::test]
async fn title_rows_do_not_count_in_the_turn() {
    use rust_cli_kernel_api::side_request::SideSource;
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(&t, &sid(), vec![user("msg_u1", "name this session please")]).await;
    let mut title = call("msg_t1", CallStatus::Completed);
    title.source = QuerySource::Side(SideSource::SessionTitle);
    title.started_at_ms = 1_500;
    title.first_token_at_ms = None;
    title.tool_calls = 0;
    commit(&t, &sid(), vec![Fact::ModelCalled { call: title }]).await;
    let main = call("msg_a1", CallStatus::Completed);
    commit(&t, &sid(), vec![Fact::ModelCalled { call: main }]).await;
    commit(
        &t,
        &sid(),
        vec![Fact::TurnEnded {
            status: CallStatus::Completed,
        }],
    )
    .await;
    assert_eq!(
        t.rows("select turn_id, parent_user_message_id from model_usage where query_source = 'session_title'"),
        vec![vec![turn_of(&t, "msg_u1"), json!("msg_u1")]],
        "the title row is in the turn of the input"
    );
    assert_eq!(
        t.rows(
            "select model_request_count, first_model_start_at, input_tokens, output_tokens
               from turn_usage"
        ),
        vec![vec![json!(1), json!(2_000), json!(15), json!(5)]]
    );
}

#[tokio::test]
async fn a_turn_without_a_real_user_input_is_not_written() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(
        &t,
        &sid(),
        vec![Fact::TurnEnded {
            status: CallStatus::Completed,
        }],
    )
    .await;
    assert!(t.rows("select * from turn_usage").is_empty());
}

#[tokio::test]
async fn subagent_rows_go_to_the_child_session() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let mut child = meta("sess_subagent_agent_1", "/w", "");
    child.kind = SessionKind::Subagent;
    child.parent = Some(sid());
    t.store.create(child).await.unwrap();
    let child = SessionId::new("sess_subagent_agent_1");
    commit(&t, &child, vec![user("msg_u1", "explore")]).await;
    let mut model = call("msg_a1", CallStatus::Completed);
    model.source = QuerySource::Subagent("Explore".into());
    commit(&t, &child, vec![Fact::ModelCalled { call: model }]).await;
    assert_eq!(
        t.rows("select id, session_id, query_source, task_type from model_usage"),
        vec![vec![
            json!("usage_model_subagent_msg_a1_0"),
            json!("sess_subagent_agent_1"),
            json!("subagent"),
            json!("subagent_child"),
        ]]
    );
}

#[tokio::test]
async fn a_failed_batch_rolls_back_its_usage_rows() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    let failed = t
        .store
        .commit(
            &sid(),
            batch(
                None,
                vec![
                    Fact::ModelCalled {
                        call: call("msg_a1", CallStatus::Completed),
                    },
                    // 同一个 id 再追加是错误：整批回滚。
                    user("msg_u1", "again"),
                ],
            ),
        )
        .await;
    assert!(failed.is_err());
    assert!(t.rows("select * from model_usage").is_empty());
}

#[tokio::test]
async fn usage_writes_prune_rows_older_than_thirty_days() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    commit(
        &t,
        &sid(),
        vec![Fact::ModelCalled {
            call: call("msg_a1", CallStatus::Completed),
        }],
    )
    .await;
    let day = 86_400_000_u64;
    // Fork: a raw row is pruned only once a recompute covered it (an App Usage read here).
    t.source.at(2_000 + 30 * day + 1);
    all_time(&t).await;
    let mut fresh = call("msg_a2", CallStatus::Completed);
    fresh.started_at_ms = 30 * day;
    commit(&t, &sid(), vec![Fact::ModelCalled { call: fresh }]).await;
    assert_eq!(
        t.rows("select logical_request_id from model_usage"),
        vec![vec![json!("msg_a2")]]
    );
}

/// The whole history as App Usage answers it (a read recomputes the rollup first).
async fn all_time(t: &TestStore) -> rust_cli_kernel_api::store::AppUsageRows {
    let span = rust_cli_kernel_api::store::AppUsageSpan {
        since_ms: 0,
        until_ms: i64::MAX / 4,
        tz_offset_ms: 0,
        filters: rust_cli_kernel_api::store::AppUsageFilters::default(),
        include_facets: false,
        hourly: false,
        top_sessions: false,
    };
    let rows = t.store.app_usage(span).await.unwrap();
    assert_eq!(rows.rollup_fallback_reason, None);
    rows
}

const DAY: u64 = 86_400_000;

fn model_call_at(message: &str, at: u64) -> Fact {
    let mut model = call(message, CallStatus::Completed);
    model.started_at_ms = at;
    model.first_token_at_ms = Some(at + 100);
    model.completed_at_ms = at + 200;
    Fact::ModelCalled { call: model }
}

/// Fork (specs/fork-agent-runtime-selection.md "Usage rollup in Rust mode"): without a recompute
/// no raw row is pruned, so a row App Usage never saw is still counted by the first read.
#[tokio::test]
async fn without_a_watermark_no_raw_row_is_pruned() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    commit(&t, &sid(), vec![model_call_at("msg_a1", 2_000)]).await;
    t.source.at(2_000 + 31 * DAY);
    commit(
        &t,
        &sid(),
        vec![model_call_at("msg_a2", 2_000 + 31 * DAY - 1_000)],
    )
    .await;
    assert_eq!(
        t.rows("select logical_request_id from model_usage order by started_at"),
        vec![vec![json!("msg_a1")], vec![json!("msg_a2")]]
    );
    assert_eq!(all_time(&t).await.totals.total_tokens, 40);
}

/// A raw row written after the last recompute stays until a recompute covers it; the prune after
/// that removes it and the rollup still counts it.
#[tokio::test]
async fn a_raw_row_is_pruned_only_after_a_recompute_covered_it() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    let base = 40 * DAY;
    t.source.at(base);
    assert_eq!(all_time(&t).await.totals.total_tokens, 0);
    // Written after the read: the rollup has not seen it.
    t.source.at(base + 60_000);
    commit(&t, &sid(), vec![model_call_at("msg_a1", base + 30_000)]).await;
    // A month later another usage batch: the row is past 30 days but not covered.
    let later = base + 31 * DAY;
    t.source.at(later);
    commit(&t, &sid(), vec![model_call_at("msg_a2", later - 10_000)]).await;
    assert_eq!(
        t.rows("select count(*) from model_usage"),
        vec![vec![json!(2)]]
    );
    // A read covers it; the next usage batch prunes it and both are still counted.
    assert_eq!(all_time(&t).await.totals.total_tokens, 40);
    t.source.at(later + 60_000);
    commit(&t, &sid(), vec![model_call_at("msg_a3", later + 30_000)]).await;
    assert_eq!(
        t.rows("select logical_request_id from model_usage order by started_at"),
        vec![vec![json!("msg_a2")], vec![json!("msg_a3")]]
    );
    assert_eq!(all_time(&t).await.totals.total_tokens, 60);
}

/// A turn longer than the 7-day replace window: its `turn_usage` row arrives with the turn's old
/// start after the last model call. The usage write path must not move the watermark in between,
/// or the turn falls outside every later replace window.
#[tokio::test]
async fn a_turn_longer_than_the_replace_window_is_still_rolled_up() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let base = 40 * DAY;
    t.source.at(base - 1);
    all_time(&t).await;
    t.source.at(base);
    // The input's id carries its creation time (base36 ms): "1l5m2o0" is `base`.
    commit(&t, &sid(), vec![user("msg_1l5m2o0_u1", "hi")]).await;
    let end = base + 8 * DAY;
    t.source.at(end);
    commit(&t, &sid(), vec![model_call_at("msg_a1", end - 1_000)]).await;
    t.source.at(end + 60_000);
    commit(
        &t,
        &sid(),
        vec![Fact::TurnEnded {
            status: CallStatus::Completed,
        }],
    )
    .await;
    t.source.at(end + 120_000);
    assert_eq!(all_time(&t).await.turn_totals.total_turns, 1);
}

/// Another process (the Node agent) updated a live raw row in a bucket that also holds an erased
/// session's protected baseline. The prune reconciles before it deletes, however fresh the
/// watermark, so the update is kept.
#[tokio::test]
async fn the_prune_keeps_another_process_update_in_a_protected_bucket() {
    let t = TestStore::new();
    let erased = SessionId::new("sess_erased");
    started(&t, "sess_erased").await;
    started(&t, "sess_1").await;
    commit(&t, &erased, vec![user("msg_e1", "hi")]).await;
    commit(&t, &erased, vec![model_call_at("msg_e2", 2_000)]).await;
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    commit(&t, &sid(), vec![model_call_at("msg_a1", 2_500)]).await;
    t.source.at(10_000);
    assert_eq!(all_time(&t).await.totals.total_tokens, 40);
    // A month later the erase recomputes (fresh watermark) and protects the shared bucket.
    let later = 31 * DAY;
    t.source.at(later);
    StoreQueries::erase_session_tree(&t.store, vec!["sess_erased".to_owned()])
        .await
        .unwrap();
    // Node upserts the live row (5 more output tokens) and has not reconciled yet.
    t.connection()
        .execute_batch(
            "update model_usage set output_tokens = output_tokens + 5,
               computed_total_tokens = computed_total_tokens + 5
             where logical_request_id = 'msg_a1'",
        )
        .unwrap();
    // A Rust usage batch prunes the live row.
    t.source.at(later + 60_000);
    commit(&t, &sid(), vec![model_call_at("msg_a2", later + 30_000)]).await;
    assert_eq!(
        t.rows("select logical_request_id from model_usage"),
        vec![vec![json!("msg_a2")]]
    );
    // 20 (erased) + 25 (updated live row) + 20 (new row).
    assert_eq!(all_time(&t).await.totals.total_tokens, 65);
}

/// A failed reconcile keeps the raw rows: that batch does not prune.
#[tokio::test]
async fn a_failed_reconcile_skips_the_raw_prune() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    commit(&t, &sid(), vec![user("msg_u1", "hi")]).await;
    commit(&t, &sid(), vec![model_call_at("msg_a1", 2_000)]).await;
    t.source.at(2_000 + 31 * DAY);
    all_time(&t).await;
    // Break the reconcile: a view in place of a protected snapshot table makes its delete fail.
    t.connection()
        .execute_batch(
            "drop table fork_usage_protected_tool_raw;
             create view fork_usage_protected_tool_raw as select 1 as raw_id;",
        )
        .unwrap();
    commit(
        &t,
        &sid(),
        vec![model_call_at("msg_a2", 2_000 + 31 * DAY - 1_000)],
    )
    .await;
    assert_eq!(
        t.rows("select logical_request_id from model_usage order by started_at"),
        vec![vec![json!("msg_a1")], vec![json!("msg_a2")]]
    );
}
