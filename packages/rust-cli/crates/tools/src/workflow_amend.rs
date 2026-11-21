//! Fork: the AmendWorkflow tool (Node `core/src/tool/handlers/amend-workflow.ts`, `amend-workflow-resolve.ts` and
//! `amend-workflow-source.ts`; specs/fork-rust-workflow-engine.md, 9.43, W7-10).
//!
//! A revision checks its script the way CreateWorkflow does, asks, and then goes to the run port, which stops the live
//! predecessor (as superseded by the new run) and starts the successor. The script comes from `script`, from `path`, or,
//! when both are omitted, from the predecessor's stored script. A script that does not check stops nothing.
//!
//! A call that changes only `max_concurrency` retunes a live run in place (9.52, divergence 455, Node
//! `amend-workflow-retune.ts`): no script, no window, no successor. A run that settles in the race falls back to a
//! revision, which the owner exemption lets through without a window (Node's `isAmendWorkflowOwnedPredecessor`). The
//! subagent model, script-named models and the GUI window are not built (divergences 456 to 459).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::ToolUseId;
use rust_cli_kernel_api::permission::{PermissionDecision, PermissionRule};
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, Validation, failed,
};
use rust_cli_kernel_api::tool_names;
use rust_cli_kernel_api::workflow_analysis::{WorkflowAnalysis, WorkflowAnalyzer};
use rust_cli_kernel_api::workflow_run::{
    AmendRefusalReason, AmendRequest, AmendResult, DynamicWorkflowRunPort,
    DynamicWorkflowRunSessions, RetuneOutcome, RetuneRefusal, RetuneRequest,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use rust_cli_fs::read_text;

use crate::saved_workflow::{parse as parse_saved, starts_with_sentinel};
use crate::workflow_create::{
    CREATE_MODEL_BYTES, DIAGNOSTICS_NOT_EXECUTED_NOTE, DRAFTS_DIR, EXECUTION_UNAVAILABLE_NOTE,
    Location, Origin, Resolved, concurrency_sentence, describe_script_path, diagnostic_lines,
    diagnostics_note, output_for, write_draft_file,
};
use crate::workflow_tools::{
    Contract, DYNAMIC_WORKFLOW_SKILL, contract, is_amend_workflow_owned_predecessor,
    live_elsewhere, owned_run_facts, run_detail, skill_loaded, workspace_dir,
};
use crate::workspace_path::{Refusal, contain};

/// Node `CREATE_WORKFLOW_FAILURE_CODE`-style business refusal of the input.
const FAILURE_CODE: i32 = 400;
/// The skill refusal code (Node `WORKFLOW_SKILL_NOT_LOADED_CODE`).
const SKILL_NOT_LOADED_CODE: i32 = 428;
/// Kept approvals (a refused decision never reaches its call, so the table is bounded).
const APPROVAL_CAP: usize = 256;
/// Node `MAX_DRAFT_ATTEMPTS`-style draft name, used for an inline revision without a name.
const DEFAULT_DRAFT_NAME: &str = "workflow";
const SUBAGENT_MODEL_UNAVAILABLE: &str =
    "This host cannot choose a subagent model; omit subagent_model.";
const SOURCE_CONFLICT: &str = "Provide at most one script source: `script` for the whole revised script inline, or `path` for its file. Passing both is ambiguous.";
const RETUNE_UNAVAILABLE: &str = "workflow_retune_unavailable: this host cannot change the parallelism of a live run in place, so this call has nothing to change. Nothing was stopped, created or changed.";

/// Node `heldElsewhereFailure`: the revision of another session's running run.
fn held_elsewhere(run_id: &str) -> String {
    format!(
        "workflow_run_held_elsewhere: run {run_id} is running in another session's process, so this session cannot stop it to start a revision. Nothing was stopped or created. Amend it from the session that started it, or amend it from here once it has ended."
    )
}

/// The input (Node `AmendWorkflowInputSchema`, as the model sends it).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct AmendInput {
    run_id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    script: Option<String>,
    #[serde(default)]
    path: Option<String>,
    /// A positive integer, `null` for the default, or omitted to keep the predecessor's limit (Node's three states).
    /// `null` must stay distinct from omission, which serde's `Option` would not do on its own.
    #[serde(default, deserialize_with = "present_value")]
    max_concurrency: Option<Value>,
    #[serde(default)]
    subagent_model: Option<Value>,
}

