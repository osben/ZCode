//! Fork: the run service's submit (specs/fork-rust-workflow-engine.md, 9.39, W7-8d; Node `submitDynamicWorkflowRun` and
//! `startNewRun` in `dynamic-workflow-run-submit.ts`).
//!
//! A submit mints a new run id, takes the caps from the requested limit (Node `normalizeRunConcurrency`), records the
//! parent's permission mode on the launch (9.35, `record_parent_mode`, read off the async workers), and starts the run
//! through the same `start` as a resume. The child compiles the script; the check after the compile fills the engine's
//! ask and phase tables and the script hash from that compile, so the owner's engine has what the run needs. Only a
//! failure Node would throw is an error: a compile that rejects the script is one too, because Node's submit never sees
//! one (CreateWorkflow checks the script before it asks, 9.27).

use std::path::PathBuf;
use std::sync::Arc;

use rust_cli_kernel_api::ids::WorkflowRunId;
use rust_cli_kernel_api::workflow_child::{LaunchError, LaunchInput, RunningChild};
use rust_cli_kernel_api::workflow_run::{DynamicWorkflowRunError, SubmitRequest};
use rust_cli_workflow::engine::EngineConfig;
use rust_cli_workflow::event::LaunchFields;
use rust_cli_workflow::model::Caps;
use serde_json::Value;

use rust_cli_platform::ids::uuid_v4;

use super::resume::{cap_diagnostics_text, tables_of};
use super::{CompileCheck, LaunchFailure, WorkflowRunService};
use crate::workflow_owner::{ActorBindingsPort, record_parent_mode};

/// Node `normalizeRunConcurrency`: omission is the default; a supplied value is floored to at least one, with no upper
/// limit (`workflow-default-concurrency.ts`).
pub(crate) fn normalized_limit(requested: Option<u64>, default: f64) -> f64 {
    match requested {
        None => default,
        Some(value) => value.max(1) as f64,
    }
}

/// Node `mintRunId`: `dwfrun-<uuid>`, with only `[A-Za-z0-9-]` (the id appears in session ids, URLs and file paths). The
/// uuid comes from the platform's CSPRNG, as Node's `randomUUID()` does (divergence 373).
pub(super) fn mint_run_id() -> String {
    format!("dwfrun-{}", uuid_v4())
}

/// The port's error for a start that failed (shared by submit and amend, 9.43): a compile that rejects the script keeps
/// its diagnostics, as Node's submit reports them.
pub(super) fn start_failure(error: LaunchFailure) -> DynamicWorkflowRunError {
    match error {
        LaunchFailure::Refused { reason, message } => {
            DynamicWorkflowRunError::new(message.unwrap_or_else(|| reason.to_owned()))
        }
        LaunchFailure::Child(error) => match *error {
            LaunchError::Rejected {
                diagnostics,
                message,
            } => DynamicWorkflowRunError::new(rejected_text(&diagnostics, message.as_deref())),
            other => DynamicWorkflowRunError::new(format!(
                "the workflow run could not be started: {other}"
            )),
        },
        other => {
            DynamicWorkflowRunError::new(format!("the workflow run could not be started: {other}"))
        }
    }
}

/// The check the start runs after the compile: the ask and phase tables and the script hash come from it (9.39).
pub(super) fn compile_check() -> CompileCheck {
    Box::new(move |running: &RunningChild, config: &mut EngineConfig| {
        let (ask_specs, site_phases) =
            tables_of(&running.compiled).map_err(LaunchFailure::Attach)?;
        config.script_hash = Some(running.script_hash.clone());
        config.ask_specs = ask_specs;
        config.site_phases = site_phases;
        Ok(())
    })
}

/// The text of a compile that rejected the script: its diagnostics in Node's `L{line}:C{column}` form.
fn rejected_text(
    diagnostics: &[rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic],
    message: Option<&str>,
) -> String {
    if diagnostics.is_empty() {
        return cap_diagnostics_text(match message {
            Some(message) => format!("the workflow script did not compile: {message}"),
            None => "the workflow script did not compile".to_owned(),
        });
    }
    let mut lines = vec!["The workflow script did not compile:".to_owned()];
    lines.extend(diagnostics.iter().map(|diagnostic| {
        format!(
            "L{}:C{} {}",
            diagnostic.line, diagnostic.column, diagnostic.message
        )
    }));
    cap_diagnostics_text(lines.join("\n"))
}

