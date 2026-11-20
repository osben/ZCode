//! Fork: the run tools ListWorkflowRuns, GetWorkflowRun, ResumeWorkflowRun and ResolveWorkflowQuestion (Node
//! `core/src/tool/handlers/{list-workflow-runs,get-workflow-run,resume-workflow-run,resolve-workflow-question}.ts`;
//! specs/fork-rust-workflow-engine.md, 9.40 and 9.42). Each call asks the run sessions for the calling session's port
//! (`for_session(context.session)`), so a session reads and resumes only through its own run service. The model text is
//! formatted here, not by the helper (9.40, 390): the list and resume formats are a few lines each, and the detail's
//! formatter is `workflow_run_detail.rs`.
//!
//! A missing capability (no run service, or a port without the member) is a business failure with Node's wording, never
//! an empty list or a silent success.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::civil::civil_from_days;
use rust_cli_base::clock::SystemClock;
use rust_cli_kernel_api::ids::{QuestionId, WorkflowRunId};
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation, failed,
    text,
};
use rust_cli_kernel_api::tool_names;
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunSessions, LifecycleStatus, ListQuery,
    ResolveQuestionResult,
};
use rust_cli_prompts::workflow_notice::escape_xml;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::workflow_create::describe_script_path;
use crate::workflow_run_detail::format_detail;
use crate::workflow_tools::{Contract, contract, workspace_dir};

/// Node: the model text of each run tool is one short container, so 24 000 bytes is ample (ListWorkflowRuns allows 50 rows).
const MODEL_BYTES: usize = 24_000;
/// Node `GET_WORKFLOW_RUN_RESULT_BUDGET_BYTES`: a detail carries the run's whole result, so it has the larger budget.
/// Node persists an overflow as an artifact; this build cuts it at the budget (divergence 438).
const DETAIL_MODEL_BYTES: usize = 400_000;
/// Node `ListWorkflowRunsInputSchema`: the default and the clamp of `limit`.
const DEFAULT_LIMIT: i64 = 20;
const MIN_LIMIT: i64 = 1;
const MAX_LIMIT: i64 = 50;
const MS_PER_DAY: i64 = 86_400_000;

/// Node's capability-gap failures. The discriminator is the message prefix, as in Node.
const LIST_UNAVAILABLE: &str = "workflow_introspection_unavailable: this session cannot read workflow runs — workflow execution is not available here, so no run history is reachable. This is a capability gap, not an empty project.";
const RESUME_UNAVAILABLE: &str = "workflow_resume_unavailable: this session cannot resume workflow runs — workflow execution is not available here. This is a capability gap, not a status problem.";
const RESOLVE_UNAVAILABLE: &str = "workflow_question_answering_unavailable: this session cannot answer workflow escalations — workflow execution is not available here. This is a capability gap, not a bad question ID.";

/// Node's backgrounded guidance for a resumed run (the executor's notification path follows it).
const RESUMED_TEXT: &str = " has been resumed and is running in the background. It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    List,
    Get,
    Resume,
    Resolve,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::List => tool_names::LIST_WORKFLOW_RUNS,
            Self::Get => tool_names::GET_WORKFLOW_RUN,
            Self::Resume => tool_names::RESUME_WORKFLOW_RUN,
            Self::Resolve => tool_names::RESOLVE_WORKFLOW_QUESTION,
        }
    }
}

/// The four run tools, in Node's order (ListWorkflowRuns, GetWorkflowRun, ResumeWorkflowRun, ResolveWorkflowQuestion).
pub fn run_tools(runs: Arc<dyn DynamicWorkflowRunSessions>) -> Vec<Arc<dyn Tool>> {
    [Kind::List, Kind::Get, Kind::Resume, Kind::Resolve]
        .into_iter()
        .map(|kind| {
            Arc::new(RunTool {
                kind,
                contract: contract(kind.name()),
                runs: runs.clone(),
            }) as Arc<dyn Tool>
        })
        .collect()
}

