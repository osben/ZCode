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

/// Wraps the query loop: a main-thread run first recomputes the session's tool fact, so the run's first tool snapshot
/// already reflects an install or a workspace change. Child runs keep the fact as it is (no child sees the tool).
pub(crate) struct LspToolRefresh {
    pub(crate) inner: Arc<dyn QueryRunner>,
    pub(crate) code: Arc<dyn CodeIntelligence>,
}

#[async_trait]
impl QueryRunner for LspToolRefresh {
    async fn run(
        &self,
        request: QueryRequest,
        sink: Arc<dyn RunSink>,
        abort: Abort,
    ) -> Result<QueryStop, QueryError> {
        if request.agent.is_none() {
            self.code
                .refresh_tool(&request.session, &request.workspace)
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
