//! Fork: the EvalWorkflowSnippet tool (Node `core/src/tool/handlers/eval-workflow-snippet.ts`; specs/fork-rust-workflow-engine.md,
//! W7-8c, section 9.28).
//!
//! The order is Node's: the input is checked (its shape, then one source, then the Skill gate). The permission decision
//! reads the snippet (a `path` is read whole and bounded to the workspace) and compiles it. A snippet with a world.run command
//! asks; any other snippet proceeds. The call runs the approved bytes on the snippet service and turns the outcome into
//! Node's model text. Nothing persists: the snippet's run is transient.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use rust_cli_fs::read_text;
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation, failed,
    text,
};
use rust_cli_kernel_api::tool_names;
use rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic;
use rust_cli_kernel_api::workflow_snippet::{
    SnippetCheck, SnippetOutcome, SnippetRequest, WorkflowSnippetPort,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::workflow_save::{describe, diagnostic_value};
use crate::workflow_tools::{
    Contract, DYNAMIC_WORKFLOW_SKILL, contract, skill_loaded, workspace_dir,
};
use crate::workspace_path::{Refusal, contain};

/// The refusal code for a bad source or a bad timeout (Node `EVAL_WORKFLOW_SNIPPET_FAILURE_CODE`).
const FAILURE_CODE: i32 = 400;
/// The refusal code for a missing Skill read (Node `WORKFLOW_SKILL_NOT_LOADED_CODE`).
const SKILL_NOT_LOADED_CODE: i32 = 428;
/// Node `EVAL_WORKFLOW_SNIPPET_MODEL_BYTES`.
pub const EVAL_MODEL_BYTES: usize = 24_000;
/// Node `EVAL_WORKFLOW_SNIPPET_DEFAULT_TIMEOUT_MS`, and the bounds of `timeoutMs`.
const DEFAULT_TIMEOUT_MS: u64 = 60_000;
const MIN_TIMEOUT_MS: i64 = 1_000;
const MAX_TIMEOUT_MS: i64 = 600_000;
/// Approvals waiting for their call. A decision that is refused never reaches its call, so the table is bounded.
const APPROVAL_CAP: usize = 256;

/// Node `EVAL_WORKFLOW_SNIPPET_SOURCE_CONFLICT_ERROR`.
pub const EVAL_SOURCE_CONFLICT_ERROR: &str = "Provide exactly one snippet source: `code` for the snippet inline, or `path` for a file holding it. Passing both is ambiguous.";
/// Node `EVAL_WORKFLOW_SNIPPET_SOURCE_MISSING_ERROR`, with Node's `WORKFLOW_SOURCE_MISSING_HINT`.
pub const EVAL_SOURCE_MISSING_ERROR: &str = "No snippet source arrived. Pass `code` for the snippet inline, or `path` for a file holding it. If you did pass one, the call's arguments were not valid JSON, and a call that does not parse arrives empty. The usual cause is an unescaped backslash or double quote in the inline source: inside a JSON string a regex's `\\d` must be written `\\\\d`. Escape it, or write the source to a file and pass `path`.";
/// Node's permission reason for a snippet with a world.run command: the confirmation's text.
const WORLD_RUN_CONFIRMATION: &str =
    "evalWorkflowSnippet.runConfirmation: snippets carrying world.run commands must be confirmed";
/// Node `NOT_EXECUTED_NOTE`.
const NOT_EXECUTED_NOTE: &str =
    "NOTE: The snippet was NOT executed — fix the errors above and call the tool again.";

/// The input (Node `EvalWorkflowSnippetInputSchema`, as the model sends it). `script` is not a model field.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EvalInput {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default, rename = "timeoutMs")]
    timeout_ms: Option<i64>,
}

/// The snippet a call runs: its text, and the path it was read from (as the model reads it), for the diagnostics' location.
#[derive(Debug, Clone, PartialEq)]
struct Source {
    code: String,
    described: Option<String>,
}

/// What the permission decision approved, keyed by the call's tool-use id: the call runs these bytes, not a fresh read.
pub struct EvalWorkflowSnippetTool {
    contract: &'static Contract,
    port: Arc<dyn WorkflowSnippetPort>,
    approvals: Mutex<VecDeque<(ToolUseId, Source)>>,
}

impl EvalWorkflowSnippetTool {
    pub fn new(port: Arc<dyn WorkflowSnippetPort>) -> Self {
        Self {
            contract: contract(tool_names::EVAL_WORKFLOW_SNIPPET),
            port,
            approvals: Mutex::new(VecDeque::new()),
        }
    }

