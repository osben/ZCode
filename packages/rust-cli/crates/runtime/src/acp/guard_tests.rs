use std::sync::Arc;

use futures_util::StreamExt as _;
use rust_cli_kernel_api::model::{
    ModelError, ModelPort, ModelRequest, ModelSelection, QuerySource, RequestOptions,
};
use rust_cli_kernel_api::testing::ScriptedModel;
use tokio_util::sync::CancellationToken;

use super::ExternalAgentModelGuard;

fn request(provider: &str, model: &str) -> ModelRequest {
    ModelRequest {
        selection: ModelSelection::new(provider, model),
        system: Vec::new(),
        messages: Vec::new(),
        tools: Vec::new(),
        tool_choice: None,
        max_tokens: 1,
        thinking: None,
        temperature: None,
        betas: Vec::new(),
        source: QuerySource::Compact,
        options: RequestOptions::default(),
    }
}

#[tokio::test]
async fn an_acp_selection_never_reaches_the_model() {
    let model = Arc::new(ScriptedModel::new(vec![Vec::new()]));
    let guard = ExternalAgentModelGuard {
        inner: model.clone(),
    };
    let events: Vec<_> = guard
        .stream(request("acp:cursor", "cursor"), CancellationToken::new())
        .collect()
        .await;
    match events.as_slice() {
        [Err(ModelError::InvalidRequest { message })] => assert_eq!(
            message,
            "Model cursor is an external agent; compact cannot run it (external_agent_unsupported)"
        ),
        other => panic!("{other:?}"),
    }
    assert!(model.requests().is_empty());
}

#[tokio::test]
async fn other_selections_pass_through() {
    let model = Arc::new(ScriptedModel::new(vec![Vec::new()]));
    let guard = ExternalAgentModelGuard {
        inner: model.clone(),
    };
    let _: Vec<_> = guard
        .stream(request("zai", "glm"), CancellationToken::new())
        .collect()
        .await;
    assert_eq!(model.requests().len(), 1);
}