pub struct RunTool {
    kind: Kind,
    contract: &'static Contract,
    runs: Arc<dyn DynamicWorkflowRunSessions>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListInput {
    #[serde(default)]
    limit: Option<i64>,
    #[serde(default)]
    statuses: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
/// The input of the tools that name one run: GetWorkflowRun and ResumeWorkflowRun (both take `run_id`, and reject any other key).
struct RunIdInput {
    run_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolveInput {
    question_id: String,
    answer: String,
}

/// A checked input, one per tool.
enum Parsed {
    List(ListQuery),
    Get(String),
    Resume(String),
    Resolve { qid: String, answer: String },
}

fn status_of(name: &str) -> Result<LifecycleStatus, String> {
    match name {
        "completed" => Ok(LifecycleStatus::Completed),
        "errored" => Ok(LifecycleStatus::Errored),
        "pending" => Ok(LifecycleStatus::Pending),
        "running" => Ok(LifecycleStatus::Running),
        "stopped" => Ok(LifecycleStatus::Stopped),
        other => Err(format!(
            "statuses: {other} is not one of completed, errored, pending, running, stopped"
        )),
    }
}

fn non_empty(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        Err(format!("{field}: must not be empty"))
    } else {
        Ok(())
    }
}

fn parse(kind: Kind, input: Value) -> Result<Parsed, String> {
    match kind {
        Kind::List => {
            let parsed: ListInput = serde_json::from_value(input).map_err(|e| e.to_string())?;
            // Node's schema preprocess clamps the limit, so an out-of-range value never reaches the port.
            let limit = parsed
                .limit
                .unwrap_or(DEFAULT_LIMIT)
                .clamp(MIN_LIMIT, MAX_LIMIT);
            let statuses = match parsed.statuses {
                None => None,
                Some(names) => Some(
                    names
                        .iter()
                        .map(|name| status_of(name))
                        .collect::<Result<Vec<_>, _>>()?,
                ),
            };
            Ok(Parsed::List(ListQuery {
                cwd: String::new(),
                limit: usize::try_from(limit).unwrap_or(1),
                statuses,
            }))
        }
        Kind::Get => {
            let parsed: RunIdInput = serde_json::from_value(input).map_err(|e| e.to_string())?;
            non_empty("run_id", &parsed.run_id)?;
            Ok(Parsed::Get(parsed.run_id))
        }
        Kind::Resume => {
            let parsed: RunIdInput = serde_json::from_value(input).map_err(|e| e.to_string())?;
            non_empty("run_id", &parsed.run_id)?;
            Ok(Parsed::Resume(parsed.run_id))
        }
        Kind::Resolve => {
            let parsed: ResolveInput = serde_json::from_value(input).map_err(|e| e.to_string())?;
            non_empty("question_id", &parsed.question_id)?;
            non_empty("answer", &parsed.answer)?;
            Ok(Parsed::Resolve {
                qid: parsed.question_id,
                answer: parsed.answer,
            })
        }
    }
}

/// The failure of a port call: a missing capability gets Node's wording, anything else is the error itself.
fn port_failure(error: DynamicWorkflowRunError, unavailable: &str, what: &str) -> ToolError {
    if error.is_unsupported() {
        failed(unavailable.to_owned())
    } else {
        failed(format!("{what} could not run: {error}"))
    }
}

/// Node `run_not_found`: the failure of an unknown run id. ResumeWorkflowRun and GetWorkflowRun give this one text.
pub(crate) fn run_not_found(run_id: &str) -> String {
    format!(
        "run_not_found: no workflow run with ID {run_id} exists for this project. Use ListWorkflowRuns to see the runs that do."
    )
}

/// Node `formatWorkflowRunTimestamp`: ISO 8601 in UTC, from epoch milliseconds.
pub(crate) fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(MS_PER_DAY);
    let within = ms.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    let hours = within / 3_600_000;
    let minutes = (within / 60_000) % 60;
    let seconds = (within / 1_000) % 60;
    let millis = within % 1_000;
    format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}.{millis:03}Z")
}

/// Node `workflowRunAttribute`: whitespace collapsed to single spaces, then the XML escape.
pub(crate) fn attribute(name: &str, value: &str) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{name}=\"{}\"", escape_xml(&collapsed))
}

