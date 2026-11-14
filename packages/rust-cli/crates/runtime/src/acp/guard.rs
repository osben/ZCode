//! Fork: side callers (title, compaction, goal verification, memory, subagents) ask the regular model port. An ACP
//! selection fails closed there with Node's `ExternalAgentUnsupportedError` words instead of reaching a provider
//! (specs/fork-rust-agent-parity.md "ACP external agents", rule 11).

use std::sync::Arc;

use futures_util::stream::{self, BoxStream, StreamExt as _};
use rust_cli_kernel_api::model::{
    ModelError, ModelEvent, ModelPort, ModelRequest, ModelSelection, ModelStreamItem,
};
use rust_cli_kernel_api::provider::ModelCapabilities;
use tokio_util::sync::CancellationToken;

use super::external_agent;

pub(crate) struct ExternalAgentModelGuard {
    pub(crate) inner: Arc<dyn ModelPort>,
}

/// Node `ExternalAgentUnsupportedError`.
fn refusal(request: &ModelRequest) -> Option<ModelError> {
    external_agent(&request.selection)?;
    Some(ModelError::InvalidRequest {
        message: format!(
            "Model {} is an external agent; {} cannot run it (external_agent_unsupported)",
            request.selection.model,
            request.source.node_name()
        ),
    })
}

impl ModelPort for ExternalAgentModelGuard {
    fn stream(
        &self,
        request: ModelRequest,
        cancel: CancellationToken,
    ) -> BoxStream<'static, Result<ModelEvent, ModelError>> {
        match refusal(&request) {
            Some(error) => stream::once(async move { Err(error) }).boxed(),
            None => self.inner.stream(request, cancel),
        }
    }

    fn stream_with_notices(
        &self,
        request: ModelRequest,
        cancel: CancellationToken,
    ) -> BoxStream<'static, Result<ModelStreamItem, ModelError>> {
        match refusal(&request) {
            Some(error) => stream::once(async move { Err(error) }).boxed(),
            None => self.inner.stream_with_notices(request, cancel),
        }
    }

    fn capabilities(
        &self,
        selection: &ModelSelection,
    ) -> futures_util::future::BoxFuture<'static, Option<ModelCapabilities>> {
        self.inner.capabilities(selection)
    }
}

#[cfg(test)]
#[path = "guard_tests.rs"]
mod tests;
