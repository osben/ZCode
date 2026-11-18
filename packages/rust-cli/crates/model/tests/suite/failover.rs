//! 每请求取端点、401 后续期凭据、连续过载后切 fallback 模型、重试通知。

#![allow(
    clippy::unwrap_used,
    reason = "辅助函数与替身不在 #[test] 函数里，clippy 的测试放行不覆盖它；失败即测试失败"
)]

use rust_cli_base::models;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures_util::StreamExt;
use rust_cli_base::secret::RedactedString;
use rust_cli_kernel_api::model::{
    ModelError, ModelNotice, ModelPort, ModelStreamItem, QuerySource,
};
use rust_cli_kernel_api::provider::{
    Credential, EndpointQuery, ModelCapabilities, ModelEndpoint, ModelEndpoints, WireProtocol,
};
use rust_cli_model::{ProviderModel, RouteOptions};
use rust_cli_net::{Egress, NetworkPolicy};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::common::{clock, collect, fast_retry, model_at, model_with, request, text_response};
use super::fixture::{Fixture, Reply};

/// 账号模型的替身：每次取端点给出下一个令牌，并记下被拒的令牌。
struct Rotating {
    base_url: String,
    issued: Mutex<u32>,
    rejected: Mutex<Vec<String>>,
}

#[async_trait]
impl ModelEndpoints for Rotating {
    async fn endpoint(&self, query: EndpointQuery<'_>) -> Result<ModelEndpoint, ModelError> {
        let EndpointQuery {
            selection,
            rejected,
            ..
        } = query;
        if let Some(Credential::ApiKey(key)) = rejected.map(|endpoint| &endpoint.credential) {
            self.rejected.lock().unwrap().push(key.expose().to_owned());
        }
        let mut issued = self.issued.lock().unwrap();
        *issued += 1;
        Ok(ModelEndpoint {
            protocol: WireProtocol::AnthropicMessages,
            base_url: self.base_url.clone(),
            model: format!("{}-api", selection.model),
            credential: Credential::ApiKey(RedactedString::new(format!("token-{issued}"))),
            headers: Vec::new(),
            body_patches: Vec::new(),
            capabilities: ModelCapabilities {
                supports_mid_conversation_system: true,
                supports_image: true,
                ..ModelCapabilities::default()
            },
            renewable: true,
            compress_body_over: None,
        })
    }
}

/// A model on [`Rotating`] endpoints at the fixture.
async fn rotating(server: &Fixture, retries: u32) -> (Arc<Rotating>, ProviderModel) {
    let endpoints = Arc::new(Rotating {
        base_url: server.url(),
        issued: Mutex::new(0),
        rejected: Mutex::new(Vec::new()),
    });
    let egress = Arc::new(Egress::new(NetworkPolicy::default()).await.unwrap());
    let model = ProviderModel::new(
        egress,
        endpoints.clone(),
        clock(),
        RouteOptions {
            retry: fast_retry(retries),
            ..RouteOptions::default()
        },
    );
    (endpoints, model)
}

fn error(status: u16, kind: &str) -> Reply {
    Reply::new(status)
        .send(json!({"type": "error", "error": {"type": kind, "message": kind}}).to_string())
}

