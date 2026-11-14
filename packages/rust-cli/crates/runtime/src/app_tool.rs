//! Fork: authorizing an MCP App tool call (specs/fork-rust-node-helper.md F3, `helper/authorizeAppTool`). The frontend
//! opens the session first; the kernel builds the transient MCP tool from the helper's descriptor and runs the main
//! loop's own pipeline on it in the caller's task, with the session's tool context.

use rust_cli_kernel_api::app_tool::{AppToolCall, AppToolError};
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

#[cfg(test)]
#[path = "app_tool_tests.rs"]
mod tests;
