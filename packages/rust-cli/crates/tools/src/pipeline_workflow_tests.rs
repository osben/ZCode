//! Fork (specs/fork-rust-workflow-engine.md 9.66, divergence 141): the pipeline's two answers of a workflow confirmation
//! window. An approval that carries the settings changed in the window (`PermissionAnswer::Adjusted`) runs the call on the
//! input the tool makes of them, and Refine (`PermissionAnswer::Refine`) refuses the call with the tool's text and the
//! message that follows it.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::orchestration::{HookEvent, HookOutcome, HookRunner, PermissionAnswer};
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::testing::{FakeTool, FixedGate};
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolCallOutput, ToolError, ToolOutput, ToolProgress, ToolUseContext,
};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::*;

struct NoHooks;

#[async_trait]
impl HookRunner for NoHooks {
    async fn run(&self, _event: HookEvent, _cancel: CancellationToken) -> HookOutcome {
        HookOutcome::default()
    }
}

/// A tool that always asks, runs on the input it is given (echoing it as its result), and applies a `bound` adjustment.
struct Adjustable {
    calls: Mutex<Vec<Value>>,
    refine: bool,
}

impl Adjustable {
    fn new(refine: bool) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            refine,
        }
    }
}

#[async_trait]
impl Tool for Adjustable {
    fn name(&self) -> &str {
        "Adjustable"
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object", "properties": {"bound": {"type": "number"}}})
    }

    fn description(&self, _context: &PromptContext) -> String {
        "adjustable".to_owned()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        false
    }

    async fn apply_input_adjustments(
        &self,
        _tool_use: &ToolUseId,
        input: &Value,
        adjustments: &Map<String, Value>,
        _context: &ToolUseContext,
    ) -> Result<Option<Value>, rust_cli_kernel_api::tool::ToolError> {
        if adjustments.get("bound") == Some(&json!(-1)) {
            return Err(rust_cli_kernel_api::tool::ToolError::Failed {
                message: "the adjusted bound cannot be applied".to_owned(),
            });
        }
        let mut next = input.as_object().cloned().unwrap_or_default();
        if let Some(bound) = adjustments.get("bound") {
            next.insert("bound".to_owned(), bound.clone());
        }
        Ok(Some(Value::Object(next)))
    }

    fn refined(&self, tool_use: &ToolUseId, feedback: &str) -> Option<ToolCallOutput> {
        self.refine.then(|| ToolCallOutput {
            output: rejected("not approved".to_owned()),
            new_messages: vec![Message::Attachment(
                rust_cli_kernel_api::hooks::queued_command::steer_attachment(
                    rust_cli_kernel_api::ids::MessageId::new(format!("msg_{}", tool_use.as_str())),
                    feedback,
                    rust_cli_kernel_api::hooks::SteerSender::User,
                    None,
                    Some("workflow_refine_feedback"),
                ),
            )],
            stop_turn: false,
        })
    }

    async fn call(
        &self,
        input: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        self.calls.lock().unwrap().push(input.clone());
        Ok(rust_cli_kernel_api::tool::text(input.to_string()))
    }
}

fn answer_context(answer: PermissionAnswer) -> ToolUseContext {
    super::tests::context(answer)
}

async fn execute(
    tool: Arc<dyn Tool>,
    input: Value,
    answer: PermissionAnswer,
) -> rust_cli_kernel_api::orchestration::ToolExecution {
    let pipeline = Pipeline::new(
        Arc::new(FixedGate(PermissionDecision::always_ask(
            "run it?",
            Vec::new(),
            false,
        ))),
        Arc::new(NoHooks),
    );
    let (progress, _updates) = mpsc::channel(4);
    pipeline
        .execute(
            tool,
            input,
            answer_context(answer),
            progress,
            rust_cli_kernel_api::orchestration::no_tool_start(),
        )
        .await
}

fn adjusted(adjustments: Value) -> PermissionAnswer {
    PermissionAnswer::Adjusted {
        adjustments: adjustments.as_object().cloned().unwrap(),
        answer: Box::new(PermissionAnswer::Allow {
            remember: Vec::new(),
        }),
    }
}