#[tokio::test]
async fn a_rejected_account_credential_is_renewed_once_per_failure() {
    let server = Fixture::start(vec![
        error(401, "authentication_error"),
        Reply::new(200).send(text_response(&["ok"])),
    ])
    .await;
    let (endpoints, model) = rotating(&server, 2).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    let requests = server.requests();
    assert_eq!(requests[0].header("x-api-key"), Some("token-1"));
    assert_eq!(requests[1].header("x-api-key"), Some("token-2"));
    // 请求体按端点给的模型 ID 编码，续期不重新编码。
    assert!(
        requests[1]
            .body
            .starts_with(&format!(r#"{{"model":"{}-api","#, models::GLM_5_3))
    );
    assert_eq!(*endpoints.rejected.lock().unwrap(), ["token-1"]);
}

/// Fork (specs/fork-rust-chatgpt-plan.md rule 10): one renewal per request for every renewable endpoint, like Node
/// `AccountRequestRetry`; the refreshed credential rejected again ends the request.
#[tokio::test]
async fn a_credential_rejected_again_after_the_renewal_ends_the_request() {
    let server = Fixture::start(vec![
        error(401, "authentication_error"),
        error(401, "authentication_error"),
        Reply::new(200).send(text_response(&["ok"])),
    ])
    .await;
    let (endpoints, model) = rotating(&server, 5).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert!(
        matches!(events.as_slice(), [Err(ModelError::Authentication { .. })]),
        "{events:?}"
    );
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].header("x-api-key"), Some("token-1"));
    assert_eq!(requests[1].header("x-api-key"), Some("token-2"));
    assert_eq!(*endpoints.rejected.lock().unwrap(), ["token-1"]);
}

#[tokio::test]
async fn repeated_overload_switches_to_the_fallback_model() {
    let replies = (0..3).map(|_| error(529, "overloaded_error")).collect();
    let server = Fixture::start(replies).await;
    let model = model_at(server.url(), fast_retry(10)).await;
    let mut with_fallback = request("hi", QuerySource::MainThread);
    with_fallback.options.fallback_model = Some(models::GLM_5_3_FLASH.to_owned());
    let events = collect(&model, with_fallback).await;
    assert_eq!(
        events,
        vec![Err(ModelError::FallbackTriggered {
            original_model: models::GLM_5_3.to_owned(),
            fallback_model: models::GLM_5_3_FLASH.to_owned(),
        })]
    );
    assert_eq!(server.requests().len(), 3);

    // 没有 fallback 时照常按重试上限重试。
    let replies = (0..4).map(|_| error(529, "overloaded_error")).collect();
    let server = Fixture::start(replies).await;
    let model = model_at(server.url(), fast_retry(3)).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert!(matches!(
        events.as_slice(),
        [Err(ModelError::Overloaded { .. })]
    ));
    assert_eq!(server.requests().len(), 4);
}

/// F10：opus 系列的主模型没有 fallback 时，第 3 次过载后不再重试，报 `Repeated 529 Overloaded
/// errors`（连续过载次数达到上限）；其他系列照常按重试上限重试（上一个测试）。
#[tokio::test]
async fn opus_models_stop_after_three_overloads_without_a_fallback() {
    let replies = (0..4).map(|_| error(529, "overloaded_error")).collect();
    let server = Fixture::start(replies).await;
    let model = model_at(server.url(), fast_retry(10)).await;
    let mut opus = request("hi", QuerySource::MainThread);
    opus.selection.model = models::OPUS_5_5.to_owned();
    let events = collect(&model, opus).await;
    assert_eq!(
        events,
        vec![Err(ModelError::Overloaded {
            message: "Repeated 529 Overloaded errors".to_owned(),
        })]
    );
    assert_eq!(server.requests().len(), 3);
}

/// 设了 `IS_SANDBOX` 时不报 `Repeated 529 Overloaded errors`，照常按重试上限重试
/// （docs/specs/rust-cli/cli-args.md §9）。
#[tokio::test]
async fn a_sandbox_keeps_retrying_overloaded_opus_requests() {
    let replies = (0..4).map(|_| error(529, "overloaded_error")).collect();
    let server = Fixture::start(replies).await;
    let model = model_with(
        server.url(),
        RouteOptions {
            retry: fast_retry(3),
            sandbox: true,
            ..RouteOptions::default()
        },
    )
    .await;
    let mut opus = request("hi", QuerySource::MainThread);
    opus.selection.model = models::OPUS_5_5.to_owned();
    let events = collect(&model, opus).await;
    assert!(matches!(
        events.as_slice(),
        [Err(ModelError::Overloaded { message })] if message != "Repeated 529 Overloaded errors"
    ));
    assert_eq!(server.requests().len(), 4);
}

