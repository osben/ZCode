//! `submit_result` for a workflow actor (Node `tool/handlers/submit-result.ts`). The actor's terminal result goes to the
//! submit port and waits for the engine's verdict: an accepted result ends the turn (`stop_turn`), a rejected one is an
//! error that names each violation, so the model repairs it in the same session. Only an actor that has a port gets the
//! tool (`tools_for`); every other child keeps its tool set.
//!
//! Deviation, recorded in the spec: the declaration is always the generic one (`result` takes any JSON). Node's typed
//! declaration for a mono session, with that session's schema, is not built yet, so a mono turn's epilogue names a schema
//! the declaration does not show.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolCallOutput, ToolError, ToolOutput, ToolProgress, ToolUseContext,
    failed, text,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::actor_turn::{ActorPort, ActorSubmit, ActorViolation};

pub(crate) const NAME: &str = "submit_result";

/// Node's accepted text (`formatSubmitResultModelContent`).
const ACCEPTED: &str = "The result was accepted.";

/// Node's text when the turn is cancelled before a verdict (`cancellation.userVisibleMessage`).
const CANCELLED: &str = "submit_result was cancelled before the engine returned a verdict";

/// Node's header of a rejection (`formatSubmitViolations`).
const HEADER: &str = "The submitted result does not match the required schema:";

/// The tool for an actor's port.
pub(crate) fn tool(port: Arc<dyn ActorPort>) -> Arc<dyn Tool> {
    Arc::new(SubmitResult { port })
}

/// The tools an actor's child gets for its port: `submit_result` and `escalate` when there is a port, none otherwise.
pub(crate) fn tools_for(port: Option<&Arc<dyn ActorPort>>) -> Vec<Arc<dyn Tool>> {
    port.map(|port| vec![tool(port.clone()), crate::escalate::tool(port.clone())])
        .unwrap_or_default()
}

/// Node `formatSubmitViolations`: one violation per line, `<path>: expected <expected>, got <got>`.
fn format_violations(violations: &[ActorViolation]) -> String {
    if violations.is_empty() {
        return format!("{HEADER}\n(no details provided)");
    }
    let lines: Vec<String> = violations
        .iter()
        .map(|violation| {
            format!(
                "{}: expected {}, got {}",
                violation.path, violation.expected, violation.got
            )
        })
        .collect();
    format!("{HEADER}\n{}", lines.join("\n"))
}

struct SubmitResult {
    port: Arc<dyn ActorPort>,
}

#[async_trait]
impl Tool for SubmitResult {
    fn name(&self) -> &str {
        NAME
    }

    fn input_schema(&self) -> Value {
        // Node's submit input is strict: a key other than `result` is refused (see `call_with_messages`).
        json!({
            "type": "object",
            "properties": {"result": {"description": "The result, as JSON, matching the ask's schema."}},
            "required": ["result"],
            "additionalProperties": false,
        })
    }

    fn cancel_message(&self) -> Option<std::borrow::Cow<'_, str>> {
        Some(std::borrow::Cow::Borrowed(CANCELLED))
    }

    fn description(&self, _context: &PromptContext) -> String {
        "Submit the structured result for the current ask. The required JSON shape is described in the ask instructions."
            .to_owned()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        value: Value,
        context: ToolUseContext,
        progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        self.call_with_messages(value, context, progress)
            .await
            .map(|output| output.output)
    }

    async fn call_with_messages(
        &self,
        value: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolCallOutput, ToolError> {
        // Node's input schema is `.strict()`: the model's call is refused before it reaches the port if it carries any
        // key other than `result`, so a stray field never reaches the engine's verdict.
        if let Some(extra) = value
            .as_object()
            .and_then(|object| object.keys().find(|key| key.as_str() != "result"))
        {
            return Err(ToolError::InvalidInput {
                message: format!(
                    "unrecognized key \"{extra}\": submit_result takes only \"result\""
                ),
            });
        }
        let Some(result) = value.get("result").cloned() else {
            return Err(ToolError::InvalidInput {
                message: "the result is required".to_owned(),
            });
        };
        match self.port.submit(result).await.map_err(failed)? {
            ActorSubmit::Accepted => Ok(ToolCallOutput {
                output: text(ACCEPTED.to_owned()),
                new_messages: Vec::new(),
                // A valid submission ends the actor's turn (Node `stopTurnOnSuccess`).
                stop_turn: true,
            }),
            ActorSubmit::Rejected(violations) => Err(failed(format_violations(&violations))),
        }
    }
}