/// A field that is present is `Some`, even when its value is `null`: the call's `null` is a value, not an omission.
fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    <Value as Deserialize>::deserialize(deserializer).map(Some)
}

impl AmendInput {
    /// The three states of `max_concurrency`: a number, `null`, or omitted.
    fn limit(&self) -> Result<Option<Option<u64>>, String> {
        match &self.max_concurrency {
            None => Ok(None),
            Some(Value::Null) => Ok(Some(None)),
            Some(Value::Number(number)) => match number.as_u64() {
                Some(whole) if whole >= 1 => Ok(Some(Some(whole))),
                Some(_) => Err("max_concurrency: Number must be greater than 0".to_owned()),
                // A negative whole number is a range error; a fraction or a huge number is a type error.
                None if number.as_i64().is_some_and(|whole| whole < 1) => {
                    Err("max_concurrency: Number must be greater than 0".to_owned())
                }
                None => Err("max_concurrency: Expected an integer".to_owned()),
            },
            Some(_) => Err("max_concurrency: Expected an integer, null, or omitted".to_owned()),
        }
    }

    /// Whether the call carries a script (inline or by file), which is what the skill gate and the approval read.
    fn carries_script(&self) -> bool {
        self.script.is_some() || self.path.is_some()
    }

    /// The call changes only the parallelism of a run: Node's in-place route, answered by `retune` (9.52).
    fn is_concurrency_only(&self) -> bool {
        self.max_concurrency.is_some()
            && self.script.is_none()
            && self.path.is_none()
            && self.name.is_none()
            && self.subagent_model.is_none()
    }
}

/// A revision the permission decision read and checked, kept for its call.
struct Pending {
    resolved: Resolved,
    analysis: WorkflowAnalysis,
    /// The script is the predecessor's, kept (Node `script_inherited`).
    inherited: bool,
}

#[derive(Default)]
struct Approvals {
    by_id: HashMap<ToolUseId, Pending>,
    order: VecDeque<ToolUseId>,
}

pub struct AmendWorkflowTool {
    contract: &'static Contract,
    analyzer: Arc<dyn WorkflowAnalyzer>,
    /// The run service's per-session ports: an amend goes through the calling session's port.
    runs: Option<Arc<dyn DynamicWorkflowRunSessions>>,
    approvals: Mutex<Approvals>,
}

impl AmendWorkflowTool {
    pub fn new(
        analyzer: Arc<dyn WorkflowAnalyzer>,
        runs: Option<Arc<dyn DynamicWorkflowRunSessions>>,
    ) -> Self {
        Self {
            contract: contract(tool_names::AMEND_WORKFLOW),
            analyzer,
            runs,
            approvals: Mutex::new(Approvals::default()),
        }
    }

    fn approvals(&self) -> std::sync::MutexGuard<'_, Approvals> {
        self.approvals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn remember(&self, tool_use: ToolUseId, pending: Pending) {
        let mut approvals = self.approvals();
        if approvals.by_id.insert(tool_use.clone(), pending).is_none() {
            approvals.order.push_back(tool_use);
        }
        while approvals.order.len() > APPROVAL_CAP {
            if let Some(oldest) = approvals.order.pop_front() {
                approvals.by_id.remove(&oldest);
            }
        }
    }

    fn take_approval(&self, tool_use: &ToolUseId) -> Option<Pending> {
        let mut approvals = self.approvals();
        let taken = approvals.by_id.remove(tool_use)?;
        approvals.order.retain(|id| id != tool_use);
        Some(taken)
    }

    fn forget(&self, tool_use: &ToolUseId) {
        drop(self.take_approval(tool_use));
    }

