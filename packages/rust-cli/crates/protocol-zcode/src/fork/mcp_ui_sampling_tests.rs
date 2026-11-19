//! Fork (F7 PR 2): the sampling ledger, ported from Node `samplingCalls.test.ts` (the same seven cases in the same
//! order), and the request limits of `mcpAppsSamplingParamsSchema`.

use std::future::Future;
use std::time::Duration;

use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{MAX_OPERATIONS, Sampling, Scope, check_request};

/// A lease the test owns: its token, session and cancel signal.
struct Owned {
    lease: String,
    session: String,
    cancel: CancellationToken,
}

impl Owned {
    fn new(lease: &str, session: &str) -> Self {
        Self::with_cancel(lease, session, CancellationToken::new())
    }

    fn with_cancel(lease: &str, session: &str, cancel: CancellationToken) -> Self {
        Self {
            lease: lease.to_owned(),
            session: session.to_owned(),
            cancel,
        }
    }

    fn scope(&self) -> Scope<'_> {
        Scope {
            lease: &self.lease,
            session: &self.session,
            cancel: &self.cancel,
        }
    }
}

/// A run that never settles on its own, so only the ledger can end it.
fn never() -> impl Future<Output = Result<i64, RpcError>> {
    std::future::pending()
}

#[tokio::test]
async fn cancels_before_admission_and_rejects_all_duplicate_completions() {
    let sampling = Sampling::new();
    let s = Owned::new("one", "session");
    assert!(!sampling.cancel(&s.scope(), "early").expect("recorded"));
    let duplicate = sampling.admit(&s.scope(), "early").err().expect("refused");
    assert!(duplicate.message.contains("Duplicate"));

    let admission = sampling.admit(&s.scope(), "ok").expect("admitted");
    let value = admission
        .run(|_| async { Ok::<_, RpcError>(1) })
        .await
        .expect("runs");
    assert_eq!(value, 1);
    let again = sampling.admit(&s.scope(), "ok").err().expect("refused");
    assert!(again.message.contains("Duplicate"));
    assert!(!sampling.cancel(&s.scope(), "ok").expect("recorded"));
}

#[tokio::test]
async fn aborts_execution_immediately_drops_late_success_and_frees_capacity() {
    let sampling = Sampling::new();
    let s = Owned::new("one", "session");
    let (gate_tx, gate_rx) = tokio::sync::oneshot::channel::<i64>();
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<CancellationToken>();
    let admission = sampling.admit(&s.scope(), "a").expect("admitted");
    let first = tokio::spawn(admission.run(move |signal| async move {
        let _ = seen_tx.send(signal);
        let value = gate_rx
            .await
            .map_err(|_| RpcError::internal("gate dropped"))?;
        Ok::<i64, RpcError>(value)
    }));
    let signal = seen_rx.await.expect("the run started");

    assert!(sampling.cancel(&s.scope(), "a").expect("cancelled"));
    // The model answers late: the late success is dropped, the operation stays cancelled.
    let _ = gate_tx.send(5);
    let error = first.await.expect("joins").expect_err("cancelled");
    assert!(error.message.contains("cancelled"));
    assert!(signal.is_cancelled());

    let next = sampling.admit(&s.scope(), "b").expect("capacity is free");
    let value = next
        .run(|_| async { Ok::<_, RpcError>(2) })
        .await
        .expect("runs");
    assert_eq!(value, 2);
}

#[tokio::test]
async fn closes_the_original_instance_without_touching_its_replacement() {
    let sampling = Sampling::new();
    let close = CancellationToken::new();
    let old = Owned::with_cancel("old", "session", close.clone());
    let admission = sampling.admit(&old.scope(), "same").expect("admitted");
    let pending = tokio::spawn(admission.run(|_| never()));

    close.cancel();
    let replacement = Owned::new("new", "session");
    let admission = sampling
        .admit(&replacement.scope(), "same")
        .expect("the replacement admits the same id");
    let value = admission
        .run(|_| async { Ok::<_, RpcError>(7) })
        .await
        .expect("runs");
    assert_eq!(value, 7);

    let error = pending.await.expect("joins").expect_err("cancelled");
    assert!(error.message.contains("cancelled"));
    assert!(sampling.admit(&old.scope(), "later").is_err());
}

#[tokio::test(start_paused = true)]
async fn enforces_instance_session_and_global_caps_and_releases_on_cancellation() {
    let sampling = Sampling::new();
    let scopes: Vec<Owned> = (0..8)
        .map(|i| Owned::new(&i.to_string(), if i < 4 { "a" } else { "b" }))
        .collect();
    let mut waiting = Vec::new();
    for s in &scopes {
        let admission = sampling
            .admit(&s.scope(), "x")
            .expect("admitted under the caps");
        waiting.push(tokio::spawn(admission.run(|_| never())));
    }

    // The lease already has an operation in flight.
    let busy = sampling.admit(&scopes[0].scope(), "y").err().expect("busy");
    assert!(busy.message.contains("busy"));
    // Session "a" is at its cap of four.
    let session_full = Owned::new("session-full", "a");
    let busy = sampling
        .admit(&session_full.scope(), "y")
        .err()
        .expect("busy");
    assert!(busy.message.contains("busy"));
    // The agent is at its cap of eight.
    let agent_full = Owned::new("agent-full", "c");
    let busy = sampling
        .admit(&agent_full.scope(), "y")
        .err()
        .expect("busy");
    assert!(busy.message.contains("busy"));

    for s in &scopes {
        assert!(sampling.cancel(&s.scope(), "x").expect("cancelled"));
    }
    for handle in waiting {
        let error = handle.await.expect("joins").expect_err("cancelled");
        assert!(error.message.contains("cancelled"));
    }
    let next = Owned::new("next", "n");
    let admission = sampling
        .admit(&next.scope(), "y")
        .expect("the quota is back");
    let value = admission
        .run(|_| async { Ok::<_, RpcError>(4) })
        .await
        .expect("runs");
    assert_eq!(value, 4);
}