    fn remember(&self, tool_use: ToolUseId, source: Source) {
        let mut approvals = self
            .approvals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The oldest approval goes first, and only that one (the same rule as SaveWorkflow's table).
        if approvals.len() >= APPROVAL_CAP {
            approvals.pop_front();
        }
        approvals.push_back((tool_use, source));
    }

    fn take_approval(&self, tool_use: &ToolUseId) -> Option<Source> {
        let mut approvals = self
            .approvals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let position = approvals.iter().position(|(id, _)| id == tool_use)?;
        approvals.remove(position).map(|(_, source)| source)
    }
}

/// Node's zod checks of the model's fields (the `min`, `int` and range rules). A failure carries no error code: the schema
/// refusal in Node has none either.
fn schema_failure(input: &EvalInput) -> Option<String> {
    if input.code.as_deref() == Some("") {
        return Some("code: String must contain at least 1 character(s)".to_owned());
    }
    if input.path.as_deref() == Some("") {
        return Some("path: String must contain at least 1 character(s)".to_owned());
    }
    match input.timeout_ms {
        Some(timeout) if timeout < MIN_TIMEOUT_MS => Some(format!(
            "timeoutMs: Number must be greater than or equal to {MIN_TIMEOUT_MS}"
        )),
        Some(timeout) if timeout > MAX_TIMEOUT_MS => Some(format!(
            "timeoutMs: Number must be less than or equal to {MAX_TIMEOUT_MS}"
        )),
        _ => None,
    }
}

/// Node `readWorkflowScriptFile` with `parseFrontmatter: false`: the whole file is the snippet.
fn read_path(cwd: &Path, input_path: &str) -> Result<Source, String> {
    // The shared containment check: the lexical path and the real path (symlinks resolved) both stay inside, and the read
    // goes to the real path that was checked.
    let contained = match contain(cwd, input_path) {
        Ok(contained) => contained,
        Err(Refusal::Outside) => {
            return Err(format!(
                "The workflow script file {input_path} is outside the workspace. Pass a `path` inside it, or submit the script inline."
            ));
        }
        Err(Refusal::Unresolved(error)) => {
            let described = describe(&cwd.join(input_path), cwd);
            return Err(format!(
                "The workflow script file {described} could not be read: {error}. Pass `path` for a file that exists, or submit the script inline."
            ));
        }
    };
    let described = describe(&contained.named, cwd);
    let code = read_text(&contained.real).map_err(|error| {
        format!(
            "The workflow script file {described} could not be read: {error}. Pass `path` for a file that exists, or submit the script inline."
        )
    })?;
    Ok(Source {
        code,
        described: Some(described),
    })
}

/// The snippet of a call: the inline `code`, or the file at `path`.
fn resolve_source(input: &EvalInput, cwd: &Path) -> Result<Source, String> {
    match (&input.code, &input.path) {
        (Some(code), _) => Ok(Source {
            code: code.clone(),
            described: None,
        }),
        (None, Some(path)) => read_path(cwd, path),
        (None, None) => Err(EVAL_SOURCE_MISSING_ERROR.to_owned()),
    }
}

/// Node `formatWorkflowDiagnosticLines`: positioned in the file when the snippet came from one, else in the snippet.
fn diagnostic_lines(diagnostics: &[WorkflowDiagnostic], described: Option<&str>) -> Vec<String> {
    diagnostics
        .iter()
        .map(|diagnostic| match described {
            None => format!(
                "L{}:C{} {}",
                diagnostic.line, diagnostic.column, diagnostic.message
            ),
            Some(path) => format!(
                "{path}:L{}:C{} {}",
                diagnostic.line, diagnostic.column, diagnostic.message
            ),
        })
        .collect()
}

/// Node `renderLogs`: nothing without logs, else a section with each line and a marker for truncation.
fn logs_section(logs: &[String], truncated: bool) -> Vec<String> {
    if logs.is_empty() {
        return Vec::new();
    }
    let mut lines = vec![String::new(), "Logs:".to_owned()];
    lines.extend(logs.iter().map(|line| format!("- {line}")));
    if truncated {
        lines.push("- … (logs truncated)".to_owned());
    }
    lines
}

/// Node `serializeWorkflowArtifact`: a string is shown as it is, anything else as indented JSON.
fn serialized(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_else(|_| other.to_string()),
    }
}

/// The model text and the display of one settled run (Node's `handler` output and `formatModelContent`).
fn output_of(outcome: SnippetOutcome, described: Option<&str>, duration_ms: u64) -> ToolOutput {
    let (ok, diagnostics, logs, response) = match outcome {
        SnippetOutcome::Diagnostics(diagnostics) => {
            let mut lines = vec!["The snippet has errors:".to_owned()];
            lines.extend(diagnostic_lines(&diagnostics, described));
            lines.push(String::new());
            lines.push(NOT_EXECUTED_NOTE.to_owned());
            (false, diagnostics, Vec::new(), lines.join("\n"))
        }
        SnippetOutcome::Failed {
            code,
            message,
            logs,
            logs_truncated,
        } => {
            let mut lines = vec![format!("The snippet failed ({code}): {message}")];
            lines.extend(logs_section(&logs, logs_truncated));
            (false, Vec::new(), logs, lines.join("\n"))
        }
        SnippetOutcome::Completed {
            value,
            logs,
            logs_truncated,
        } => {
            let mut lines = vec![format!("The snippet completed in {duration_ms}ms.")];
            lines.push(match &value {
                Some(value) => format!("Return value:\n{}", serialized(value)),
                None => "It returned no value.".to_owned(),
            });
            lines.extend(logs_section(&logs, logs_truncated));
            (true, Vec::new(), logs, lines.join("\n"))
        }
    };
    let mut output = text(response.clone());
    output.display = json!({
        "ok": ok,
        "diagnostics": diagnostics.iter().map(diagnostic_value).collect::<Vec<_>>(),
        "logs": logs,
        "response": response,
        "durationMs": duration_ms,
    });
    output
}