    fn port(&self, context: &ToolUseContext) -> Option<Arc<dyn DynamicWorkflowRunPort>> {
        self.runs
            .as_ref()
            .map(|runs| runs.for_session(&context.session))
    }

    /// Node `resolveInput` for a revision: the script, read once. `path` is read from its file; an omitted script is the
    /// predecessor's stored one (Node's inheritance, read through the port).
    async fn resolve(
        &self,
        input: &AmendInput,
        cwd: &Path,
        port: Option<&Arc<dyn DynamicWorkflowRunPort>>,
    ) -> Result<(Resolved, bool), String> {
        if let Some(path) = &input.path {
            let cwd_owned = cwd.to_path_buf();
            let path_owned = path.clone();
            let name = input.name.clone();
            let resolved = tokio::task::spawn_blocking(move || {
                read_revision_file(&cwd_owned, &path_owned, name)
            })
            .await
            .unwrap_or_else(|error| {
                Err(format!("AmendWorkflow could not read its script: {error}"))
            })?;
            return Ok((resolved, false));
        }
        if let Some(script) = &input.script {
            return Ok((inline(script.clone(), input.name.clone()), false));
        }
        let host_cannot_read = format!(
            "workflow_amend_script_unavailable: this host cannot read run {}'s stored script, so the script cannot be omitted here — pass the whole script as `script`, or its file as `path`. Nothing was stopped or created.",
            input.run_id
        );
        let Some(port) = port else {
            return Err(host_cannot_read);
        };
        let run = rust_cli_kernel_api::ids::WorkflowRunId::new(input.run_id.clone());
        match port.get_script(&run).await {
            // A failed read is a failure of this call (retry, or the cause shown), not a run without a script.
            Err(error) if error.is_unsupported() => Err(host_cannot_read),
            Err(error) => Err(format!(
                "AmendWorkflow could not read run {}'s stored script: {}. Nothing was stopped or created.",
                input.run_id, error.message
            )),
            Ok(Some(script)) => Ok((inline(script, input.name.clone()), true)),
            Ok(None) => Err(format!(
                "workflow_amend_script_unavailable: run {} has no stored script to keep, so the script cannot be omitted here — pass the whole script as `script`, or its file as `path`. Nothing was stopped or created.",
                input.run_id
            )),
        }
    }
}

/// The file of a revision (Node `resolveAmendScript`, `path`): the containment and reads are CreateWorkflow's, and the
/// metadata block is stripped with its declarations ignored. A revision carries no arguments (they are facts of the
/// predecessor run), so a file that declares some is amended as it stands, not refused for missing ones.
pub(crate) fn read_revision_file(
    cwd: &Path,
    path: &str,
    name: Option<String>,
) -> Result<Resolved, String> {
    let contained = match contain(cwd, path) {
        Ok(contained) => contained,
        Err(Refusal::Outside) => {
            return Err(format!(
                "The workflow script file {path} is outside the workspace. Pass a `path` inside it, or submit the script inline."
            ));
        }
        Err(Refusal::Unresolved(error)) => {
            return Err(format!(
                "The workflow script file {} could not be read: {error}. Pass `path` for a file that exists, or submit the script inline.",
                describe_script_path(&cwd.join(path), cwd)
            ));
        }
    };
    let absolute = contained.named;
    let described = describe_script_path(&absolute, cwd);
    let source = read_text(&contained.real).map_err(|error| {
        format!(
            "The workflow script file {described} could not be read: {error}. Pass `path` for a file that exists, or submit the script inline."
        )
    })?;
    let (script, body_offset) = if starts_with_sentinel(&source) {
        match parse_saved(&source) {
            Ok(parsed) => (parsed.script, parsed.body_line_offset),
            Err(error) => {
                return Err(format!(
                    "The workflow script file {described} starts with a `/* zcode-workflow` metadata block that could not be read ({}): {}. Fix the block in that file, or remove it and pass the script alone.",
                    error.reason(),
                    error.detail()
                ));
            }
        }
    } else {
        (source, 0)
    };
    Ok(Resolved {
        script,
        name,
        args: None,
        origin: Origin::Path { absolute },
        body_offset,
    })
}

