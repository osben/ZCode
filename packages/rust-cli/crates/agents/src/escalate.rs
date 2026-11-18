//! `escalate` for a workflow actor (Node `tool/handlers/escalate.ts`). The actor asks the main agent a blocking question and
//! waits for the answer. The answer is the tool's text. A refusal (no ask in flight, or the budget spent) is also the tool's
//! text, an ordinary result the model reads. Only a failed port fails the call.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolCallOutput, ToolError, ToolOutput, ToolProgress, ToolUseContext,
    failed, text,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::actor_turn::{ActorEscalation, ActorPort, ActorQuestion};

pub(crate) const NAME: &str = "escalate";

/// Node `MAX_ESCALATE_MODEL_BYTES`.
const MAX_MODEL_BYTES: usize = 16_000;

/// Node's text when the call is cancelled before the main agent answers (`cancellation.userVisibleMessage`).
const CANCELLED: &str = "escalate was cancelled before the main agent answered";

/// Node `ESCALATE_DESCRIPTION`: the usage discipline. The mechanism only lets an actor ask; this says when to.
const DESCRIPTION: &str = "Escalates a question that is BLOCKING you to the main agent that created this workflow, and waits here for the answer.\n\nThis is a LAST RESORT, for when you are genuinely stuck on something outside your reach:\n- a gate that is broken or impossible to pass (a check capped at 95 when the threshold is 96);\n- instructions that contradict each other, so no output can satisfy both;\n- a fact you cannot obtain (a tradeoff, an external convention, what 'good' means here) that only whoever started this run knows.\n\nDo NOT use it for curiosity, progress reports, asking permission, confirming a conclusion you could verify yourself, or thinking out loud. None of those are blocked — keep working.\n\nAsk ONE focused question that can be answered in a sentence, and put your evidence in `context`: what you already tried, and exactly where you are stuck. The quality of the answer depends on it.\n\nThe cost: this call BLOCKS until the main agent answers, which may take a long time. You get at most 3 escalations per ask; the 4th tells you the budget is spent and to proceed on your own best judgement. Do not spend them on questions not worth waiting for.";

/// The tool for an actor's port.
pub(crate) fn tool(port: Arc<dyn ActorPort>) -> Arc<dyn Tool> {
    Arc::new(Escalate { port })
}

struct Escalate {
    port: Arc<dyn ActorPort>,
}

#[async_trait]
impl Tool for Escalate {
    fn name(&self) -> &str {
        NAME
    }

    fn input_schema(&self) -> Value {
        // Node's EscalateInputSchema is `.strict()` and `question` is `min(1)`.
        json!({
            "type": "object",
            "properties": {
                "question": {"type": "string", "minLength": 1, "description": "One focused question that can be answered in a sentence."},
                "context": {"type": "string", "description": "What you already tried, and exactly where you are stuck."},
            },
            "required": ["question"],
            "additionalProperties": false,
        })
    }

    fn description(&self, _context: &PromptContext) -> String {
        DESCRIPTION.to_owned()
    }

    fn cancel_message(&self) -> Option<std::borrow::Cow<'_, str>> {
        Some(std::borrow::Cow::Borrowed(CANCELLED))
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    /// Node `MAX_ESCALATE_MODEL_BYTES`: the model reads at most this many bytes of the escalate result.
    fn result_budget_truncate_bytes(&self) -> Option<usize> {
        Some(MAX_MODEL_BYTES)
    }

    /// Node `escalateToolEntry` `shouldDefer: true`.
    fn should_defer(&self) -> bool {
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
        // Node's input schema is `.strict()`: a key other than `question` or `context` is refused before the port.
        if let Some(extra) = value.as_object().and_then(|object| {
            object
                .keys()
                .find(|key| !matches!(key.as_str(), "question" | "context"))
        }) {
            return Err(ToolError::InvalidInput {
                message: format!(
                    "unrecognized key \"{extra}\": escalate takes only \"question\" and \"context\""
                ),
            });
        }
        let Some(question) = value
            .get("question")
            .and_then(Value::as_str)
            .filter(|question| !question.is_empty())
        else {
            return Err(ToolError::InvalidInput {
                message: "the question is required and must not be empty".to_owned(),
            });
        };
        let context = value
            .get("context")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let outcome = self
            .port
            .escalate(ActorQuestion {
                question: question.to_owned(),
                context,
            })
            .await
            .map_err(failed)?;
        // Node's model text is the outcome's message: the answer, or the refusal.
        let message = match outcome {
            ActorEscalation::Answered { answer, .. } => answer,
            ActorEscalation::Refused { message, .. } => message,
        };
        Ok(ToolCallOutput {
            output: text(message),
            new_messages: Vec::new(),
            stop_turn: false,
        })
    }
}