#[async_trait]
impl Tool for EvalWorkflowSnippetTool {
    fn name(&self) -> &str {
        tool_names::EVAL_WORKFLOW_SNIPPET
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

    /// Node `readOnly: false`: a snippet with a world.run command can act on the repository.
    fn is_read_only(&self, _input: &Value) -> bool {
        self.contract.read_only
    }

    fn is_destructive(&self, _input: &Value) -> bool {
        self.contract.destructive
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        self.contract.concurrent_safe
    }

    fn result_budget_truncate_bytes(&self) -> Option<usize> {
        Some(EVAL_MODEL_BYTES)
    }

    /// The input's shape, one source, and the Skill gate. No disk access: a `path` is read by the permission decision.
    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        let input: EvalInput = match serde_json::from_value(input.clone()) {
            Ok(input) => input,
            Err(error) => {
                return Validation::Invalid {
                    message: error.to_string(),
                    error_code: None,
                };
            }
        };
        if let Some(message) = schema_failure(&input) {
            return Validation::Invalid {
                message,
                error_code: None,
            };
        }
        if input.code.is_some() == input.path.is_some() {
            let message = if input.code.is_some() {
                EVAL_SOURCE_CONFLICT_ERROR
            } else {
                EVAL_SOURCE_MISSING_ERROR
            };
            return Validation::Invalid {
                message: message.to_owned(),
                error_code: Some(FAILURE_CODE),
            };
        }
        if !skill_loaded(context).await {
            return Validation::Invalid {
                message: format!(
                    "EvalWorkflowSnippet needs the `{DYNAMIC_WORKFLOW_SKILL}` skill loaded in this session before it accepts a snippet. Call the Skill tool with skill \"{DYNAMIC_WORKFLOW_SKILL}\" first — it carries the facade declarations the snippet is checked against, the authoring rules and this tool's full contract — then call EvalWorkflowSnippet again. Nothing was started."
                ),
                error_code: Some(SKILL_NOT_LOADED_CODE),
            };
        }
        Validation::Ok
    }

    /// Node `prepareApproval`: the snippet is read and compiled here. One with a world.run command asks; any other proceeds,
    /// and so does one that does not compile (the call reports its diagnostics). The snippet is kept for the call.
    async fn check_permissions(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> PermissionDecision {
        let Ok(input) = serde_json::from_value::<EvalInput>(input.clone()) else {
            return PermissionDecision::Passthrough;
        };
        let cwd = PathBuf::from(workspace_dir(context));
        let source = match resolve_source(&input, &cwd) {
            Ok(source) => source,
            Err(message) => return PermissionDecision::Deny { message },
        };
        let check = match self.port.check(&source.code).await {
            Ok(check) => check,
            Err(error) => {
                return PermissionDecision::Deny {
                    message: error.message,
                };
            }
        };
        let world_run = matches!(check, SnippetCheck::Ready { world_run: true });
        self.remember(context.tool_use.clone(), source);
        if world_run {
            PermissionDecision::ask(WORLD_RUN_CONFIRMATION, Vec::new())
        } else {
            PermissionDecision::Allow {
                updated_input: None,
            }
        }
    }

    /// Runs the approved snippet (or reads it again when no approval waits for this call) and reports the outcome.
    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let input: EvalInput =
            serde_json::from_value(input).map_err(|error| ToolError::InvalidInput {
                message: error.to_string(),
            })?;
        let cwd = PathBuf::from(workspace_dir(&context));
        let source = match self.take_approval(&context.tool_use) {
            Some(source) => source,
            None => {
                // No confirmation waits for this call. A snippet with world.run is not run on that account: the model
                // calls again, and the permission decision asks (the same rule as SaveWorkflow's call).
                let source = resolve_source(&input, &cwd).map_err(failed)?;
                let check = self
                    .port
                    .check(&source.code)
                    .await
                    .map_err(|error| failed(error.message))?;
                if matches!(check, SnippetCheck::Ready { world_run: true }) {
                    return Err(failed(
                        "EvalWorkflowSnippet has no confirmation for this snippet, so nothing was run. Call it again.".to_owned(),
                    ));
                }
                source
            }
        };
        let timeout_ms = input
            .timeout_ms
            .map_or(DEFAULT_TIMEOUT_MS, i64::unsigned_abs);
        let started = Instant::now();
        let Source { code, described } = source;
        let outcome = self
            .port
            .eval(SnippetRequest {
                code,
                cwd,
                timeout_ms,
            })
            .await
            .map_err(|error| failed(error.message))?;
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        Ok(output_of(outcome, described.as_deref(), duration_ms))
    }
}

#[cfg(test)]
#[path = "workflow_eval_snippet_tests.rs"]
mod tests;
