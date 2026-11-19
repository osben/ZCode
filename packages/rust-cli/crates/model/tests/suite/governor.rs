//! 准入在请求路径上的行为（F5 W6b 第一部分）：每次尝试取票、429 与过载压低桶、成功结算、主代理不排队、
//! 子代理排队且取消时离开队列、不占名额。

#![allow(
    clippy::unwrap_used,
    reason = "辅助函数不在 #[test] 函数里，clippy 的测试放行不覆盖它；失败即测试失败"
)]

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_base::models;
use rust_cli_kernel_api::model::{ModelError, ModelEvent, ModelPort, QuerySource};
use rust_cli_model::admission::{
    AdmissionScope, AdmissionTicket, ParentSessionId, RequestAdmission, RunId,
};
use rust_cli_model::governor::{Governor, model_key};
use rust_cli_model::{ByteIdle, ProviderModel, RouteOptions, StreamIdle};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::common::{
    block_start, clock, delta, event, fast_retry, message_start, model_with, request, text_response,
};
use super::fixture::{Fixture, Reply};

const PROVIDER: &str = "anthropic";

fn key() -> String {
    model_key(PROVIDER, models::GLM_5_3)
}

fn governor(default: u32) -> Arc<Governor> {
    Governor::new(clock(), default, Arc::new(|_, _| {}))
}

async fn governed(base_url: String, governor: &Arc<Governor>) -> Arc<ProviderModel> {
    governed_with_retries(base_url, governor, 2).await
}

async fn governed_with_retries(
    base_url: String,
    governor: &Arc<Governor>,
    retries: u32,
) -> Arc<ProviderModel> {
    let admission: Arc<dyn RequestAdmission> = governor.clone();
    Arc::new(
        model_with(
            base_url,
            RouteOptions {
                retry: fast_retry(retries),
                admission: Some(admission),
                ..RouteOptions::default()
            },
        )
        .await,
    )
}

fn stream_reply(body: String) -> Reply {
    Reply::new(200)
        .header("content-type", "text/event-stream")
        .send(body)
}

fn ok() -> Reply {
    stream_reply(text_response(&["ok"]))
}

fn all_completed(events: &[Result<ModelEvent, ModelError>]) -> bool {
    events.iter().all(Result::is_ok) && !events.is_empty()
}