#[tokio::test]
async fn retries_are_reported_as_notices() {
    let server = Fixture::start(vec![
        error(500, "api_error"),
        Reply::new(200).send(text_response(&["ok"])),
    ])
    .await;
    let model = model_at(server.url(), fast_retry(3)).await;
    let items: Vec<_> = model
        .stream_with_notices(
            request("hi", QuerySource::MainThread),
            CancellationToken::new(),
        )
        .collect()
        .await;
    match items.first() {
        Some(Ok(ModelStreamItem::Notice(ModelNotice::Retrying {
            attempt: 1,
            max_retries: 3,
            error: ModelError::Server { status: 500, .. },
            ..
        }))) => {}
        other => panic!("expected a retry notice, got {other:?}"),
    }
    // 重发拿到响应头时清掉重试通知（L35，stall-visibility.md §2.4）。
    assert!(matches!(
        items.get(1),
        Some(Ok(ModelStreamItem::Notice(ModelNotice::Resumed)))
    ));
    assert!(
        items[2..]
            .iter()
            .all(|item| matches!(item, Ok(ModelStreamItem::Event(_))))
    );
    // `stream` 不带通知。
    let server = Fixture::start(vec![
        error(500, "api_error"),
        Reply::new(200).send(text_response(&["ok"])),
    ])
    .await;
    let model = model_at(server.url(), fast_retry(3)).await;
    let events = collect(&model, request("hi", QuerySource::MainThread)).await;
    assert!(events.iter().all(Result::is_ok), "{events:?}");
}

/// Fork (slice 3 layer B): a run's tickets. Each acquire issues `tkt_<n>` with credential `token-<n>`; the first
/// `refusals` attempts are refused as expired, and every renewal is recorded.
struct Tickets {
    issued: Mutex<u32>,
    refusals: Mutex<u32>,
    renewed: Mutex<Vec<String>>,
}

#[async_trait]
impl rust_cli_kernel_api::off_peak_ticket::OffPeakTicketSource for Tickets {
    async fn acquire(&self) -> Result<rust_cli_kernel_api::off_peak_ticket::Ticket, ModelError> {
        let mut issued = self.issued.lock().unwrap();
        *issued += 1;
        Ok(rust_cli_kernel_api::off_peak_ticket::Ticket {
            id: format!("tkt_{issued}"),
            auth: Some(rust_cli_kernel_api::provider::SuppliedAuth {
                api_key: Some(RedactedString::new(format!("token-{issued}"))),
                headers: Vec::new(),
            }),
        })
    }

    fn refused_as_expired(&self, _provider: &str, _error: &ModelError) -> bool {
        let mut refusals = self.refusals.lock().unwrap();
        if *refusals == 0 {
            return false;
        }
        *refusals -= 1;
        true
    }

    async fn expired(&self, ticket_id: &str) -> Result<(), ModelError> {
        self.renewed.lock().unwrap().push(ticket_id.to_owned());
        Ok(())
    }
}

/// Endpoints of a run: the credential and the ticket id come from the query's ticket, as the platform gives them.
struct TicketedEndpoints {
    base_url: String,
    /// Whether the endpoint names the ticket an attempt is sent on (the header the Host's answer carries).
    ticket_header: bool,
}

#[async_trait]
impl ModelEndpoints for TicketedEndpoints {
    async fn endpoint(&self, query: EndpointQuery<'_>) -> Result<ModelEndpoint, ModelError> {
        let EndpointQuery {
            selection, ticket, ..
        } = query;
        let granted = ticket.unwrap().0.acquire().await?;
        let key = granted.auth.and_then(|auth| auth.api_key).unwrap();
        Ok(ModelEndpoint {
            protocol: WireProtocol::AnthropicMessages,
            base_url: self.base_url.clone(),
            model: format!("{}-api", selection.model),
            credential: Credential::ApiKey(key),
            headers: if self.ticket_header {
                vec![(
                    rust_cli_kernel_api::off_peak_ticket::TICKET_HEADER.to_owned(),
                    RedactedString::new(granted.id),
                )]
            } else {
                Vec::new()
            },
            body_patches: Vec::new(),
            capabilities: ModelCapabilities {
                supports_mid_conversation_system: true,
                supports_image: true,
                ..ModelCapabilities::default()
            },
            renewable: false,
            compress_body_over: None,
        })
    }
}

