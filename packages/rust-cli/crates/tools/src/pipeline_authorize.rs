//! Fork: the admission part of the pipeline for an MCP App tool call (specs/fork-rust-node-helper.md F3,
//! `helper/authorizeAppTool`), like Node's `ToolExecutor.authorizeAppTool`: the same checks as [`Pipeline::execute`]
//! up to the permission answer, then the approved input instead of a call. The tool and PostToolUse hooks never run.

use rust_cli_kernel_api::app_tool::AppToolRefusal;
use rust_cli_kernel_api::message::ToolResultContent;
use rust_cli_kernel_api::tool::{Tool, ToolOutput, ToolUseContext};
use serde_json::Value;

use super::{HookMessages, Pipeline, Rejection};
use crate::validate::validate;

/// Node's text when a PreToolUse hook stops the call without a reason of its own.
const HOOK_STOPPED: &str = "Tool denied by host hook";

impl Pipeline {
    /// Validation (Node's `invalid_input`), then PreToolUse hooks, the rules and the gate with the context's prompt
    /// (Node's `permission_denied` for every refusal). Answers the input the call may run with (hook-updated).
    pub async fn authorize(
        &self,
        tool: &dyn Tool,
        input: Value,
        context: ToolUseContext,
    ) -> Result<Value, AppToolRefusal> {
        if self.hidden(tool, &context).await {
            return Err(AppToolRefusal::PermissionDenied(format!(
                "No such tool available: {}",
                tool.name()
            )));
        }
        // Node validates before the hooks and answers `invalid_input`; `admit` validates again, which then passes.
        if let Some(message) = validate(tool.name(), &tool.input_schema(), &input) {
            return Err(AppToolRefusal::InvalidInput(message));
        }
        let mut messages = HookMessages {
            app_call: true,
            ..HookMessages::default()
        };
        let admitted = self.admit(tool, input, context, &mut messages).await;
        // A PreToolUse hook that stops the turn denies an App call (Node's `preventContinuation`, before the gate).
        if let Some(reason) = messages.pre_stopped {
            return Err(AppToolRefusal::PermissionDenied(
                reason.unwrap_or_else(|| HOOK_STOPPED.to_owned()),
            ));
        }
        match admitted {
            Ok((input, _)) => Ok(input),
            Err(Rejection::ByHook(output) | Rejection::Other(output)) => {
                Err(AppToolRefusal::PermissionDenied(text_of(&output)))
            }
        }
    }
}

/// The refusal's text without the model's `<tool_use_error>` wrapper.
fn text_of(output: &ToolOutput) -> String {
    let text: String = output
        .content
        .iter()
        .filter_map(|block| match block {
            ToolResultContent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    text.strip_prefix("<tool_use_error>")
        .and_then(|text| text.strip_suffix("</tool_use_error>"))
        .map(str::to_owned)
        .unwrap_or(text)
}

#[cfg(test)]
#[path = "pipeline_authorize_tests.rs"]
mod tests;
