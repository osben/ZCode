//! Fork: the hub's direct start of a saved workflow (specs/fork-rust-workflow-engine.md, 9.53, W9a; Node
//! `startSavedWorkflowRun` in `core/src/runtime/methods/dynamic-workflow-run-start.ts`).
//!
//! The order is Node's. Resolution, argument checks and the compile come first and have no side effect: a refusal there
//! starts nothing and writes nothing. Then the parent is activated, the draft copy is written, the run is submitted with
//! the launch anchor (a UUID v7, shared with the launch turn), and the launch turn is recorded for the parent. A failure
//! after the submit is not rolled back, as Node does not roll it back.
//!
//! Not built here (divergences 760 to 765): the models a script names (Node binds them; this host refuses none and binds
//! none), the phase table of the launch (no `phaseNames`/`phaseAlongside` on the run), the background tracker
//! registration (the run is registered by the run service only), and the metadata of the launch turn (the turn records
//! its text and origin; `workflowLaunch` is not stored on the row).

use std::path::PathBuf;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic;
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, LaunchTurn, StartRefusal, StartSavedOutcome, StartSavedRequest,
    SubmitRequest, WorkflowTurnSink,
};
use rust_cli_platform::ids::{uuid_v4, uuid_v7};
use rust_cli_tools::workflow_start::{ResolvedStart, resolve_saved_start, write_start_draft};
use serde_json::{Map, Value};

use super::WorkflowRunService;

/// Node `COMPILE_DIAGNOSTICS_MAX_CHARS`: the diagnostics travel in the ack's message, so a longer text is cut.
const COMPILE_DIAGNOSTICS_MAX_CHARS: usize = 2_000;

impl WorkflowRunService {
    /// Node `startSavedWorkflowRun`, for the parent session the port belongs to. The session's own busy check is the
    /// caller's. A refusal is an answer (`Refused`); an error is a missing capability or a wiring fault.
    pub async fn start_saved(
        &self,
        parent: &str,
        request: StartSavedRequest,
        sink: &dyn WorkflowTurnSink,
    ) -> Result<StartSavedOutcome, DynamicWorkflowRunError> {
        let Some(ports) = self.inner.saved_start.get() else {
            return Err(DynamicWorkflowRunError::unsupported("startSavedWorkflow"));
        };
        let cwd = PathBuf::from(&request.cwd);

        // (1) Resolve and validate the arguments, as CreateWorkflow's saved source does.
        let resolved = match resolve_saved_start(
            &ports.home,
            &cwd,
            &request.name,
            request.scope.as_deref(),
            request.args.as_ref(),
        ) {
            Ok(resolved) => resolved,
            Err(refusal) => return Ok(StartSavedOutcome::Refused(refusal)),
        };

        // (2) Compile. A script with any diagnostic is refused before anything starts (Node's compile_failed).
        let analysis = match ports.analyzer.analyze(&resolved.script).await {
            Ok(analysis) => analysis,
            Err(error) => {
                return Ok(StartSavedOutcome::Refused(StartRefusal::StartFailed {
                    message: format!("the saved workflow could not be checked: {}", error.message),
                }));
            }
        };
        if !analysis.ok || !analysis.diagnostics.is_empty() {
            let heading = format!("The saved workflow '{}' has errors:", resolved.name);
            return Ok(StartSavedOutcome::Refused(StartRefusal::CompileFailed {
                message: bounded_diagnostics(&heading, &analysis.diagnostics),
            }));
        }

        // No side effects up to here. The parent is activated before the run is submitted (Node activates after the
        // session is persisted and before the draft and the submit).
        let parent_id = SessionId::new(parent);
        sink.activate(&parent_id);

        // (3) The draft copy and the launch anchor. The anchor is shared by the run's `run-launched` and the launch turn.
        let draft = write_start_draft(&cwd, &resolved).await;
        let tool_call_id = format!("launch-{}", uuid_v4());
        let launch_input_id = uuid_v7(self.start_clock_ms());

        // (4) Submit. A failure is a start failure with the submit's message; nothing was recorded for the run.
        let args = (!resolved.args.is_empty()).then(|| resolved.args.clone());
        let submitted = self
            .submit_run_with_launch(
                parent,
                SubmitRequest {
                    script_text: resolved.script.clone(),
                    cwd: request.cwd.clone(),
                    name: Some(resolved.name.clone()),
                    args,
                    parent_session_id: Some(parent_id.clone()),
                    tool_call_id: Some(tool_call_id.clone()),
                    max_concurrency: None,
                    script_path: draft.map(|path| path.display().to_string()),
                },
                Some(launch_input_id),
            )
            .await;
        let run_id = match submitted {
            Ok(run_id) => run_id,
            Err(error) => {
                return Ok(StartSavedOutcome::Refused(StartRefusal::StartFailed {
                    message: error.message,
                }));
            }
        };

        // (5) The launch turn: the parent's control-only record of the start (Node `emitControlOnlyUserTurn`).
        let text = launch_text(&resolved, run_id.as_str());
        sink.launch_turn(
            &parent_id,
            LaunchTurn {
                text,
                run_id: run_id.clone(),
                tool_call_id: tool_call_id.clone(),
                name: resolved.name.clone(),
            },
        );
        Ok(StartSavedOutcome::Started {
            run_id,
            tool_call_id,
        })
    }

    /// The production clock's time for a launch anchor (Node's `uuidv7()` reads the clock). Zero when no clock is set,
    /// which only orders the id, never its identity.
    fn start_clock_ms(&self) -> u64 {
        self.inner
            .clock
            .get()
            .map(|clock| clock.now_ms())
            .unwrap_or(0)
    }
}

/// Node `buildLaunchMessageText`: the model-facing text of the launch turn. English, because it enters the transcript. The
/// arguments follow as a JSON block when there are any, and the last sentence discourages a second start.
pub(crate) fn launch_text(resolved: &ResolvedStart, run_id: &str) -> String {
    let mut lines = vec![format!(
        "Started the saved workflow \"{}\" ({}) from the workflows hub as run {run_id}.",
        resolved.name, resolved.scope
    )];
    push_arguments(&mut lines, &resolved.args);
    lines.push(String::new());
    lines.push(
        "Progress and results arrive as background notifications; do not start it again."
            .to_owned(),
    );
    lines.join("\n")
}

/// Appends the arguments block when there are arguments (Node's `Arguments:` and a fenced JSON block).
fn push_arguments(lines: &mut Vec<String>, args: &Map<String, Value>) {
    if args.is_empty() {
        return;
    }
    lines.push(String::new());
    lines.push("Arguments:".to_owned());
    lines.push("```json".to_owned());
    lines.push(serde_json::to_string_pretty(args).unwrap_or_else(|_| "{}".to_owned()));
    lines.push("```".to_owned());
}

/// Node `boundedCompileDiagnostics`: one `L{line}:C{column} {message}` per diagnostic under the heading, cut to the limit.
pub(crate) fn bounded_diagnostics(heading: &str, diagnostics: &[WorkflowDiagnostic]) -> String {
    let mut lines = vec![heading.to_owned()];
    lines.extend(diagnostics.iter().map(|diagnostic| {
        format!(
            "L{}:C{} {}",
            diagnostic.line, diagnostic.column, diagnostic.message
        )
    }));
    let body = lines.join("\n");
    if body.chars().count() <= COMPILE_DIAGNOSTICS_MAX_CHARS {
        return body;
    }
    let mut cut: String = body
        .chars()
        .take(COMPILE_DIAGNOSTICS_MAX_CHARS - 1)
        .collect();
    cut.push('…');
    cut
}
