//! Fork: authorizing an MCP App tool call (specs/fork-rust-node-helper.md F3, `helper/authorizeAppTool`). The frontend
//! opens the session first; the kernel builds the transient MCP tool from the helper's descriptor and runs the main
//! loop's own pipeline on it in the caller's task, with the session's tool context.

use rust_cli_kernel_api::app_tool::{AppToolCall, AppToolError, ElicitationCall};
use rust_cli_kernel_api::session_api::KernelError;
use serde_json::Value;

use super::LocalKernel;

impl LocalKernel {
    pub(crate) async fn authorize_app(&self, call: AppToolCall) -> Result<Value, AppToolError> {
        let Some(session) = self.settled(&call.session).await else {
            return Err(KernelError::NotFound {
                session: call.session,
            }
            .into());
        };
        let context = session.app_tool_context(call.tool_use, call.cancel).await?;
        let tool = rust_cli_ext::mcp::app_tool(&call.server, &call.tool, &call.descriptor);
        self.pipeline
            .authorize(tool.as_ref(), call.input, context)
            .await
            .map_err(AppToolError::Refused)
    }
}

impl LocalKernel {
    /// Fork F3b(c) PR 2: asks the session's user the helper-relayed question. It is asked in the session's context
    /// (`app_tool_context`), so it is withdrawn by the call's `withdrawn` token. A session that is not open is `NotFound`.
    pub(crate) async fn elicit_mcp(&self, call: ElicitationCall) -> Result<Value, KernelError> {
        let Some(session) = self.settled(&call.session).await else {
            return Err(KernelError::NotFound {
                session: call.session,
            });
        };
        let context = session
            .app_tool_context(call.tool_use.clone(), call.withdrawn.clone())
            .await?;
        Ok(rust_cli_ext::mcp::helper_elicitation_answer(
            context.interactions,
            call.tool_use,
            call.server,
            &call.params,
            call.withdrawn,
        )
        .await)
    }
}

#[cfg(test)]
#[path = "app_tool_tests.rs"]
mod tests;
