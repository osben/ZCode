//! Fork: the main runner step that settles the `LSP` tool's availability before a run (specs/fork-rust-lsp.md
//! "Tool (D2)", "When it is computed"; Node's turn-start `settleLspPreferences`).

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::abort::Abort;
use rust_cli_kernel_api::lsp::CodeIntelligence;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::{ApiMessage, ModelSelection};
use rust_cli_kernel_api::orchestration::{
    QueryError, QueryRequest, QueryRunner, QueryStop, RunSink,
};

/// Wraps the query loop: a main-thread run first settles the session's tool fact, so the run's first tool snapshot
/// sees it for the run's workspace. Child runs leave it alone (no child sees the tool).
pub(crate) struct LspToolSettle {
    pub(crate) inner: Arc<dyn QueryRunner>,
    pub(crate) code: Arc<dyn CodeIntelligence>,
}

#[async_trait]
impl QueryRunner for LspToolSettle {
    async fn run(
        &self,
        request: QueryRequest,
        sink: Arc<dyn RunSink>,
        abort: Abort,
    ) -> Result<QueryStop, QueryError> {
        if request.agent.is_none() {
            self.code
                .settle_tool(&request.session, &request.workspace)
                .await;
        }
        self.inner.run(request, sink, abort).await
    }

    fn transcript(
        &self,
        history: &[Message],
        selection: &ModelSelection,
        mid_system: Option<bool>,
    ) -> Vec<ApiMessage> {
        self.inner.transcript(history, selection, mid_system)
    }
}

#[cfg(test)]
#[path = "lsp_tool_tests.rs"]
mod tests;
