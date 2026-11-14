//! Fork: MCP App sampling (specs/fork-rust-node-helper.md F3, `helper/sampleModel`): the real session actor, a scripted
//! side model.

use std::sync::Arc;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::message::{ContentBlock, ImageSource, StopReason};
use rust_cli_kernel_api::metering::{CallStatus, ModelCall};
use rust_cli_kernel_api::model::{ApiRole, ModelError, ModelPort, QuerySource};
use rust_cli_kernel_api::provider::ModelCapabilities;
use rust_cli_kernel_api::sampling::{
    NO_IMAGE_INPUT, SamplingBlock, SamplingError, SamplingMessage, SamplingRequest,
    UNSUPPORTED_COMPLETION,
};
use rust_cli_kernel_api::side_request::SideSource;
use rust_cli_kernel_api::store::Fact;
use rust_cli_kernel_api::testing::{ScriptedModel, selection, text_response, tool_use_response};
use serde_json::json;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::stop_reason;
use crate::test_support::{Built, Setup};

async fn built(side: Arc<dyn ModelPort>) -> Built {
    let main = Arc::new(ScriptedModel::new(Vec::new()));
    let mut setup = Setup::new(main);
    setup.side_model = Some(side);
    setup.build().await
}

fn request(blocks: Vec<SamplingBlock>) -> SamplingRequest {
    SamplingRequest {
        messages: vec![
            SamplingMessage {
                assistant: false,
                content: blocks,
            },
            SamplingMessage {
                assistant: true,
                content: vec![SamplingBlock::Text("Earlier answer".to_owned())],
            },
        ],
        system_prompt: Some("Be brief.".to_owned()),
        max_tokens: 9_000,
    }
}

fn text(text: &str) -> Vec<SamplingBlock> {
    vec![SamplingBlock::Text(text.to_owned())]
}

fn image() -> SamplingBlock {
    SamplingBlock::Image {
        mime_type: "image/png".to_owned(),
        data: "iVBORw0KGgo=".to_owned(),
    }
}

fn rows(built: &Built) -> Vec<ModelCall> {
    built
        .store
        .facts(&SessionId::new("sess_1"))
        .into_iter()
        .filter_map(|fact| match fact {
            Fact::ModelCalled { call } => Some(call),
            _ => None,
        })
        .collect()
}

fn capped(max: u64, supports_image: bool) -> Option<ModelCapabilities> {
    Some(ModelCapabilities {
        max_output_tokens: Some(max),
        supports_image,
        ..ModelCapabilities::default()
    })
}

#[tokio::test]
async fn the_session_model_answers_and_only_a_usage_row_is_stored() {
    let side = Arc::new(
        ScriptedModel::new(vec![text_response(&["Hel", "lo"])]).capabilities(capped(4_000, true)),
    );
    let built = built(side.clone()).await;
    let reply = built
        .session
        .sample_model(
            request(vec![SamplingBlock::Text("Hi".to_owned()), image()]),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(reply.model, selection().model);
    assert_eq!(reply.text, "Hello");
    assert_eq!(reply.stop_reason, "endTurn");

    let requests = side.requests();
    assert_eq!(requests.len(), 1);
    let sent = &requests[0];
    // The session's own selection, not the small fast model; no reasoning level is picked.
    assert_eq!(sent.selection, selection());
    assert_eq!(sent.source, QuerySource::Side(SideSource::McpSampling));
    assert_eq!(sent.max_tokens, 4_000);
    assert_eq!(sent.options.provider_max_output_tokens, Some(4_000));
    assert_eq!(sent.options.session_id, Some(SessionId::new("sess_1")));
    assert_eq!(sent.system.len(), 1);
    assert_eq!(sent.system[0].text, "Be brief.");
    assert_eq!(sent.messages.len(), 2);
    assert_eq!(sent.messages[0].role, ApiRole::User);
    assert_eq!(sent.messages[1].role, ApiRole::Assistant);
    assert!(matches!(
        &sent.messages[0].content[1].block,
        ContentBlock::Image { source: ImageSource::Base64 { media_type, data }, .. }
            if media_type == "image/png" && data == "iVBORw0KGgo="
    ));

    let facts = built.store.facts(&SessionId::new("sess_1"));
    assert!(
        facts
            .iter()
            .all(|fact| matches!(fact, Fact::ModelCalled { .. })),
        "{facts:?}"
    );
    let rows = rows(&built);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].source, QuerySource::Side(SideSource::McpSampling));
    assert_eq!(rows[0].status, CallStatus::Completed);
    assert_eq!(rows[0].stop_reason, Some(StopReason::EndTurn));
}

