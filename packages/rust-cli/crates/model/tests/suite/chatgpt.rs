//! Fork: ChatGPT Plan endpoints on the wire (specs/fork-rust-chatgpt-plan.md R9-R13): one renewal per request,
//! the shaping patch, gzip over the threshold and the plan error codes.

#![allow(
    clippy::unwrap_used,
    reason = "helpers and doubles are outside #[test] functions; a failure fails the test"
)]

use std::io::Read as _;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_base::secret::RedactedString;
use rust_cli_kernel_api::model::{ModelError, QuerySource};
use rust_cli_kernel_api::provider::{
    Credential, EndpointQuery, ModelCapabilities, ModelEndpoint, ModelEndpoints, WireProtocol,
};
use rust_cli_model::{ProviderModel, RouteOptions};
use rust_cli_net::{Egress, NetworkPolicy};
use serde_json::{Value, json};

use rust_cli_kernel_api::message::ContentBlock;
use rust_cli_kernel_api::model::ModelEvent;

use super::common::{assemble, clock, collect, fast_retry, request};
use super::fixture::{Fixture, Reply};

const MODEL: &str = "gpt-6.1-sol";

/// The trailing patch the platform appends for a non-reasoning ChatGPT Plan model (`chatgpt::request_patch`).
fn shaping() -> Value {
    let mut patch = json!({"store": false, "stream": true, "include": null});
    for field in [
        "background",
        "conversation",
        "max_output_tokens",
        "max_completion_tokens",
        "max_tool_calls",
        "metadata",
        "moderation",
        "multi_agent",
        "prompt",
        "prompt_cache_retention",
        "safety_identifier",
        "temperature",
        "top_logprobs",
        "top_p",
        "truncation",
        "user",
        "previous_response_id",
    ] {
        patch[field] = Value::Null;
    }
    patch
}

/// A ChatGPT Plan account endpoint: every fetch issues the next token and records the rejected one.
struct Plan {
    base_url: String,
    compress_body_over: Option<usize>,
    issued: Mutex<u32>,
    rejected: Mutex<Vec<String>>,
}