/// A JSON field as the text an attribute carries (integers without a fraction, as Node prints them).
pub(crate) fn field_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => match number.as_i64() {
            Some(whole) => whole.to_string(),
            None => number.as_f64().map_or_else(
                || number.to_string(),
                |float| (float.trunc() as i64).to_string(),
            ),
        },
        other => other.to_string(),
    }
}

fn timestamp_text(value: &Value) -> String {
    match value.as_i64() {
        Some(ms) => iso_from_ms(ms),
        None => field_text(value),
    }
}

/// Node `formatListWorkflowRunsModelContent`: one container, one line per run.
fn format_list(page: &Value) -> String {
    let Some(runs) = page.get("runs").and_then(Value::as_array) else {
        return "ListWorkflowRuns returned an invalid result.".to_owned();
    };
    let mut header = vec![attribute("count", &runs.len().to_string())];
    if page.get("truncated") == Some(&Value::Bool(true)) {
        header.push(attribute("truncated", "true"));
    }
    let header = header.join(" ");
    if runs.is_empty() {
        return format!(
            "<workflow_runs {header}>\nNo workflow runs recorded for this project.\n</workflow_runs>"
        );
    }
    let mut lines = vec![format!("<workflow_runs {header}>")];
    for run in runs {
        let get = |key: &str| run.get(key).map(field_text).unwrap_or_default();
        let mut row = vec![
            "<run".to_owned(),
            attribute("id", &get("runId")),
            attribute("status", &get("status")),
        ];
        for (key, name) in [
            ("stopReason", "stop_reason"),
            ("resumedFrom", "resumed_from"),
            ("supersededBy", "superseded_by"),
        ] {
            if run.get(key).is_some() {
                row.push(attribute(name, &get(key)));
            }
        }
        row.push(attribute("label", &get("label")));
        row.push(attribute("label_source", &get("labelSource")));
        row.push(attribute(
            "owned_by_this_session",
            &get("ownedByThisSession"),
        ));
        if run.get("possiblyInterrupted") == Some(&Value::Bool(true)) {
            row.push(attribute("possibly_interrupted", "true"));
        }
        row.push(attribute("spent_tokens", &get("spentTokens")));
        let stamp = |key: &str| run.get(key).map(timestamp_text).unwrap_or_default();
        row.push(attribute("created_at", &stamp("createdAt")));
        row.push(attribute("updated_at", &stamp("updatedAt")));
        row.push("/>".to_owned());
        lines.push(row.join(" "));
    }
    lines.push("</workflow_runs>".to_owned());
    lines.join("\n")
}

/// Node `resumeFailureFor` and the not-found branch: the message the model reads for a refused resume.
fn resume_refusal(reason: &str, run_id: &str, detail: Option<&str>) -> String {
    match reason {
        "not_found" => run_not_found(run_id),
        "compile_failed" => {
            let base = format!(
                "workflow_run_compile_failed: the stored script of run {run_id} no longer compiles against the current workflow facade, so it cannot be replayed as-is. Rewrite it for the current facade and submit it with AmendWorkflow, which keeps the finished work of this run."
            );
            match detail {
                Some(detail) => format!("{base}\n{detail}"),
                None => base,
            }
        }
        "not_resumable" => "workflow_run_not_resumable: this run is not in the resumable set — only a `stopped` run can be resumed (any stop reason except `superseded`). An `errored` run needs a corrected script submitted with AmendWorkflow; a completed run has nothing to resume. Check the status with GetWorkflowRun.".to_owned(),
        "superseded" => format!(
            "workflow_run_superseded: run {run_id} was stopped by an AmendWorkflow and superseded; its unfinished work belongs to the successor run (see GetWorkflowRun's <superseded_by>). Read or amend the successor instead of resuming this run."
        ),
        "already_running" => "workflow_run_already_running: this run is already in flight in this session's workflow runtime. Wait for its completion notification instead of resuming it again.".to_owned(),
        "script_missing" => "workflow_run_script_missing: this run's journal record has no stored script text (it predates script persistence), so there is nothing to re-run. Start a fresh run with CreateWorkflow instead.".to_owned(),
        "script_mismatch" => format!(
            "workflow_run_script_mismatch: the stored script hash for run {run_id} no longer matches the stored script text — the journal record was modified by an outside force. Start a fresh run with CreateWorkflow instead."
        ),
        other => format!(
            "workflow_run_not_resumable: the workflow runtime refused to resume run {run_id} (reason: {other})."
        ),
    }
}