#[tokio::test(start_paused = true)]
async fn has_an_absolute_deadline_even_if_the_model_never_settles() {
    let sampling = Sampling::new();
    let s = Owned::new("one", "session");
    let admission = sampling.admit(&s.scope(), "timeout").expect("admitted");
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<CancellationToken>();
    let handle = tokio::spawn(admission.run(move |signal| async move {
        let _ = seen_tx.send(signal);
        never().await
    }));
    let signal = seen_rx.await.expect("the model call started");

    tokio::time::advance(Duration::from_secs(59)).await;
    assert!(!handle.is_finished());
    tokio::time::advance(Duration::from_secs(1)).await;
    let error = handle.await.expect("joins").expect_err("timed out");
    assert!(error.message.contains("timed out"));
    assert!(signal.is_cancelled());
}

#[tokio::test]
async fn bounds_terminal_history_without_forgetting_cancelled_ids() {
    let sampling = Sampling::new();
    let s = Owned::new("bounded", "session");
    for i in 0..MAX_OPERATIONS {
        assert!(
            !sampling
                .cancel(&s.scope(), &format!("op-{i}"))
                .expect("recorded")
        );
    }
    let limit = sampling.cancel(&s.scope(), "overflow").expect_err("limit");
    assert!(limit.message.contains("limit"));
    let duplicate = sampling.admit(&s.scope(), "op-0").err().expect("refused");
    assert!(duplicate.message.contains("Duplicate"));
    let limit = sampling.admit(&s.scope(), "overflow").err().expect("limit");
    assert!(limit.message.contains("limit"));

    let replacement = Owned::new("replacement", "session");
    let admission = sampling
        .admit(&replacement.scope(), "op-0")
        .expect("a new lease");
    let value = admission
        .run(|_| async { Ok::<_, RpcError>(2) })
        .await
        .expect("runs");
    assert_eq!(value, 2);
}

fn request() -> Value {
    json!({
        "messages": [{"role": "user", "content": {"type": "text", "text": "hi"}}],
        "maxTokens": 16,
    })
}

fn refused(request: &Value) -> String {
    check_request(request)
        .expect_err("the request is refused")
        .message
}

#[test]
fn a_plain_text_request_passes() {
    check_request(&request()).expect("valid");
}

#[test]
fn messages_must_be_present_and_at_most_64() {
    let mut empty = request();
    empty["messages"] = json!([]);
    refused(&empty);

    let mut many = request();
    many["messages"] = json!(
        (0..65)
            .map(|_| json!({"role": "user", "content": {"type": "text", "text": "a"}}))
            .collect::<Vec<_>>()
    );
    refused(&many);
}

#[test]
fn blocks_are_at_most_64_in_one_content_and_in_total() {
    let text = |n: usize| {
        (0..n)
            .map(|_| json!({"type": "text", "text": "a"}))
            .collect::<Vec<_>>()
    };
    let mut one = request();
    one["messages"] = json!([{"role": "user", "content": text(65)}]);
    refused(&one);

    let mut total = request();
    total["messages"] = json!([
        {"role": "user", "content": text(40)},
        {"role": "assistant", "content": text(40)},
    ]);
    refused(&total);
}

#[test]
fn unknown_roles_and_keys_are_refused() {
    let mut role = request();
    role["messages"][0]["role"] = json!("system");
    refused(&role);

    let mut key = request();
    key["tools"] = json!([]);
    refused(&key);
}

#[test]
fn the_byte_budget_counts_text_and_metadata() {
    let big = "a".repeat(5 * 1024 * 1024);
    let mut two_texts = request();
    two_texts["messages"] = json!([
        {"role": "user", "content": {"type": "text", "text": big}},
        {"role": "user", "content": {"type": "text", "text": big}},
    ]);
    refused(&two_texts);

    let mut metadata = request();
    metadata["metadata"] = json!({"padding": "b".repeat(9 * 1024 * 1024)});
    refused(&metadata);
}

#[test]
fn images_must_be_allowed_types_with_base64_within_the_size() {
    let image = |mime: &str, data: &str| {
        let mut req = request();
        req["messages"] = json!([{
            "role": "user",
            "content": {"type": "image", "mimeType": mime, "data": data},
        }]);
        req
    };
    check_request(&image("image/png", "iVBORw0KGgo=")).expect("a small png");
    refused(&image("image/gif", "iVBORw0KGgo="));
    refused(&image("image/png", "not base64!"));
    // 4 MiB + 3 bytes decoded: the data has the largest length the schema allows, and it is too big.
    refused(&image("image/png", &"A".repeat(5_592_408)));
}

#[test]
fn max_tokens_must_be_a_positive_integer() {
    let mut zero = request();
    zero["maxTokens"] = json!(0);
    refused(&zero);

    let mut missing = request();
    missing.as_object_mut().expect("object").remove("maxTokens");
    refused(&missing);
}

#[test]
fn include_context_other_than_none_is_refused() {
    let mut context = request();
    context["includeContext"] = json!("allServers");
    refused(&context);
    let mut none = request();
    none["includeContext"] = json!("none");
    check_request(&none).expect("none is allowed");
}