/// Records the parent's permission mode on the config (9.35), on the blocking pool: the port blocks on the store. A read
/// error refuses the submit, so nothing starts with its mode unrecorded (fail closed).
pub(super) async fn record_parent_mode_on_blocking_pool(
    mut config: EngineConfig,
    bindings: Arc<dyn ActorBindingsPort>,
) -> Result<EngineConfig, DynamicWorkflowRunError> {
    let (config, recorded) = tokio::task::spawn_blocking(move || {
        let recorded = record_parent_mode(&mut config, bindings.as_ref());
        (config, recorded)
    })
    .await
    .map_err(|error| {
        DynamicWorkflowRunError::new(format!("the run start did not finish: {error}"))
    })?;
    recorded.map(|()| config).map_err(|message| {
        DynamicWorkflowRunError::new(format!(
            "the parent's permission mode could not be read, so the run is not started: {message}"
        ))
    })
}

impl WorkflowRunService {
    /// The default concurrency this service reports (Node `defaultConcurrency()`); `None` until the composition sets it.
    pub(crate) fn default_concurrency_value(&self) -> Option<f64> {
        self.inner.default_concurrency.get().copied()
    }

    /// Node `submitDynamicWorkflowRun`, for the parent session the port belongs to. Returns the new run id once the run
    /// is registered and its owner is serving; the run settles in the background.
    pub(crate) async fn submit_run(
        &self,
        parent: &str,
        request: SubmitRequest,
    ) -> Result<WorkflowRunId, DynamicWorkflowRunError> {
        self.submit_run_with_launch(parent, request, None).await
    }

    /// Fork (W9a, 9.53): `submit_run` with the launch anchor the caller minted. A hub start mints its UUID v7 and records it
    /// as the run's `run-launched.inputId`. This host does not share it with the launch turn, which carries only its text
    /// (Node shares one id; divergence 774). Without an anchor the submit mints a UUID (divergence 371).
    pub(crate) async fn submit_run_with_launch(
        &self,
        parent: &str,
        request: SubmitRequest,
        launch_input_id: Option<String>,
    ) -> Result<WorkflowRunId, DynamicWorkflowRunError> {
        let Some(default) = self.default_concurrency_value() else {
            return Err(DynamicWorkflowRunError::unsupported("submit"));
        };
        let Some(bindings) = self.inner.bindings.get().cloned() else {
            return Err(DynamicWorkflowRunError::new(
                "the run service cannot read the parent's permission mode, so the run is not started",
            ));
        };
        // The port is bound to one parent (`SessionRuns`). A request that names another parent is a wiring fault: the run
        // and its recorded mode would follow the port, not the request, so the submit is refused instead (9.39, 380).
        if let Some(named) = request.parent_session_id.as_ref()
            && named.as_str() != parent
        {
            return Err(DynamicWorkflowRunError::new(format!(
                "the submit names the parent session {} but its run port belongs to {parent}, so no run is started",
                named.as_str()
            )));
        }
        let run_id = mint_run_id();
        let input = LaunchInput {
            script_text: request.script_text.clone(),
            run_id: run_id.clone(),
            args: request.args.clone(),
            resumed_from: None,
            cwd: PathBuf::from(&request.cwd),
        };
        let config = EngineConfig {
            run_id: run_id.clone(),
            caps: Caps {
                max_concurrency: normalized_limit(request.max_concurrency, default),
            },
            script_text: Some(request.script_text),
            name: request.name,
            args: request.args.map(Value::Object),
            parent_session_id: Some(parent.to_owned()),
            cwd: Some(request.cwd),
            tool_call_id: request.tool_call_id,
            // Node's launch anchor: the inputId of the turn that launched the run. Until the tool passes its turn, a
            // direct launch mints one (divergence 371). The script file is recorded on `run-launched` (Node).
            launch: Some(LaunchFields {
                input_id: launch_input_id.unwrap_or_else(uuid_v4),
                script_path: request.script_path,
                ..LaunchFields::default()
            }),
            ..EngineConfig::default()
        };
        let config = record_parent_mode_on_blocking_pool(config, bindings).await?;
        match self.start(input, config, Some(compile_check())).await {
            Ok(()) => Ok(WorkflowRunId::new(run_id)),
            Err(error) => Err(start_failure(error)),
        }
    }
}
