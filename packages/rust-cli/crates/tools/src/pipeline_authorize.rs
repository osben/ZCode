//! Fork: the admission part of the pipeline for an MCP App tool call (specs/fork-rust-node-helper.md F3,
//! `helper/authorizeAppTool`), like Node's `ToolExecutor.authorizeAppTool`: the same checks as [`Pipeline::execute`]
//! up to the permission answer, then the approved input instead of a call. The tool and PostToolUse hooks never run.

use rust_cli_kernel_api::app_tool::AppToolRefusal;
use rust_cli_kernel_api::message::ToolResultContent;
use rust_cli_kernel_api::tool::{Tool, ToolOutput, ToolUseContext};
use serde_json::Value;

use rust_cli_kernel_api::hooks::HookOutcome;
use rust_cli_kernel_api::permission::PermissionDecision;

use super::{HookMessages, Pipeline, Rejection, no_such_tool};
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
            return Err(AppToolRefusal::PermissionDenied(text_of(&no_such_tool(
                tool.name(),
            ))));
        }
        // Node validates before the hooks and answers `invalid_input`; `admit` validates again, which then passes.
        if let Some(message) = validate(tool.name(), &tool.input_schema(), &input) {
            return Err(AppToolRefusal::InvalidInput(message));
        }
        let mut messages = HookMessages {
            app_call: true,
            ..HookMessages::default()
        };
        match self.admit(tool, input, context, &mut messages).await {
            Ok((input, _)) => Ok(input),
            Err(Rejection::App(refusal)) => Err(refusal),
            Err(Rejection::ByHook(output) | Rejection::Other(output)) => {
                Err(AppToolRefusal::PermissionDenied(text_of(&output)))
            }
        }
    }
}

/// Node `authorizeAppTool`: a PreToolUse hook that stops the turn or denies the call refuses it before the updated
/// input is validated and before the gate, with `hooks.stopReason ?? "Tool denied by host hook"`. Node sets
/// `stopReason` only with `continue: false` or `decision: "block"` (`hooks/output.ts`), which Rust folds into
/// `prevent_continuation`; a `permissionDecision: "deny"` reason alone is not the answer.
pub(super) fn app_hook_refusal(
    messages: &HookMessages,
    pre: &HookOutcome,
) -> Option<AppToolRefusal> {
    let denied = matches!(pre.decision, Some(PermissionDecision::Deny { .. }));
    if messages.pre_stopped.is_none() && !denied {
        return None;
    }
    let reason = messages
        .pre_stopped
        .clone()
        .flatten()
        .or_else(|| pre.stop_reason.clone());
    Some(AppToolRefusal::PermissionDenied(
        reason.unwrap_or_else(|| HOOK_STOPPED.to_owned()),
    ))
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