impl Plan {
    fn new(base_url: String, compress_body_over: Option<usize>) -> Arc<Self> {
        Arc::new(Self {
            base_url,
            compress_body_over,
            issued: Mutex::new(0),
            rejected: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl ModelEndpoints for Plan {
    async fn endpoint(&self, query: EndpointQuery<'_>) -> Result<ModelEndpoint, ModelError> {
        if let Some(Credential::ApiKey(key)) = query.rejected.map(|endpoint| &endpoint.credential) {
            self.rejected.lock().unwrap().push(key.expose().to_owned());
        }
        let mut issued = self.issued.lock().unwrap();
        *issued += 1;
        Ok(ModelEndpoint {
            protocol: WireProtocol::OpenAiResponses,
            base_url: self.base_url.clone(),
            model: MODEL.to_owned(),
            credential: Credential::ApiKey(RedactedString::new(format!("token-{issued}"))),
            headers: Vec::new(),
            body_patches: vec![json!({"max_output_tokens": 128_000}), shaping()],
            capabilities: ModelCapabilities::default(),
            renewable: true,
            compress_body_over: self.compress_body_over,
        })
    }
}

async fn model(endpoints: Arc<Plan>, retries: u32) -> ProviderModel {
    let egress = Arc::new(Egress::new(NetworkPolicy::default()).await.unwrap());
    ProviderModel::new(
        egress,
        endpoints,
        clock(),
        RouteOptions {
            retry: fast_retry(retries),
            ..RouteOptions::default()
        },
    )
}

fn completed() -> Reply {
    let events = [
        json!({"type": "response.created", "response": {"id": "r1", "model": MODEL}}),
        json!({"type": "response.output_item.added", "output_index": 0, "item": {"id": "m1", "type": "message"}}),
        json!({"type": "response.output_text.delta", "output_index": 0, "item_id": "m1", "delta": "ok"}),
        json!({"type": "response.output_item.done", "output_index": 0, "item": {"id": "m1", "type": "message"}}),
        json!({"type": "response.completed", "response": {"usage": {"input_tokens": 5, "output_tokens": 1}}}),
    ];
    let text: String = events
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .collect();
    Reply::new(200)
        .header("content-type", "text/event-stream")
        .send(text)
}

/// The stream produced the whole completed turn (not just no error: an empty stream is no error either).
fn assert_answered(events: &[Result<ModelEvent, ModelError>]) {
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    assert!(
        matches!(assemble(events).as_slice(), [ContentBlock::Text { text, .. }] if text == "ok"),
        "{events:?}"
    );
}

fn plan_error(status: u16, code: &str) -> Reply {
    Reply::new(status).send(
        json!({"error": {"message": "server text", "type": "invalid_request_error", "code": code}})
            .to_string(),
    )
}

/// R9: the Host's refreshed token is rejected too, so the request ends after one renewal (no third attempt).
#[tokio::test]
async fn a_second_rejection_after_the_renewal_ends_the_request() {
    let server = Fixture::start(vec![
        plan_error(401, "subscription_sharing_invalid_user"),
        plan_error(401, "subscription_sharing_invalid_user"),
        completed(),
    ])
    .await;
    let endpoints = Plan::new(format!("{}/v1", server.url()), None);
    let model = model(endpoints.clone(), 5).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_eq!(
        events,
        vec![Err(ModelError::Authentication {
            message: "The ChatGPT plan no longer accepts this account. Sign in again with zcode login chatgpt."
                .to_owned(),
        })]
    );
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].header("authorization"), Some("Bearer token-1"));
    assert_eq!(requests[1].header("authorization"), Some("Bearer token-2"));
    assert_eq!(*endpoints.rejected.lock().unwrap(), ["token-1"]);
}

/// A plan code at 401 is renewed once (status based, like Node); the request then ends with the code's own error.
#[tokio::test]
async fn a_usage_limit_at_401_ends_with_the_quota_error_after_one_renewal() {
    let server = Fixture::start(vec![
        plan_error(401, "subscription_sharing_usage_limit_exceeded"),
        plan_error(401, "subscription_sharing_usage_limit_exceeded"),
        completed(),
    ])
    .await;
    let endpoints = Plan::new(format!("{}/v1", server.url()), None);
    let model = model(endpoints.clone(), 5).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert!(
        matches!(events.as_slice(), [Err(ModelError::QuotaExhausted { message })] if message.starts_with("ChatGPT plan usage limit reached.")),
        "{events:?}"
    );
    assert_eq!(server.requests().len(), 2);
    assert_eq!(*endpoints.rejected.lock().unwrap(), ["token-1"]);
}

/// R10 (wire half; the patch itself is checked in the platform): the option-map `max_output_tokens` and the
/// encoder's `include` are gone, `store: false` and `stream: true` stay.
#[tokio::test]
async fn the_shaping_patch_wins_over_the_option_maps() {
    let server = Fixture::start(vec![completed()]).await;
    let model = model(Plan::new(format!("{}/v1", server.url()), None), 1).await;
    let mut hi = request("hi", QuerySource::MainThread);
    hi.temperature = Some(0.5);
    let events = collect(&model, hi).await;
    assert_answered(&events);
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    let body: Value = serde_json::from_str(&requests[0].body).unwrap();
    for field in ["max_output_tokens", "temperature", "include"] {
        assert!(body.get(field).is_none(), "{field} in {body}");
    }
    assert_eq!(body["store"], false);
    assert_eq!(body["stream"], true);
    assert_eq!(body["model"], MODEL);
}

/// The plain body of one request, captured without compression.
async fn plain_body(text: &str) -> Vec<u8> {
    let server = Fixture::start(vec![completed()]).await;
    let model = model(Plan::new(format!("{}/v1", server.url()), None), 1).await;
    assert_answered(&collect(&model, request(text, QuerySource::MainThread)).await);
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    requests[0].raw.clone()
}

/// R11: a body over the threshold goes out gzip-compressed; one exactly at the threshold stays plain.
#[tokio::test]
async fn bodies_over_the_threshold_are_gzipped() {
    let long = "x".repeat(4096);
    let plain = plain_body(&long).await;
    for (threshold, gzipped) in [(plain.len() - 1, true), (plain.len(), false)] {
        let server = Fixture::start(vec![completed()]).await;
        let model = model(
            Plan::new(format!("{}/v1", server.url()), Some(threshold)),
            1,
        )
        .await;
        assert_answered(&collect(&model, request(&long, QuerySource::MainThread)).await);
        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        if !gzipped {
            assert_eq!(requests[0].header("content-encoding"), None);
            assert_eq!(requests[0].raw, plain);
            continue;
        }
        assert_eq!(requests[0].header("content-encoding"), Some("gzip"));
        let mut decoded = Vec::new();
        flate2::read::GzDecoder::new(requests[0].raw.as_slice())
            .read_to_end(&mut decoded)
            .unwrap();
        assert_eq!(decoded, plain);
        assert!(requests[0].raw.len() < plain.len());
    }
}

/// R12: the plan usage limit is final: one request, the Node text, no retry.
#[tokio::test]
async fn the_usage_limit_is_not_retried() {
    let server = Fixture::start(vec![
        plan_error(429, "subscription_sharing_usage_limit_exceeded"),
        completed(),
    ])
    .await;
    let model = model(Plan::new(format!("{}/v1", server.url()), None), 3).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert!(
        matches!(events.as_slice(), [Err(ModelError::QuotaExhausted { message })] if message.starts_with("ChatGPT plan usage limit reached.")),
        "{events:?}"
    );
    assert_eq!(server.requests().len(), 1);
}

/// R13: a temporarily unavailable plan service is retried with backoff and keeps the credential.
#[tokio::test]
async fn an_unavailable_plan_service_is_retried() {
    let server = Fixture::start(vec![
        plan_error(503, "subscription_sharing_usage_unavailable"),
        completed(),
    ])
    .await;
    let endpoints = Plan::new(format!("{}/v1", server.url()), None);
    let model = model(endpoints.clone(), 3).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert_answered(&events);
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].header("authorization"), Some("Bearer token-1"));
    assert!(endpoints.rejected.lock().unwrap().is_empty());
}