/// An inline script: a draft is written for it (Origin::Inline), named after the revision.
fn inline(script: String, name: Option<String>) -> Resolved {
    Resolved {
        script,
        name,
        args: None,
        origin: Origin::Inline,
        body_offset: 0,
    }
}

/// The model-facing text of a refused amend (Node `amendRefusalFor`; the message prefix is the discriminator).
fn refusal_text(reason: AmendRefusalReason, run_id: &str) -> String {
    match reason {
        AmendRefusalReason::RunNotFound => format!(
            "run_not_found: no workflow run with ID {run_id} exists for this project. Use ListWorkflowRuns to see the runs that do. Nothing was stopped or created: `run_id` pointed at a run that does not exist — pass an existing run's ID (see ListWorkflowRuns), or start a fresh run with CreateWorkflow."
        ),
        AmendRefusalReason::MissingBoundaries => format!(
            "workflow_amend_missing_boundaries: run {run_id}'s journal predates transcript-boundary bookkeeping (or its boundaries were never recorded), so its finished asks cannot seed an amended run — there is no fallback. Submit this script as a fresh CreateWorkflow instead. Nothing was stopped or created."
        ),
    }
}

/// The confirmation names the revision; the wording is CreateWorkflow's, with the revision said.
fn confirmation_message(name: Option<&str>) -> String {
    match name {
        Some(name) => format!("Run revised workflow '{name}' in the background"),
        None => "Run the revised workflow script in the background".to_owned(),
    }
}

fn invalid(code: Option<i32>, message: &str) -> Validation {
    Validation::Invalid {
        message: message.to_owned(),
        error_code: code,
    }
}

