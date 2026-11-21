//! Fork: the FillWorkflowHole tool (Node `core/src/tool/handlers/fill-workflow-hole*.ts` and
//! `contracts/src/tools/fill-workflow-hole.ts`; specs/fork-rust-workflow-engine.md, 9.45, W7-12).
//!
//! A fill gives the statements of the function that a waiting hole stands for. The run port checks the effective script and
//! releases the branch parked there with the code; nothing is started. The ask always asks, and the session may allow it
//! (Node's `alwaysAsk` with `allowAlways: "session"`). Not built: the owner exemption (`isFillWorkflowHoleOwnedRun` skips the
//! ask; the hole's facts are not read here, divergence 513), the fill file and the draft (divergence 511), and the display
//! window with its model-facing paths and causality graph (divergence 514).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::permission::{PermissionDecision, PermissionRule};
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation, failed,
};
use rust_cli_kernel_api::tool_names;
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunPort, DynamicWorkflowRunSessions, FillHoleOutcome, FillHoleRequest,
    FillRefusalReason,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::workflow_amend::read_revision_file;
use crate::workflow_create::{CREATE_MODEL_BYTES, output_for};
use crate::workflow_tools::{
    Contract, DYNAMIC_WORKFLOW_SKILL, contract, skill_loaded, workspace_dir,
};

/// The skill gate's code, as AmendWorkflow reports it.
const SKILL_NOT_LOADED_CODE: i32 = 428;

#[cfg(test)]
#[path = "workflow_fill_hole_tests.rs"]
mod tests;

/// Node `FILL_WORKFLOW_HOLE_SOURCE_ERROR`: exactly one body source.
const SOURCE_ERROR: &str = "Provide exactly one body source: `script` for the hole's statements written inline, or `path` for a file holding them (usually the fill file a rejected attempt was saved to). Passing both, or neither, is ambiguous.";

