//! RespondToCoordinator (Node `tool/handlers/respond-to-coordinator.ts`, `subagent/coordinator-response.ts`,
//! `runtime/methods/subagent-messages.ts`).
//!
//! A subagent child answers the coordinator that owns it while its own task goes on. The target is bound here, from the
//! child's own agent record, so the model cannot route the message. Success means only that the message entered the
//! parent session's signal channel (`Hub::subagent_message`): the parent has not read it yet.
//!
//! The tool is in a child's tool set only (`FilteredTools::child_tools`, `ForkChildTools::child_tools`), never in the
//! main registry.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, failed, text,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::Core;

/// The tool name (Node `RESPOND_TO_COORDINATOR_TOOL_NAME`).
pub(crate) const NAME: &str = "RespondToCoordinator";
/// Node `RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS`: the cap on `message`.
const MAX_MESSAGE_CHARS: usize = 20_000;
/// Node `RESPOND_TO_COORDINATOR_MODEL_BYTES`: the cap on the result text the model reads.
const MAX_RESULT_BYTES: usize = 4_096;
/// Continuation sentence of both results (Node `formatRespondToCoordinatorModelContent`).
const CONTINUE: &str =
    "Continue the current task unless the coordinator explicitly changed or ended it.";

/// The tool, for a child run's tool set.
pub(crate) fn tool(core: Arc<Core>) -> Arc<dyn Tool> {
    Arc::new(RespondToCoordinator { core })
}

/// The model's input, validated the way Node's zod schema validates it.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Input {
    pub(crate) summary: String,
    pub(crate) message: String,
}

/// Validates the model's input (strict object, `summary` 1 to 200 characters, `message` 1 to 20000).
pub(crate) fn parse(value: &Value) -> Result<Input, String> {
    let input: Input = serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    let summary = input.summary.chars().count();
    if !(1..=200).contains(&summary) {
        return Err("summary must be between 1 and 200 characters".to_owned());
    }
    let message = input.message.chars().count();
    if !(1..=MAX_MESSAGE_CHARS).contains(&message) {
        return Err(format!(
            "message must be between 1 and {MAX_MESSAGE_CHARS} characters"
        ));
    }
    Ok(input)
}

/// The JSON schema the model sees (Node `RespondToCoordinatorInputJsonSchema`).
pub(crate) fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "summary": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200,
                "description": "Short summary of the response."
            },
            "message": {
                "type": "string",
                "minLength": 1,
                "maxLength": MAX_MESSAGE_CHARS,
                "description": "Response or progress update for the coordinator."
            }
        },
        "required": ["summary", "message"],
        "additionalProperties": false
    })
}

/// The block the parent receives (Node `formatSubagentMessage`), with every value XML-escaped.
pub(crate) fn message_text(
    agent_id: &str,
    agent_type: &str,
    summary: &str,
    message: &str,
) -> String {
    [
        "<subagent-message>".to_owned(),
        format!("<agent-id>{}</agent-id>", escape(agent_id)),
        format!("<agent-type>{}</agent-type>", escape(agent_type)),
        format!("<summary>{}</summary>", escape(summary)),
        format!("<message>{}</message>", escape(message)),
        "</subagent-message>".to_owned(),
    ]
    .join("\n")
}

/// Node's RespondToCoordinator display (`result-display.ts`): the card reads its status, not the model text.
pub(crate) fn reply_display(outcome: &Result<String, (String, String)>) -> serde_json::Value {
    let status = if outcome.is_ok() { "success" } else { "failed" };
    serde_json::json!({ "kind": "respond_to_coordinator", "status": status })
}

/// The result text the model reads. `Ok` carries the response id; `Err` carries the response id and the failure.
pub(crate) fn reply_text(outcome: &Result<String, (String, String)>) -> String {
    let text = match outcome {
        Ok(response_id) => {
            format!("Response {response_id} was queued for the coordinator. {CONTINUE}")
        }
        Err((response_id, error)) => {
            format!(
                "Response {response_id} failed to queue for the coordinator. {CONTINUE} Failure: {error}."
            )
        }
    };
    truncate(text, MAX_RESULT_BYTES)
}

fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            other => out.push(other),
        }
    }
    out
}

fn truncate(mut text: String, max_bytes: usize) -> String {
    if text.len() > max_bytes {
        let mut end = max_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

struct RespondToCoordinator {
    core: Arc<Core>,
}

impl RespondToCoordinator {
    /// Queues the message for the coordinator that owns the calling child. A child whose owner is another subagent
    /// fails: this port has no mailbox for a subagent parent yet (the desktop never spawns one).
    async fn respond(
        &self,
        value: &Value,
        context: &ToolUseContext,
    ) -> Result<ToolOutput, ToolError> {
        let input = parse(value).map_err(failed)?;
        let response_id = format!("response_{}", self.core.ports.ids.execution());
        let Some(agent) = context.agent.as_ref() else {
            return Ok(text(reply_text(&Err((
                response_id,
                "RespondToCoordinator runs only in a subagent".to_owned(),
            )))));
        };
        let outcome = match self.core.live.get(agent) {
            Some(live) if live.owner.is_none() => {
                let message = message_text(
                    agent.as_str(),
                    &live.definition.agent_type,
                    &input.summary,
                    &input.message,
                );
                self.core.hub.subagent_message(&live.parent, message);
                Ok(response_id)
            }
            Some(_) => Err((
                response_id,
                "the coordinator is a subagent, which this runtime does not route to yet"
                    .to_owned(),
            )),
            None => Err((response_id, "the subagent is no longer running".to_owned())),
        };
        let mut shown = text(reply_text(&outcome));
        shown.display = reply_display(&outcome);
        Ok(shown)
    }
}

#[async_trait]
impl Tool for RespondToCoordinator {
    fn name(&self) -> &str {
        NAME
    }

    /// Deferred (Node `shouldDefer: true`): the model finds it through ToolSearch.
    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some("respond to the coordinator that owns this subagent")
    }

    fn input_schema(&self) -> Value {
        input_schema()
    }

    fn description(&self, _context: &rust_cli_kernel_api::tool::PromptContext) -> String {
        "Respond to the coordinator that owns this subagent. Use it when a message from the coordinator asks for an answer \
         or a progress update, and keep answering concisely. Do not use it as a substitute for the final task result."
            .to_owned()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
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
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        self.respond(&value, &context).await
    }
}

#[cfg(test)]
#[path = "respond_tests.rs"]
mod tests;