#[async_trait]
impl Tool for AmendWorkflowTool {
    fn name(&self) -> &str {
        tool_names::AMEND_WORKFLOW
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

    fn result_budget_truncate_bytes(&self) -> Option<usize> {
        Some(CREATE_MODEL_BYTES)
    }

    /// The input's shape and source rules, the skill gate (a revision that carries a script) and the refused fields.
    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        let input: AmendInput = match serde_json::from_value(input.clone()) {
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
        if input.name.as_deref() == Some("") {
            return invalid(None, "name: String must contain at least 1 character(s)");
        }
        if input.path.as_deref() == Some("") {
            return invalid(None, "path: String must contain at least 1 character(s)");
        }
        if input.script.as_deref() == Some("") {
            return invalid(None, "script: String must contain at least 1 character(s)");
        }
        if let Err(message) = input.limit() {
            return invalid(None, &message);
        }
        if input.subagent_model.is_some() {
            return invalid(Some(FAILURE_CODE), SUBAGENT_MODEL_UNAVAILABLE);
        }
        if input.script.is_some() && input.path.is_some() {
            return invalid(Some(FAILURE_CODE), SOURCE_CONFLICT);
        }
        if input.carries_script() && !skill_loaded(context).await {
            return Validation::Invalid {
                message: format!(
                    "AmendWorkflow needs the `{DYNAMIC_WORKFLOW_SKILL}` skill loaded in this session before it accepts a script. Call the Skill tool with skill \"{DYNAMIC_WORKFLOW_SKILL}\" first, then call AmendWorkflow again. Nothing was stopped or created."
                ),
                error_code: Some(SKILL_NOT_LOADED_CODE),
            };
        }
        // Node `heldElsewhereFailure`, after the retune route: another session's run in flight (running, pending or parked at
        // a hole) cannot be stopped from here.
        if !input.is_concurrency_only()
            && let Some(detail) = run_detail(self.port(context).as_ref(), &input.run_id).await
            && live_elsewhere(&detail)
        {
            return invalid(Some(FAILURE_CODE), &held_elsewhere(&input.run_id));
        }
        Validation::Ok
    }

    /// The revision is read and checked here. A script that checks asks, always; the read bytes are kept for the call.
    /// A script that does not check proceeds, so the call can report its diagnostics without a confirmation.
    async fn check_permissions(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> PermissionDecision {
        let Ok(input) = serde_json::from_value::<AmendInput>(input.clone()) else {
            return PermissionDecision::Passthrough;
        };
        // Node's prepareApproval: a retune has no script to show, so it opens no window, for any owner.
        if input.is_concurrency_only() {
            return PermissionDecision::Allow {
                updated_input: None,
            };
        }
        let cwd = PathBuf::from(workspace_dir(context));
        let port = self.port(context);
        let Ok((resolved, inherited)) = self.resolve(&input, &cwd, port.as_ref()).await else {
            // The call refuses with the same message; nothing is asked about.
            self.forget(&context.tool_use);
            return PermissionDecision::Allow {
                updated_input: None,
            };
        };
        let analysis = match self.analyzer.analyze(&resolved.script).await {
            Ok(analysis) => analysis,
            Err(error) => {
                self.forget(&context.tool_use);
                return PermissionDecision::Deny {
                    message: error.message,
                };
            }
        };
        let checks = analysis.ok;
        let name = resolved.name.clone();
        self.remember(
            context.tool_use.clone(),
            Pending {
                resolved,
                analysis,
                inherited,
            },
        );
        if !checks {
            return PermissionDecision::Allow {
                updated_input: None,
            };
        }
        // Node `rule.session.workflowOwner`: a revision of a run this session started, that the user did not stop,
        // opens no window. This host's amend names no new model, so it never introduces a provider.
        let predecessor = owned_run_facts(port.as_ref(), &input.run_id).await;
        if is_amend_workflow_owned_predecessor(&predecessor) {
            return PermissionDecision::Allow {
                updated_input: None,
            };
        }
        PermissionDecision::always_ask(
            confirmation_message(name.as_deref()),
            vec![PermissionRule {
                tool: tool_names::AMEND_WORKFLOW.to_owned(),
                content: None,
            }],
            false,
        )
    }

    /// Checks the revision, writes its draft, and asks the run port to amend. A script that does not check gets its
    /// diagnostics and no amend. A refusal is a failure with the port's refusal text.
    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let input: AmendInput =
            serde_json::from_value(input).map_err(|error| ToolError::InvalidInput {
                message: error.to_string(),
            })?;
        let cwd = PathBuf::from(workspace_dir(&context));
        let port = self.port(&context);
        if input.is_concurrency_only() {
            let Some(port) = port else {
                return Err(failed(RETUNE_UNAVAILABLE.to_owned()));
            };
            return self.retune(&input, &context, &cwd, port).await;
        }
        let pending = match self.take_approval(&context.tool_use) {
            Some(pending) => pending,
            None => {
                let (resolved, inherited) = self
                    .resolve(&input, &cwd, port.as_ref())
                    .await
                    .map_err(failed)?;
                let analysis = self
                    .analyzer
                    .analyze(&resolved.script)
                    .await
                    .map_err(|error| failed(error.message))?;
                // The same rule as CreateWorkflow: a script that checks needs its approval, inherited or not.
                if analysis.ok {
                    return Err(failed(
                        "AmendWorkflow has no confirmation for this script, so nothing was stopped. Call it again.".to_owned(),
                    ));
                }
                Pending {
                    resolved,
                    analysis,
                    inherited,
                }
            }
        };
        self.finish_revision(&input, &context, &cwd, port, pending)
            .await
    }
}

/// The model-facing text of an in-place retune (Node `retuneResponse`). It must stand alone: it is the only fact the
/// model and the card receive, and the wording is kept exactly as Node's.
fn retune_text(run_id: &str, max_concurrency: f64, default_concurrency: f64) -> String {
    let count = if max_concurrency == 1.0 {
        "at most 1 subagent runs at once".to_owned()
    } else {
        format!("at most {max_concurrency} subagents run at once")
    };
    let bound = if max_concurrency == default_concurrency {
        format!("{count} (the default)")
    } else {
        count
    };
    format!(
        "Applied to the running run {run_id}; {bound}. Run {run_id} keeps running under it: nothing was stopped and no new run was started."
    )
}

/// Node `describeBoundInForce` and `retuneUnchangedFailure`: the limit in force is named, and nothing changed.
fn unchanged_text(run_id: &str, current: f64, default: Option<usize>) -> String {
    let in_force = match default {
        Some(default) if current == default as f64 => {
            format!("already runs at the default parallelism (at most {default} subagents at once)")
        }
        _ if current == 1.0 => "already runs at most 1 subagent at once".to_owned(),
        _ => format!("already runs at most {current} subagents at once"),
    };
    format!(
        "workflow_retune_unchanged: run {run_id} {in_force}, so there is nothing to change. Nothing was stopped, created or changed — pass a different `max_concurrency`, or a revised script if you meant to amend the run."
    )
}

/// The next step both refusals name (divergence 747). Node's retry is a plain AmendWorkflow call, which its route detection
/// sends to an amendment once the run is not live. Here a call with only `max_concurrency` always takes the retune route,
/// so the retry must carry `name`, which takes the revision route with the run's own script.
const RETRY_ROUTE: &str = "call AmendWorkflow again with `name` set and this `max_concurrency` to start a new run of it under that limit (a call with only `max_concurrency` retunes a live run in place and cannot start one)";

/// Node `runSettledFailure`: the run is not live, so nothing is retuned.
fn settled_text(run_id: &str) -> String {
    format!(
        "workflow_run_settled: run {run_id} settled before the new parallelism limit could take hold, so there is nothing running to retune. Nothing was stopped, created or changed — {RETRY_ROUTE}."
    )
}

/// Node `notRetunableFailure`: another session's run, not executed by this one.
fn not_retunable_text(run_id: &str) -> String {
    format!(
        "workflow_run_not_retunable: run {run_id} is not being executed by this agent, so its parallelism cannot be changed in place. Nothing was stopped, created or changed — {RETRY_ROUTE}."
    )
}

/// The detail of a run is not readable on this host: the retune cannot tell the run's state, so it is not applied.
fn detail_unavailable_text(run_id: &str) -> String {
    format!(
        "workflow_retune_unavailable: this host cannot read run {run_id}'s state, so the run's parallelism is not changed. Nothing was stopped, created or changed."
    )
}

impl AmendWorkflowTool {
    /// Node `runConcurrencyRetune`: a concurrency-only call changes a live run's limit in place. A refusal for an unchanged
    /// limit is a failure; a run that is not live falls back to a revision (`retune_fallback`).
    async fn retune(
        &self,
        input: &AmendInput,
        context: &ToolUseContext,
        cwd: &Path,
        port: Arc<dyn DynamicWorkflowRunPort>,
    ) -> Result<ToolOutput, ToolError> {
        let max_concurrency = match input.limit().map_err(failed)? {
            Some(Some(number)) => Some(number as f64),
            // `null` is the default: the port resolves it to its own default.
            _ => None,
        };
        let request = RetuneRequest {
            run_id: rust_cli_kernel_api::ids::WorkflowRunId::new(input.run_id.clone()),
            max_concurrency,
        };
        let outcome = match port.retune_concurrency(request).await {
            Ok(outcome) => outcome,
            Err(error) if error.is_unsupported() => {
                return Err(failed(RETUNE_UNAVAILABLE.to_owned()));
            }
            Err(error) => return Err(failed(error.message)),
        };
        match outcome {
            RetuneOutcome::Retuned {
                previous,
                max_concurrency,
                default_concurrency,
            } => Ok(output_for(
                retune_text(&input.run_id, max_concurrency, default_concurrency),
                json!({
                    "diagnostics": [],
                    "ok": true,
                    "retuned": {
                        "runId": input.run_id,
                        "maxConcurrency": max_concurrency,
                        "previous": previous,
                        "defaultConcurrency": default_concurrency,
                    },
                }),
            )),
            RetuneOutcome::Refused(RetuneRefusal::Unchanged { current }) => Err(failed(
                unchanged_text(&input.run_id, current, port.default_concurrency()),
            )),
            RetuneOutcome::Refused(RetuneRefusal::NotLive) => {
                self.retune_fallback(input, context, cwd, port).await
            }
        }
    }

