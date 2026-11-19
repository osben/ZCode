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
use rust_cli_model::admission::{AdmissionScope, RequestAdmission};
use rust_cli_model::governor::{Governor, model_key};
use rust_cli_model::{ProviderModel, RouteOptions};
use tokio_util::sync::CancellationToken;

use super::common::{clock, fast_retry, model_with, request, text_response};
use super::fixture::{Fixture, Reply};

const PROVIDER: &str = "anthropic";

fn key() -> String {
    model_key(PROVIDER, models::GLM_5_3)
}

fn governor(default: u32) -> Arc<Governor> {
    Governor::new(clock(), default, Arc::new(|_, _| {}))
}

async fn governed(base_url: String, governor: &Arc<Governor>) -> Arc<ProviderModel> {
    let admission: Arc<dyn RequestAdmission> = governor.clone();
    Arc::new(
        model_with(
            base_url,
            RouteOptions {
                retry: fast_retry(2),
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