#[tokio::test]
async fn a_429_halves_the_bucket_and_the_retry_completes_on_the_same_bucket() {
    let server = Fixture::start(vec![
        Reply::new(429)
            .send(r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#),
        ok(),
    ])
    .await;
    let governor = governor(8);
    let model = governed(server.url(), &governor).await;

    let events: Vec<_> = model
        .stream(
            request("hi", QuerySource::MainThread),
            CancellationToken::new(),
        )
        .collect()
        .await;
    assert!(
        all_completed(&events),
        "the retried request completes: {events:?}"
    );
    let snapshot = governor.snapshot(&key()).unwrap();
    assert_eq!(snapshot.cap, 6, "the 429 took the bucket from 8 to 6");
    assert_eq!(snapshot.in_flight, 0, "every attempt released its slot");
}

#[tokio::test]
async fn an_overload_halves_the_bucket_too() {
    let server = Fixture::start(vec![
        Reply::new(529)
            .send(r#"{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#),
        ok(),
    ])
    .await;
    let governor = governor(8);
    let model = governed(server.url(), &governor).await;

    let events: Vec<_> = model
        .stream(
            request("hi", QuerySource::MainThread),
            CancellationToken::new(),
        )
        .collect()
        .await;
    assert!(
        all_completed(&events),
        "the retried request completes: {events:?}"
    );
    assert_eq!(governor.snapshot(&key()).unwrap().cap, 6);
}

#[tokio::test]
async fn a_success_settles_the_attempt_and_counts_one_success_on_the_bucket() {
    let server = Fixture::start(vec![ok()]).await;
    let governor = governor(8);
    let model = governed(server.url(), &governor).await;

    let events: Vec<_> = model
        .stream(
            request("hi", QuerySource::MainThread),
            CancellationToken::new(),
        )
        .collect()
        .await;
    assert!(all_completed(&events));
    let snapshot = governor.snapshot(&key()).unwrap();
    assert_eq!((snapshot.in_flight, snapshot.success_streak), (0, 1));
}

#[tokio::test]
async fn the_main_thread_never_waits_for_a_slot() {
    let server = Fixture::start(vec![ok()]).await;
    let governor = governor(1);
    let held = governor
        .try_admit(&AdmissionScope::Run("workflow".into()), &key())
        .expect("the one slot is free");

    let model = governed(server.url(), &governor).await;
    let events: Vec<_> = model
        .stream(
            request("hi", QuerySource::MainThread),
            CancellationToken::new(),
        )
        .collect()
        .await;
    assert!(
        all_completed(&events),
        "the observer is admitted while the slot is held"
    );
    drop(held);
}

#[tokio::test]
async fn a_subagent_request_waits_for_a_slot_and_a_cancel_leaves_the_queue_and_the_slots_alone() {
    let server = Fixture::start(vec![ok()]).await;
    let governor = governor(1);
    let held = governor
        .try_admit(&AdmissionScope::Run("workflow".into()), &key())
        .expect("the one slot is free");

    let model = governed(server.url(), &governor).await;
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let subagent = tokio::spawn({
        let model = model.clone();
        async move {
            model
                .stream(
                    request("sub", QuerySource::Subagent("explore".into())),
                    token,
                )
                .collect::<Vec<_>>()
                .await
        }
    });
    // The subagent is queued behind the held slot: it has not finished, and nothing reached the server.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!subagent.is_finished());
    assert_eq!(governor.snapshot(&key()).unwrap().waiters, 1);

    cancel.cancel();
    let events = subagent.await.unwrap();
    assert!(
        matches!(events.last(), Some(Err(ModelError::Cancelled))),
        "the cancelled wait ends the request: {events:?}"
    );
    let snapshot = governor.snapshot(&key()).unwrap();
    assert_eq!((snapshot.waiters, snapshot.in_flight), (0, 1));
    assert!(
        server.requests().is_empty(),
        "the cancelled request never sent"
    );

    drop(held);
    assert_eq!(governor.snapshot(&key()).unwrap().in_flight, 0);
}

#[tokio::test]
async fn a_subagent_request_is_admitted_once_the_slot_frees() {
    let server = Fixture::start(vec![ok()]).await;
    let governor = governor(1);
    let held = governor
        .try_admit(&AdmissionScope::Run("workflow".into()), &key())
        .expect("the one slot is free");

    let model = governed(server.url(), &governor).await;
    let subagent = tokio::spawn({
        let model = model.clone();
        async move {
            model
                .stream(
                    request("sub", QuerySource::Subagent("explore".into())),
                    CancellationToken::new(),
                )
                .collect::<Vec<_>>()
                .await
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!subagent.is_finished());
    drop(held);
    let events = subagent.await.unwrap();
    assert!(
        all_completed(&events),
        "the queued subagent is admitted: {events:?}"
    );
}

/// 流中途出现的限流（Codex P2）：文本已经交出，之后的 SSE 限流错误也要计入桶（Node 对终态限流同样减 cap）。
#[tokio::test]
async fn a_rate_limit_after_output_has_started_still_halves_the_bucket() {
    let mut body = message_start();
    body.push_str(&block_start(
        0,
        serde_json::json!({"type": "text", "text": ""}),
    ));
    body.push_str(&delta(
        0,
        serde_json::json!({"type": "text_delta", "text": "partial"}),
    ));
    body.push_str(&event(serde_json::json!({
        "type": "error",
        "error": {"type": "rate_limit_error", "message": "slow down"}
    })));
    let server = Fixture::start(vec![
        Reply::new(200)
            .header("content-type", "text/event-stream")
            .send(body),
    ])
    .await;
    let governor = governor(8);
    let model = governed(server.url(), &governor).await;

    let events: Vec<_> = model
        .stream(
            request("hi", QuerySource::MainThread),
            CancellationToken::new(),
        )
        .collect()
        .await;
    assert!(
        matches!(events.last(), Some(Err(ModelError::RateLimited { .. }))),
        "the rate limit reaches the caller: {events:?}"
    );
    assert_eq!(governor.snapshot(&key()).unwrap().cap, 6);
}

/// 529 带 Retry-After（Codex P2）：过载的冷却要用响应头里的时长（Node 把 overload 的 retryAfterMs 带进桶）。
#[tokio::test]
async fn an_overload_with_retry_after_puts_that_cooldown_on_the_bucket() {
    let server =
        Fixture::start(vec![Reply::new(529).header("retry-after", "30").send(
            r#"{"type":"error","error":{"type":"overloaded_error","message":"busy"}}"#,
        )])
        .await;
    let governor = governor(8);
    let model = governed_with_retries(server.url(), &governor, 0).await;

    let _: Vec<_> = model
        .stream(
            request("hi", QuerySource::MainThread),
            CancellationToken::new(),
        )
        .collect()
        .await;
    let snapshot = governor.snapshot(&key()).unwrap();
    let now = clock().now_ms();
    let until = snapshot
        .cooldown_until
        .expect("the overload set a cooldown");
    assert!(
        until >= now + 30_000,
        "the cooldown is at least Retry-After from now: {until} vs {now}"
    );
}

/// 越过交出边界之后的终态流空闲，尝试按瞬时失败结算：清掉连续成功数（与可重试的停顿一致；ocr #560 P1）。
#[tokio::test]
async fn a_terminal_stall_settles_the_attempt_as_transient_and_clears_the_streak() {
    let partial = format!(
        "{}{}{}",
        message_start(),
        block_start(0, json!({"type": "text", "text": ""})),
        delta(0, json!({"type": "text_delta", "text": "par"}))
    );
    let server = Fixture::start(vec![
        ok(),
        Reply::new(200)
            .header("content-type", "text/event-stream")
            .send(partial)
            .hang(),
    ])
    .await;
    let governor = governor(8);
    let admission: Arc<dyn RequestAdmission> = governor.clone();
    let model = Arc::new(
        model_with(
            server.url(),
            RouteOptions {
                retry: fast_retry(2),
                idle: StreamIdle {
                    events: Some(Duration::from_secs(10)),
                    bytes: Some(ByteIdle::Fixed(Duration::from_millis(150))),
                    stall_notice: Duration::from_millis(50),
                },
                admission: Some(admission),
                ..RouteOptions::default()
            },
        )
        .await,
    );

    let first: Vec<_> = model
        .stream(
            request("hi", QuerySource::MainThread),
            CancellationToken::new(),
        )
        .collect()
        .await;
    assert!(all_completed(&first));
    assert_eq!(governor.snapshot(&key()).unwrap().success_streak, 1);

    let second: Vec<_> = model
        .stream(
            request("hi", QuerySource::MainThread),
            CancellationToken::new(),
        )
        .collect()
        .await;
    assert!(
        matches!(second.last(), Some(Err(ModelError::StreamIdle { .. }))),
        "the stall after output is terminal: {second:?}"
    );
    let snapshot = governor.snapshot(&key()).unwrap();
    assert_eq!(
        snapshot.success_streak, 0,
        "a terminal stall is a transient failure"
    );
    assert_eq!(snapshot.in_flight, 0);
}

/// Records the scope of each acquire, then admits through the governor.
struct Recording {
    inner: Arc<Governor>,
    scopes: std::sync::Mutex<Vec<AdmissionScope>>,
}

impl RequestAdmission for Recording {
    fn acquire<'a>(
        &'a self,
        scope: AdmissionScope,
        key: String,
        cancel: CancellationToken,
    ) -> futures_util::future::BoxFuture<'a, Result<Box<dyn AdmissionTicket>, ModelError>> {
        self.scopes.lock().unwrap().push(scope.clone());
        self.inner.acquire(scope, key, cancel)
    }
}

/// Node: a workflow actor's requests are admitted under their run (the run queue and bound), not the session
/// subagent pool. A request that names its run takes the run scope; a subagent without one keeps the pool.
#[tokio::test]
async fn a_workflow_actors_request_is_admitted_under_its_run() {
    let server = Fixture::start(vec![ok(), ok()]).await;
    let recording = Arc::new(Recording {
        inner: governor(4),
        scopes: std::sync::Mutex::new(Vec::new()),
    });
    let admission: Arc<dyn RequestAdmission> = recording.clone();
    let model = Arc::new(
        model_with(
            server.url(),
            RouteOptions {
                retry: fast_retry(2),
                admission: Some(admission),
                ..RouteOptions::default()
            },
        )
        .await,
    );

    let mut actor = request("actor", QuerySource::Subagent("workflow_actor".into()));
    actor.options.admission_run = Some("wf_1".into());
    let events = model
        .stream(actor, CancellationToken::new())
        .collect::<Vec<_>>()
        .await;
    assert!(all_completed(&events), "{events:?}");

    let plain = request("plain", QuerySource::Subagent("explore".into()));
    let events = model
        .stream(plain, CancellationToken::new())
        .collect::<Vec<_>>()
        .await;
    assert!(all_completed(&events), "{events:?}");

    let scopes = recording.scopes.lock().unwrap().clone();
    assert_eq!(
        scopes,
        vec![
            AdmissionScope::Run(RunId::new("wf_1")),
            AdmissionScope::SessionSubagents(ParentSessionId::default()),
        ]
    );
}