/// Fork (slice 3 layer B, Node `retryExpired`): an attempt refused as expired waits for its ticket's renewal and is
/// resent on the renewed ticket; the retry budget is not spent (`max_retries` is 0 here).
#[tokio::test]
async fn an_expired_ticket_is_renewed_and_resent_without_spending_retries() {
    let server = Fixture::start(vec![
        error(401, "authentication_error"),
        Reply::new(200).send(text_response(&["ok"])),
    ])
    .await;
    let tickets = Arc::new(Tickets {
        issued: Mutex::new(0),
        refusals: Mutex::new(1),
        renewed: Mutex::new(Vec::new()),
    });
    let source = rust_cli_kernel_api::off_peak_ticket::TicketSource(tickets.clone());
    let egress = Arc::new(Egress::new(NetworkPolicy::default()).await.unwrap());
    let model = ProviderModel::new(
        egress,
        Arc::new(TicketedEndpoints {
            base_url: server.url(),
            ticket_header: true,
        }),
        clock(),
        RouteOptions {
            retry: fast_retry(0),
            ..RouteOptions::default()
        },
    );
    let mut ticketed = request("hi", QuerySource::MainThread);
    ticketed.options.off_peak_ticket = Some(source);
    let events = collect(&model, ticketed).await;
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].header("x-api-key"), Some("token-1"));
    assert_eq!(requests[1].header("x-api-key"), Some("token-2"));
    assert_eq!(requests[1].header("x-off-peak-ticket-id"), Some("tkt_2"));
    assert_eq!(*tickets.renewed.lock().unwrap(), ["tkt_1"]);
}

/// Fork (slice 3 layer B): renewals of one request are bounded. A provider that keeps refusing the renewed ticket ends
/// the request with the refusal instead of renewing forever (the cap is `MAX_TICKET_RENEWALS`, 3).
#[tokio::test]
async fn the_renewals_of_one_request_are_bounded() {
    /// The transport's private cap (`transport/retry.rs`): the test refuses exactly one more time than it allows.
    const MAX_TICKET_RENEWALS: u32 = 3;
    let server = Fixture::start(
        (0..=MAX_TICKET_RENEWALS)
            .map(|_| error(401, "authentication_error"))
            .collect(),
    )
    .await;
    let tickets = Arc::new(Tickets {
        issued: Mutex::new(0),
        refusals: Mutex::new(MAX_TICKET_RENEWALS + 1),
        renewed: Mutex::new(Vec::new()),
    });
    let source = rust_cli_kernel_api::off_peak_ticket::TicketSource(tickets.clone());
    let egress = Arc::new(Egress::new(NetworkPolicy::default()).await.unwrap());
    let model = ProviderModel::new(
        egress,
        Arc::new(TicketedEndpoints {
            base_url: server.url(),
            ticket_header: true,
        }),
        clock(),
        RouteOptions {
            retry: fast_retry(0),
            ..RouteOptions::default()
        },
    );
    let mut ticketed = request("hi", QuerySource::MainThread);
    ticketed.options.off_peak_ticket = Some(source);
    let events = collect(&model, ticketed).await;
    // The last refusal ends the request with the provider's own classification, not as a renewal.
    let Some(Err(error)) = events.last() else {
        panic!("the request ends with an error: {events:?}");
    };
    assert!(
        matches!(error.peel(), ModelError::Authentication { .. }),
        "{error:?}"
    );
    assert_eq!(
        tickets.renewed.lock().unwrap().len(),
        MAX_TICKET_RENEWALS as usize
    );
    assert_eq!(server.requests().len(), MAX_TICKET_RENEWALS as usize + 1);
}