    /// Node `resolveRetuneFallbackAmend`: the run settled between the liveness check and the retune. A run this session
    /// owns and the user did not stop is revised with its stored script and no window (the owner exemption). Any other
    /// run is refused with the text for how it stands.
    async fn retune_fallback(
        &self,
        input: &AmendInput,
        context: &ToolUseContext,
        cwd: &Path,
        port: Arc<dyn DynamicWorkflowRunPort>,
    ) -> Result<ToolOutput, ToolError> {
        let run = rust_cli_kernel_api::ids::WorkflowRunId::new(input.run_id.clone());
        let detail = match port.get_run_detail(&run).await {
            Ok(detail) => detail,
            Err(error) if error.is_unsupported() => {
                return Err(failed(detail_unavailable_text(&input.run_id)));
            }
            Err(error) => return Err(failed(error.message)),
        };
        let Some(detail) = detail else {
            return Err(failed(refusal_text(
                AmendRefusalReason::RunNotFound,
                &input.run_id,
            )));
        };
        let owned = detail["ownedByThisSession"].as_bool() == Some(true);
        let user_stopped = detail["stopReason"].as_str() == Some("user");
        if !owned || user_stopped {
            let live = matches!(detail["status"].as_str(), Some("pending" | "running"));
            return Err(failed(if live {
                not_retunable_text(&input.run_id)
            } else {
                settled_text(&input.run_id)
            }));
        }
        // The owner exemption: no window for this session's own run. The script is the predecessor's, read as an amend
        // reads an omitted script, then checked, and the revision starts.
        let (resolved, inherited) = self
            .resolve(input, cwd, Some(&port))
            .await
            .map_err(failed)?;
        let analysis = self
            .analyzer
            .analyze(&resolved.script)
            .await
            .map_err(|error| failed(error.message))?;
        self.finish_revision(
            input,
            context,
            cwd,
            Some(port),
            Pending {
                resolved,
                analysis,
                inherited,
            },
        )
        .await
    }