#[tokio::test]
async fn the_panels_cap_wins_when_it_is_lower() {
    let side = Arc::new(
        ScriptedModel::new(vec![text_response(&["ok"])]).capabilities(capped(64_000, true)),
    );
    let built = built(side.clone()).await;
    built
        .session
        .sample_model(request(text("Hi")), CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(side.requests()[0].max_tokens, 9_000);
}

#[tokio::test]
async fn a_tool_call_is_no_supported_completion() {
    let side = Arc::new(ScriptedModel::new(vec![tool_use_response(
        "t1",
        "Read",
        &json!({}),
    )]));
    let built = built(side).await;
    let error = built
        .session
        .sample_model(request(text("Hi")), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(&error, SamplingError::Failed(message) if message == UNSUPPORTED_COMPLETION));
    let rows = rows(&built);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, CallStatus::Error);
    assert_eq!(rows[0].tool_calls, 1);
}

#[tokio::test]
async fn a_model_error_fails_the_call_and_is_recorded() {
    let side = Arc::new(ScriptedModel::new(vec![vec![Err(ModelError::Protocol {
        message: "bad gateway".to_owned(),
    })]]));
    let built = built(side).await;
    let error = built
        .session
        .sample_model(request(text("Hi")), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(&error, SamplingError::Failed(message) if message.contains("bad gateway")));
    let rows = rows(&built);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, CallStatus::Error);
    assert!(rows[0].error.is_some());
}

#[tokio::test]
async fn a_model_without_images_refuses_an_image_before_any_call() {
    let side = Arc::new(
        ScriptedModel::new(vec![text_response(&["no"])]).capabilities(capped(4_000, false)),
    );
    let built = built(side.clone()).await;
    let error = built
        .session
        .sample_model(request(vec![image()]), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(matches!(&error, SamplingError::Failed(message) if message == NO_IMAGE_INPUT));
    assert!(side.requests().is_empty());
    assert!(rows(&built).is_empty());
}

#[tokio::test]
async fn a_call_cancelled_before_it_starts_reaches_no_model() {
    let side = Arc::new(ScriptedModel::new(vec![text_response(&["no"])]));
    let built = built(side.clone()).await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = built
        .session
        .sample_model(request(text("Hi")), cancel)
        .await
        .unwrap_err();
    assert!(matches!(error, SamplingError::Cancelled));
    assert!(side.requests().is_empty());
    assert!(rows(&built).is_empty());
}

#[tokio::test]
async fn a_call_cancelled_while_the_model_answers_is_recorded_as_cancelled() {
    let gate = Arc::new(Notify::new());
    let side = Arc::new(ScriptedModel::new(vec![text_response(&["late"])]).gated(gate));
    let built = built(side.clone()).await;
    let cancel = CancellationToken::new();
    let call = built
        .session
        .sample_model(request(text("Hi")), cancel.clone());
    let cancel_soon = async {
        while side.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        cancel.cancel();
    };
    let (result, ()) = tokio::join!(call, cancel_soon);
    assert!(matches!(result, Err(SamplingError::Cancelled)));
    let rows = rows(&built);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, CallStatus::Cancelled);
}

#[test]
fn stop_reasons_map_like_node_maps_the_ai_sdk_finish_reason() {
    assert_eq!(stop_reason(Some(StopReason::EndTurn)), Some("endTurn"));
    assert_eq!(stop_reason(Some(StopReason::StopSequence)), Some("endTurn"));
    assert_eq!(stop_reason(Some(StopReason::MaxTokens)), Some("maxTokens"));
    assert_eq!(
        stop_reason(Some(StopReason::Refusal)),
        Some("content-filter")
    );
    assert_eq!(stop_reason(Some(StopReason::ToolUse)), None);
    assert_eq!(stop_reason(Some(StopReason::Unknown)), None);
    assert_eq!(stop_reason(None), None);
}