/// Node `fillUnavailableFailure`: the session has no run port.
const FILL_UNAVAILABLE: &str = "workflow_fill_unavailable: this session cannot fill workflow holes — workflow execution is not available here. This is a capability gap, not a bad hole id.";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FillInput {
    run_id: String,
    hole_id: String,
    #[serde(default)]
    script: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

pub struct FillWorkflowHoleTool {
    contract: &'static Contract,
    /// The run service's per-session ports: a fill goes through the calling session's port.
    runs: Option<Arc<dyn DynamicWorkflowRunSessions>>,
}

impl FillWorkflowHoleTool {
    pub fn new(runs: Option<Arc<dyn DynamicWorkflowRunSessions>>) -> Self {
        Self {
            contract: contract(tool_names::FILL_WORKFLOW_HOLE),
            runs,
        }
    }

    fn port(&self, context: &ToolUseContext) -> Option<Arc<dyn DynamicWorkflowRunPort>> {
        self.runs
            .as_ref()
            .map(|runs| runs.for_session(&context.session))
    }
}

/// Node `fillRefusalFor`: the port's refusal as the model reads it, with the reason's code first.
fn refusal_text(reason: FillRefusalReason, run_id: &str, message: &str) -> String {
    match reason {
        FillRefusalReason::RunNotFound => format!(
            "run_not_found: no workflow run with ID {run_id} exists for this project. Use ListWorkflowRuns to see the runs that do. {message}"
        ),
        FillRefusalReason::HoleNotWaiting => format!("hole_not_waiting: {message}"),
        FillRefusalReason::FillIdsUnstable => format!(
            "fill_ids_unstable: {message} This is a host fault, not a problem with your body: the hole is still waiting. Report it to the user rather than rewriting the body."
        ),
        FillRefusalReason::CompileFailed => format!("workflow_fill_refused: {message}"),
    }
}

/// The diagnostics of a refused body, one per line, as `L{line}:C{column} {message}`.
fn diagnostic_lines(diagnostics: Option<&Value>) -> String {
    let Some(items) = diagnostics.and_then(Value::as_array) else {
        return String::new();
    };
    items
        .iter()
        .map(|item| {
            format!(
                "\nL{}:C{} {}",
                item.get("line").and_then(Value::as_u64).unwrap_or(0),
                item.get("column").and_then(Value::as_u64).unwrap_or(0),
                item.get("message").and_then(Value::as_str).unwrap_or("")
            )
        })
        .collect()
}

#[async_trait]
impl Tool for FillWorkflowHoleTool {
    fn name(&self) -> &str {
        tool_names::FILL_WORKFLOW_HOLE
    }

    fn input_schema(&self) -> Value {
        self.contract.input_schema.clone()
    }

    fn description(&self, _context: &PromptContext) -> String {
        self.contract.description.clone()
    }

    fn should_defer(&self) -> bool {
        self.contract.should_defer
    }

    fn search_hint(&self) -> Option<&str> {
        self.contract.search_hint.as_deref()
    }

    /// Node `askOptions.allowAlways: "session"`: the ask offers "always allow in this session".
    fn allow_session(&self) -> bool {
        true
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        self.contract.read_only
    }

    fn is_destructive(&self, _input: &Value) -> bool {
        self.contract.destructive
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        self.contract.concurrent_safe
    }

    /// The compile refusal lists one line per diagnostic of the whole effective script, so it carries the model budget
    /// the sibling workflow tools declare.
    fn result_budget_truncate_bytes(&self) -> Option<usize> {
        Some(CREATE_MODEL_BYTES)
    }

    /// The input's shape, the one-body-source rule, and the skill gate (a fill always writes a script).
    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        let input: FillInput = match serde_json::from_value(input.clone()) {
            Ok(input) => input,
            Err(error) => {
                return Validation::Invalid {
                    message: error.to_string(),
                    error_code: None,
                };
            }
        };
        if input.run_id.is_empty() {
            return invalid(None, "run_id: String must contain at least 1 character(s)");
        }
        if input.hole_id.is_empty() {
            return invalid(None, "hole_id: String must contain at least 1 character(s)");
        }
        // The contract's `minLength: 1` for both bodies, as the sibling tools check them.
        if input.script.as_deref() == Some("") {
            return invalid(None, "script: String must contain at least 1 character(s)");
        }
        if input.path.as_deref() == Some("") {
            return invalid(None, "path: String must contain at least 1 character(s)");
        }
        if input.script.is_some() == input.path.is_some() {
            return invalid(None, SOURCE_ERROR);
        }
        if !skill_loaded(context).await {
            return Validation::Invalid {
                message: format!(
                    "FillWorkflowHole needs the `{DYNAMIC_WORKFLOW_SKILL}` skill loaded in this session before it accepts a hole body. Call the Skill tool with skill \"{DYNAMIC_WORKFLOW_SKILL}\" first, then call FillWorkflowHole again."
                ),
                error_code: Some(SKILL_NOT_LOADED_CODE),
            };
        }
        Validation::Ok
    }

    /// Node `alwaysAsk`: the fill asks in every mode; a session allow rule may answer it.
    async fn check_permissions(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        let Ok(input) = serde_json::from_value::<FillInput>(input.clone()) else {
            return PermissionDecision::Passthrough;
        };
        PermissionDecision::always_ask(
            format!(
                "Fill hole {} of workflow run {}",
                input.hole_id, input.run_id
            ),
            vec![PermissionRule {
                tool: tool_names::FILL_WORKFLOW_HOLE.to_owned(),
                content: None,
            }],
            false,
        )
    }

    /// Reads the body, then asks the run port to fill the hole. A refusal is a failure with the port's text.
    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let input: FillInput =
            serde_json::from_value(input).map_err(|error| ToolError::InvalidInput {
                message: error.to_string(),
            })?;
        let cwd = PathBuf::from(workspace_dir(&context));
        let body = match (input.script, input.path) {
            (Some(script), None) => script,
            // The file read is synchronous I/O: it runs off the async runtime, as AmendWorkflow's read does.
            (None, Some(path)) => {
                tokio::task::spawn_blocking(move || read_revision_file(&cwd, &path, None))
                    .await
                    .map_err(|error| {
                        failed(format!("FillWorkflowHole could not read its body: {error}"))
                    })?
                    .map_err(failed)?
                    .script
            }
            _ => return Err(failed(SOURCE_ERROR.to_owned())),
        };
        let Some(port) = self.port(&context) else {
            return Err(failed(FILL_UNAVAILABLE.to_owned()));
        };
        let outcome = port
            .fill_hole(FillHoleRequest {
                run_id: rust_cli_kernel_api::ids::WorkflowRunId::new(input.run_id.clone()),
                hole_id: input.hole_id.clone(),
                body,
                parent_session_id: Some(context.session.clone()),
            })
            .await
            .map_err(|error| failed(error.message))?;
        match outcome {
            FillHoleOutcome::Filled { phases_added, .. } => {
                let phases = if phases_added.is_empty() {
                    "It added no phases.".to_owned()
                } else {
                    format!("It added the phases {}.", phases_added.join(", "))
                };
                Ok(output_for(
                    format!(
                        "The fill joined run {} at hole \"{}\"; the branch parked there has resumed and the run keeps going in the background. {phases} Do not wait for the run.",
                        input.run_id, input.hole_id
                    ),
                    crate::workflow_card::card(None, true, &[]),
                ))
            }
            FillHoleOutcome::Refused {
                reason,
                message,
                diagnostics,
            } => {
                let text = refusal_text(reason, &input.run_id, &message)
                    + &diagnostic_lines(diagnostics.as_ref());
                Err(failed(text))
            }
        }
    }
}

fn invalid(code: Option<i32>, message: &str) -> Validation {
    Validation::Invalid {
        message: message.to_owned(),
        error_code: code,
    }
}