#[async_trait]
impl Tool for RunTool {
    fn name(&self) -> &str {
        self.kind.name()
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
        Some(match self.kind {
            Kind::Get => DETAIL_MODEL_BYTES,
            Kind::List | Kind::Resume | Kind::Resolve => MODEL_BYTES,
        })
    }

    async fn validate_input(&self, input: &Value, _context: &ToolUseContext) -> Validation {
        match parse(self.kind, input.clone()) {
            Ok(_) => Validation::Ok,
            Err(message) => Validation::Invalid {
                message,
                error_code: None,
            },
        }
    }

    /// Node `needsApproval: false` for all four: the listings and the detail read, and resume and answer act on runs the user
    /// already approved (the resume is pinned to the approved script).
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
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let parsed =
            parse(self.kind, input).map_err(|message| ToolError::InvalidInput { message })?;
        let port = self.runs.for_session(&context.session);
        match parsed {
            Parsed::List(mut query) => {
                query.cwd = workspace_dir(&context);
                let page = port
                    .list_runs(query)
                    .await
                    .map_err(|error| port_failure(error, LIST_UNAVAILABLE, "ListWorkflowRuns"))?;
                let mut output = text(format_list(&page));
                output.display = page;
                Ok(output)
            }
            Parsed::Get(run_id) => {
                let detail = port
                    .get_run_detail(&WorkflowRunId::new(run_id.clone()))
                    .await
                    .map_err(|error| port_failure(error, LIST_UNAVAILABLE, "GetWorkflowRun"))?;
                let Some(mut detail) = detail else {
                    return Err(failed(run_not_found(&run_id)));
                };
                // Node: the script file is named relative to the working directory, since the model will edit that file.
                if let Some(path) = detail
                    .get("scriptPath")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                {
                    let cwd = std::path::PathBuf::from(workspace_dir(&context));
                    detail["scriptPath"] =
                        json!(describe_script_path(std::path::Path::new(&path), &cwd));
                }
                let now = i64::try_from(SystemClock::utc().now_ms()).unwrap_or(i64::MAX);
                let mut output = text(format_detail(&detail, now));
                output.display = detail;
                Ok(output)
            }
            Parsed::Resume(run_id) => {
                let answer = port
                    .resume(&WorkflowRunId::new(run_id.clone()))
                    .await
                    .map_err(|error| {
                        port_failure(error, RESUME_UNAVAILABLE, "ResumeWorkflowRun")
                    })?;
                if answer.get("ok") == Some(&Value::Bool(true)) {
                    let started = answer
                        .get("runId")
                        .and_then(Value::as_str)
                        .unwrap_or(&run_id)
                        .to_owned();
                    let mut output = text(format!("The workflow run {started}{RESUMED_TEXT}"));
                    output.display = json!({"ok": true, "runId": started});
                    return Ok(output);
                }
                let reason = answer
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let detail = answer.get("message").and_then(Value::as_str);
                Err(failed(resume_refusal(reason, &run_id, detail)))
            }
            Parsed::Resolve { qid, answer } => {
                let result = port
                    .resolve_question(&QuestionId::new(qid), &answer)
                    .await
                    .map_err(|error| {
                        port_failure(error, RESOLVE_UNAVAILABLE, "ResolveWorkflowQuestion")
                    })?;
                match result {
                    ResolveQuestionResult::Resolved { qid } => {
                        let mut output = text(format!(
                            "Answer delivered for question {qid}. The subagent that asked has resumed its turn with your answer; the run keeps going as before."
                        ));
                        output.display = json!({"ok": true, "qid": qid.as_str()});
                        Ok(output)
                    }
                    // The service owns the refusal text (Node passes it through unchanged).
                    ResolveQuestionResult::Refused { message, .. } => Err(failed(message)),
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "workflow_run_tools_tests.rs"]
mod tests;