/// The settings changed in the window reach the tool, and the call runs on the input it makes of them.
#[tokio::test]
async fn an_adjusted_approval_runs_the_call_on_the_adjusted_input() {
    let tool = Arc::new(Adjustable::new(false));
    let execution = execute(
        tool.clone(),
        json!({"bound": 2}),
        adjusted(json!({"bound": 9})),
    )
    .await;
    assert!(!execution.output.is_error, "{:?}", execution.output);
    assert_eq!(*tool.calls.lock().unwrap(), vec![json!({"bound": 9})]);
}

/// ocr #624: an approval for the session inside the window's changes is still an approval; a producer that does not
/// normalize it to `Allow` first must not turn it into a refusal.
#[tokio::test]
async fn an_adjusted_session_approval_runs_the_call_on_the_adjusted_input() {
    let tool = Arc::new(Adjustable::new(false));
    let answer = PermissionAnswer::Adjusted {
        adjustments: json!({"bound": 9}).as_object().cloned().unwrap(),
        answer: Box::new(PermissionAnswer::AllowSession),
    };
    let execution = execute(tool.clone(), json!({"bound": 2}), answer).await;
    assert!(!execution.output.is_error, "{:?}", execution.output);
    assert_eq!(*tool.calls.lock().unwrap(), vec![json!({"bound": 9})]);
}

/// A change the tool cannot apply refuses the call with the tool's message, and nothing runs.
#[tokio::test]
async fn an_adjustment_the_tool_refuses_fails_the_call_and_runs_nothing() {
    let tool = Arc::new(Adjustable::new(false));
    let execution = execute(
        tool.clone(),
        json!({"bound": 2}),
        adjusted(json!({"bound": -1})),
    )
    .await;
    assert!(execution.output.is_error);
    assert_eq!(
        super::tests::text(&execution.output),
        "the adjusted bound cannot be applied"
    );
    assert!(tool.calls.lock().unwrap().is_empty());
}

/// A tool with no adjustment step runs its approved input: the approval is plain (Node ignores the changes).
#[tokio::test]
async fn a_tool_with_no_adjustment_step_runs_the_approved_input() {
    let execution = execute(
        Arc::new(FakeTool::new("Plain", false, "ran")),
        json!({}),
        adjusted(json!({"bound": 9})),
    )
    .await;
    assert!(!execution.output.is_error, "{:?}", execution.output);
    assert_eq!(super::tests::text(&execution.output), "ran");
}

/// Refine refuses the call with the tool's text, and the message the tool made follows the result.
#[tokio::test]
async fn refine_refuses_the_call_and_its_message_follows_the_result() {
    let tool = Arc::new(Adjustable::new(true));
    let execution = execute(
        tool.clone(),
        json!({}),
        PermissionAnswer::Refine {
            feedback: "split it".to_owned(),
        },
    )
    .await;
    assert!(execution.output.is_error);
    assert_eq!(super::tests::text(&execution.output), "not approved");
    let [Message::Attachment(steer)] = execution.after.as_slice() else {
        panic!("one follow-up message: {:?}", execution.after);
    };
    assert_eq!(
        rust_cli_kernel_api::hooks::queued_command::sourced(steer),
        Some(("workflow_refine_feedback", "split it"))
    );
    assert!(tool.calls.lock().unwrap().is_empty());
}

/// A tool that takes no Refine refuses like any denial, and no message follows.
#[tokio::test]
async fn refine_on_a_tool_without_it_is_an_ordinary_refusal() {
    let execution = execute(
        Arc::new(Adjustable::new(false)),
        json!({}),
        PermissionAnswer::Refine {
            feedback: "split it".to_owned(),
        },
    )
    .await;
    assert!(execution.output.is_error);
    assert_eq!(
        super::tests::text(&execution.output),
        REJECT_MESSAGE.to_owned()
    );
    assert!(execution.after.is_empty());
}