/// Fork (slice 3 layer B): a refusal of an attempt that names no ticket (no ticket header) has no ticket to renew. It
/// fails like any other refusal: nothing is asked of the run with an empty ticket id.
#[tokio::test]
async fn a_refusal_without_the_ticket_header_is_not_renewed() {
    let server = Fixture::start(vec![error(401, "authentication_error")]).await;
    let tickets = Arc::new(Tickets {
        issued: Mutex::new(0),
        refusals: Mutex::new(1),
        renewed: Mutex::new(Vec::new()),
    });
    let source = rust_cli_kernel_api::off_peak_ticket::TicketSource(tickets.clone());
    let egress = Arc::new(Egress::new(NetworkPolicy::default()).await.unwrap());
    let model = ProviderModel::new(
        egress,
        Arc::new(TicketedEndpoints {
            base_url: server.url(),
            ticket_header: false,
        }),
        clock(),
        RouteOptions {
            retry: fast_retry(0),
            ..RouteOptions::default()
        },
    );
    let mut ticketed = request("hi", QuerySource::MainThread);
    ticketed.options.off_peak_ticket = Some(source);
    let events = collect(&model, ticketed).await;
    assert!(events.iter().any(Result::is_err), "{events:?}");
    assert!(tickets.renewed.lock().unwrap().is_empty());
}

/// Keeps the model-io records, as the JSON the trace writer gets.
#[derive(Default)]
struct Records(Mutex<Vec<serde_json::Value>>);

impl rust_cli_model::ModelIoSink for Records {
    fn record(&self, record: rust_cli_model::ModelIoRecord) {
        self.0
            .lock()
            .unwrap()
            .push(serde_json::Value::Object(record.into_json()));
    }
}

/// Fork (slice 3 layer B): each send of a request is its own trace record with a distinct attempt ordinal, renewals
/// included. The sends are: refused (1), its renewal (no budget spent), a server error (2, retried within budget), and
/// the success (3). The renewal does not reuse the refused send's number.
#[tokio::test]
async fn each_send_of_a_renewed_request_has_its_own_attempt_ordinal() {
    let server = Fixture::start(vec![
        error(401, "authentication_error"),
        Reply::new(500)
            .header("content-type", "application/json")
            .send(r#"{"type":"error","error":{"type":"api_error","message":"boom"}}"#),
        Reply::new(200).send(text_response(&["ok"])),
    ])
    .await;
    let tickets = Arc::new(Tickets {
        issued: Mutex::new(0),
        refusals: Mutex::new(1),
        renewed: Mutex::new(Vec::new()),
    });
    let source = rust_cli_kernel_api::off_peak_ticket::TicketSource(tickets.clone());
    let records = Arc::new(Records::default());
    let egress = Arc::new(Egress::new(NetworkPolicy::default()).await.unwrap());
    let model = ProviderModel::new(
        egress,
        Arc::new(TicketedEndpoints {
            base_url: server.url(),
            ticket_header: true,
        }),
        clock(),
        RouteOptions {
            retry: fast_retry(1),
            headers: Some(Arc::new(rust_cli_model::RequestHeaders {
                source: Vec::new(),
                trace_id: "trace-renewal".to_owned(),
                request_id: Arc::new(|| "req-renewal".to_owned()),
            })),
            model_io: Some(records.clone()),
            ..RouteOptions::default()
        },
    );
    let mut ticketed = request("hi", QuerySource::MainThread);
    ticketed.options.off_peak_ticket = Some(source);
    let events = collect(&model, ticketed).await;
    assert!(events.iter().all(Result::is_ok), "{events:?}");
    let sent: Vec<u64> = records
        .0
        .lock()
        .unwrap()
        .iter()
        .map(|record| record["attempt"].as_u64().unwrap())
        .collect();
    assert_eq!(sent, [1, 2, 3]);
}