    /// The revision after its script is read and checked: the draft, the compile failure, and the amend. Shared by the
    /// AmendWorkflow call (after its approval) and the retune fallback (after the owner exemption).
    async fn finish_revision(
        &self,
        input: &AmendInput,
        context: &ToolUseContext,
        cwd: &Path,
        port: Option<Arc<dyn DynamicWorkflowRunPort>>,
        pending: Pending,
    ) -> Result<ToolOutput, ToolError> {
        let Pending {
            resolved,
            analysis,
            inherited,
        } = pending;

        // The draft of an inline or inherited revision is a new file (never an overwrite); a path is already the file.
        let draft = if matches!(resolved.origin, Origin::Inline) {
            let dir = cwd.join(DRAFTS_DIR);
            let name = resolved
                .name
                .clone()
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_DRAFT_NAME.to_owned());
            let text = resolved.script.clone();
            tokio::task::spawn_blocking(move || write_draft_file(&dir, &name, &text))
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        // The file the run is told about: the path the model named, or the draft this call wrote.
        let script_file: Option<(PathBuf, bool)> = match (&resolved.origin, &draft) {
            (Origin::Path { absolute }, _) => Some((absolute.clone(), true)),
            (_, Some(draft)) => Some((draft.clone(), false)),
            _ => None,
        };
        let location = script_file.as_ref().map(|(file, path_source)| Location {
            path_source: *path_source,
            described: describe_script_path(file, cwd),
            line_offset: if *path_source {
                resolved.body_offset
            } else {
                0
            },
        });

        if !analysis.ok {
            return Ok(compile_failure(
                input,
                &resolved,
                &analysis,
                location.as_ref(),
                inherited,
                cwd,
            ));
        }
        let Some(port) = port else {
            return Ok(output_for(
                format!(
                    "The revised workflow script compiled cleanly.\n\n{EXECUTION_UNAVAILABLE_NOTE}"
                ),
                crate::workflow_card::card(None, true, &[]),
            ));
        };

        let limit = match input.limit() {
            Ok(Some(Some(number))) => Some(number),
            // `null` is the default: the port's default concurrency, when it reports one.
            Ok(Some(None)) => port.default_concurrency().map(|value| value as u64),
            _ => None,
        };
        let script_path = script_file.map(|(file, _)| file.display().to_string());
        let request = AmendRequest {
            script_text: resolved.script.clone(),
            cwd: cwd.display().to_string(),
            predecessor_run_id: rust_cli_kernel_api::ids::WorkflowRunId::new(input.run_id.clone()),
            name: input.name.clone(),
            parent_session_id: Some(context.session.clone()),
            tool_call_id: Some(context.tool_use.to_string()),
            phase_names: None,
            max_concurrency: limit.map(|number| number as f64),
            subagent_model: None,
            model_bindings: None,
            script_path,
            phase_alongside: None,
            inherit_args: false,
        };
        let answer = port
            .amend(request)
            .await
            .map_err(|error| failed(error.message))?;
        let (run_id, superseded) = match answer {
            AmendResult::Refused(reason) => {
                return Err(failed(refusal_text(reason, &input.run_id)));
            }
            AmendResult::Started {
                run_id,
                superseded_run_id,
            } => (
                run_id.to_string(),
                superseded_run_id.map(|id| id.to_string()),
            ),
        };
        let superseded_sentence = match superseded {
            None => format!(
                "Run {} had already settled; its finished work is imported as cache.",
                input.run_id
            ),
            Some(old) => format!(
                "Run {old} was still running: it has been stopped and superseded, and everything it finished before the stop is imported as cache. It will not send a notification of its own."
            ),
        };
        let started = if inherited {
            format!(
                "The script of run {} started unchanged in the background as run {run_id}.",
                input.run_id
            )
        } else {
            format!("The revised script started in the background as run {run_id}.")
        };
        let settings = concurrency_sentence(limit, port.default_concurrency());
        let where_ = match &location {
            None => String::new(),
            Some(location) if location.path_source => format!(
                " The script file is {}; to revise it later, edit that file and pass `path` to AmendWorkflow.",
                location.described
            ),
            Some(location) => format!(
                " The script is saved at {}; to revise it later, edit that file and pass `path` to AmendWorkflow.",
                location.described
            ),
        };
        Ok(output_for(
            format!(
                "{superseded_sentence} {started} It is still running — you will be notified with the final output when it completes. Do not wait for it or poll it with TaskOutput; continue with other work unless the user asked you to wait.{settings}{where_}"
            ),
            // The run id is in the text; the card has no graph here (the amend path draws no window display).
            crate::workflow_card::card(None, true, &[]),
        ))
    }
}

/// The result of a revision that does not check: its diagnostics, the note, and that the run was not touched.
fn compile_failure(
    input: &AmendInput,
    resolved: &Resolved,
    analysis: &WorkflowAnalysis,
    location: Option<&Location>,
    inherited: bool,
    cwd: &Path,
) -> ToolOutput {
    let lead = if inherited {
        format!(
            "This amend kept run {}'s script, inherited because you omitted both `script` and `path`, and that script no longer compiles against the current workflow facade:",
            input.run_id
        )
    } else {
        "The revised workflow script has errors:".to_owned()
    };
    let note = match location {
        Some(_) => diagnostics_note(resolved, location, cwd),
        None if inherited => {
            "NOTE: Nothing ran — pass a rewritten `script` that compiles.".to_owned()
        }
        None => DIAGNOSTICS_NOT_EXECUTED_NOTE.to_owned(),
    };
    let mut body = vec![lead];
    body.extend(diagnostic_lines(&analysis.diagnostics, location));
    body.push(String::new());
    body.push(format!("{note} Run {} was not touched.", input.run_id));
    output_for(
        body.join("\n"),
        crate::workflow_card::card(None, false, &analysis.diagnostics),
    )
}

#[cfg(test)]
#[path = "workflow_amend_tests.rs"]
mod tests;
