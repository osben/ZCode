//! Fork: run-level resume (specs/fork-rust-workflow-engine.md, 9.37, W7-7b; Node `resumeDynamicWorkflowRun` in
//! `dynamic-workflow-run-submit.ts`, the quota resume of `dynamic-workflow-quota-resume.ts`).
//!
//! A resume reads the run's journal row, checks it in Node's order, starts the child on the row's script (the child
//! compiles it), and launches the owner over the same journal. The owner takes the engine's resume branch because the
//! row exists. The refusals are Node's reasons; they are answers, not errors. Only a failure Node would throw is an error.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Weak};

use rust_cli_base::js::string::{utf16_len, utf16_prefix};
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic;
use rust_cli_kernel_api::workflow_child::{LaunchError, LaunchInput, RunningChild};
use rust_cli_kernel_api::workflow_run::DynamicWorkflowRunError;
use rust_cli_workflow::engine::{AskSpec, EngineConfig};
use rust_cli_workflow::model::{RunRow, RunStatus, StopReason};
use rust_cli_workflow::quota_resume::{Refusal, ResumeAnswer};
use rust_cli_workflow::run_store::RunStore;
use serde_json::{Value, json};

use super::{CompileCheck, Inner, LaunchFailure, WorkflowRunService};
use crate::workflow_quota::{QuotaRunResumer, RESUME_NOT_WIRED};

/// Node's `boundedResumeDiagnostics` cap, in UTF-16 units (`RESUME_DIAGNOSTICS_MAX_CHARS`).
const RESUME_DIAGNOSTICS_MAX_UNITS: usize = 2000;

/// What a resume answered: resumed (with the run's tool call id), or refused with Node's reason.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ResumeOutcome {
    Resumed {
        tool_call_id: Option<String>,
    },
    Refused {
        reason: &'static str,
        message: Option<String>,
    },
}

fn refused(reason: &'static str) -> ResumeOutcome {
    ResumeOutcome::Refused {
        reason,
        message: None,
    }
}

/// Node `boundedResumeDiagnostics`: one `L:C message` line per diagnostic under a header, cut at the cap.
fn bounded_resume_diagnostics(run_id: &str, diagnostics: &[WorkflowDiagnostic]) -> String {
    let mut lines = vec![format!(
        "The stored script of run {run_id} no longer compiles against the current workflow facade:"
    )];
    lines.extend(diagnostics.iter().map(|diagnostic| {
        format!(
            "L{}:C{} {}",
            diagnostic.line, diagnostic.column, diagnostic.message
        )
    }));
    let body = lines.join("\n");
    if utf16_len(&body) <= RESUME_DIAGNOSTICS_MAX_UNITS {
        return body;
    }
    format!("{}…", utf16_prefix(&body, RESUME_DIAGNOSTICS_MAX_UNITS - 1))
}

/// The ask specs and the site phases of one compile.
type CompiledTables = (HashMap<String, AskSpec>, HashMap<String, String>);

/// The compile's tables the engine needs (Node `askSpecs` and `sitePhases`), read from the child's compiled facts.
///
/// The helper sends these as JSON objects. Node's are JS `Map`s, which `JSON.stringify` writes as `{}`, so an object
/// with both tables empty is refused as the compile's missing tables: a run with no asks cannot be told from that, and
/// the refusal is the safe side (9.37, divergence 333).
fn compiled_tables(compiled: &Value) -> Result<CompiledTables, String> {
    let asks = compiled.get("askSpecs").and_then(Value::as_object);
    let phases = compiled.get("sitePhases").and_then(Value::as_object);
    let (Some(asks), Some(phases)) = (asks, phases) else {
        return Err("the compile reported no ask table, so the run cannot be resumed".to_owned());
    };
    if asks.is_empty() && phases.is_empty() {
        return Err("the compile reported no ask table, so the run cannot be resumed".to_owned());
    }
    let mut specs = HashMap::new();
    for (site, spec) in asks {
        let typed = spec
            .get("typed")
            .and_then(Value::as_bool)
            .ok_or_else(|| format!("the ask {site} of the compile has no typed flag"))?;
        let schema = spec.get("schema").filter(|value| !value.is_null()).cloned();
        specs.insert(site.clone(), AskSpec { typed, schema });
    }
    let mut table = HashMap::new();
    for (site, phase) in phases {
        let phase = phase
            .as_str()
            .ok_or_else(|| format!("the phase of the site {site} is not text"))?;
        table.insert(site.clone(), phase.to_owned());
    }
    Ok((specs, table))
}

impl WorkflowRunService {
    /// The live check Node makes first (`runs.get(runId)`): a run in flight, or a launch still starting.
    fn is_live(&self, run_id: &str) -> bool {
        let state = self.inner.state.lock_unpoisoned();
        state.runs.contains_key(run_id) || state.starting.contains(run_id)
    }

    /// One run row from the journal, read on the blocking pool. Ok(None) when the run does not exist.
    async fn read_row(
        &self,
        store: Arc<dyn RunStore>,
        run_id: &str,
    ) -> Result<Option<RunRow>, DynamicWorkflowRunError> {
        let id = run_id.to_owned();
        tokio::task::spawn_blocking(move || store.get_run(&id))
            .await
            .map_err(|error| {
                DynamicWorkflowRunError::new(format!("the run read did not finish: {error}"))
            })?
            .map_err(|error| DynamicWorkflowRunError::new(format!("{error:#}")))
    }

    /// Node `resume`: the refusal order and the start (9.37). Refusals are `Ok`; an error is a failure Node would throw.
    pub(crate) async fn resume_outcome(
        &self,
        run_id: &str,
    ) -> Result<ResumeOutcome, DynamicWorkflowRunError> {
        let Some(store) = self.inner.store.get().cloned() else {
            return Err(DynamicWorkflowRunError::unsupported("resume"));
        };
        let Some(row) = self.read_row(store, run_id).await? else {
            return Ok(refused("not_found"));
        };
        if self.is_live(run_id) {
            return Ok(refused("already_running"));
        }
        if row.status == RunStatus::Stopped && row.stop_reason == Some(StopReason::Superseded) {
            return Ok(refused("superseded"));
        }
        if row.status != RunStatus::Stopped {
            return Ok(refused("not_resumable"));
        }
        let Some(script_text) = row.script_text.clone() else {
            return Ok(refused("script_missing"));
        };
        // Node resumes from `record.cwd ?? process.cwd()`. Every submitted run carries its cwd, and the process cwd is not
        // read here (workspace rule, clippy.toml), so a row without one is a data failure (9.37, divergence 338).
        let Some(cwd) = row.cwd.clone() else {
            return Err(DynamicWorkflowRunError::new(format!(
                "the run {run_id} has no working directory, so it cannot be resumed"
            )));
        };
        let input = LaunchInput {
            script_text: script_text.clone(),
            run_id: row.run_id.clone(),
            args: row.args.as_ref().and_then(Value::as_object).cloned(),
            // Node's resumed launch passes no `resumedFrom`; the row keeps its own (the progress facts read it).
            resumed_from: None,
            cwd: PathBuf::from(&cwd),
        };
        let config = EngineConfig {
            run_id: row.run_id.clone(),
            caps: row.caps,
            script_text: Some(script_text),
            name: row.name.clone(),
            args: row.args.clone(),
            parent_session_id: row.parent_session_id.clone(),
            cwd: Some(cwd),
            tool_call_id: row.tool_call_id.clone(),
            resumed_from: row.resumed_from.clone(),
            ..Default::default()
        };
        let recorded_hash = row.script_hash.clone();
        let check: CompileCheck =
            Box::new(move |running: &RunningChild, config: &mut EngineConfig| {
                if recorded_hash
                    .as_deref()
                    .is_some_and(|hash| hash != running.script_hash)
                {
                    return Err(LaunchFailure::Refused {
                        reason: "script_mismatch",
                        message: None,
                    });
                }
                let (ask_specs, site_phases) =
                    compiled_tables(&running.compiled).map_err(LaunchFailure::Attach)?;
                config.script_hash = Some(running.script_hash.clone());
                config.ask_specs = ask_specs;
                config.site_phases = site_phases;
                Ok(())
            });
        match self.start(input, config, Some(check)).await {
            Ok(()) => Ok(ResumeOutcome::Resumed {
                tool_call_id: row.tool_call_id,
            }),
            Err(LaunchFailure::Duplicate(_)) => Ok(refused("already_running")),
            Err(LaunchFailure::Refused { reason, message }) => {
                Ok(ResumeOutcome::Refused { reason, message })
            }
            Err(LaunchFailure::Child(error)) => {
                let error = *error;
                match &error {
                    LaunchError::Rejected { diagnostics, .. } if !diagnostics.is_empty() => {
                        Ok(ResumeOutcome::Refused {
                            reason: "compile_failed",
                            message: Some(bounded_resume_diagnostics(run_id, diagnostics)),
                        })
                    }
                    other => Err(DynamicWorkflowRunError::new(format!(
                        "the run could not be resumed: {other}"
                    ))),
                }
            }
            Err(other) => Err(DynamicWorkflowRunError::new(format!(
                "the run could not be resumed: {other}"
            ))),
        }
    }

    /// The port's answer (kernel-api `DynamicWorkflowRunPort::resume`): Node's result union as JSON.
    pub(crate) async fn resume_port(&self, run_id: &str) -> Result<Value, DynamicWorkflowRunError> {
        Ok(match self.resume_outcome(run_id).await? {
            ResumeOutcome::Resumed { tool_call_id } => {
                let mut answer = json!({ "ok": true, "runId": run_id });
                if let Some(tool_call_id) = tool_call_id {
                    answer["toolCallId"] = json!(tool_call_id);
                }
                answer
            }
            ResumeOutcome::Refused { reason, message } => {
                let mut answer = json!({ "ok": false, "reason": reason });
                if let Some(message) = message {
                    answer["message"] = json!(message);
                }
                answer
            }
        })
    }

    /// The quota module's resume (9.37): the run's parent must be allowed, or the resume is refused without a retry.
    async fn quota_answer(
        &self,
        run_id: &str,
        allowed: &(dyn Fn(&str) -> bool + Send + Sync),
    ) -> Result<ResumeAnswer, String> {
        let Some(store) = self.inner.store.get().cloned() else {
            return Err("the run store is not set".to_owned());
        };
        let row = self
            .read_row(store, run_id)
            .await
            .map_err(|error| error.message)?;
        let Some(parent) = row.and_then(|row| row.parent_session_id) else {
            return Ok(ResumeAnswer::Refused(Refusal::Other(
                "not_found".to_owned(),
            )));
        };
        if !allowed(&parent) {
            return Ok(ResumeAnswer::Refused(Refusal::Other(
                RESUME_NOT_WIRED.to_owned(),
            )));
        }
        Ok(
            match self
                .resume_outcome(run_id)
                .await
                .map_err(|error| error.message)?
            {
                ResumeOutcome::Resumed { .. } => ResumeAnswer::Resumed,
                ResumeOutcome::Refused {
                    reason: "already_running",
                    ..
                } => ResumeAnswer::Refused(Refusal::AlreadyRunning),
                ResumeOutcome::Refused { reason, .. } => {
                    ResumeAnswer::Refused(Refusal::Other(reason.to_owned()))
                }
            },
        )
    }

    /// The quota module's resumer over this service (9.37). `allowed` names the parents whose quota runs may resume; the
    /// composition passes a closed predicate until the gate exists, so a due run is refused and nothing starts.
    pub fn quota_resumer(
        &self,
        handle: tokio::runtime::Handle,
        allowed: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    ) -> Arc<dyn QuotaRunResumer> {
        Arc::new(ServiceResumer {
            inner: Arc::downgrade(&self.inner),
            handle,
            allowed,
        })
    }
}

/// Runs the async resume on the runtime and waits for its answer, from the quota module's timer thread or the session
/// scan's blocking task. A weak handle to the service, so the module does not keep the service alive.
struct ServiceResumer {
    inner: Weak<Inner>,
    handle: tokio::runtime::Handle,
    allowed: Arc<dyn Fn(&str) -> bool + Send + Sync>,
}

impl QuotaRunResumer for ServiceResumer {
    fn resume(&self, run_id: &str) -> Result<ResumeAnswer, String> {
        let Some(inner) = self.inner.upgrade() else {
            return Err("the run service is closed".to_owned());
        };
        let service = WorkflowRunService { inner };
        let (sender, receiver) = std::sync::mpsc::channel();
        let run = run_id.to_owned();
        let allowed = self.allowed.clone();
        self.handle.spawn(async move {
            let answer = service.quota_answer(&run, allowed.as_ref()).await;
            let _ = sender.send(answer);
        });
        receiver
            .recv()
            .map_err(|_| "the resume did not answer".to_owned())?
    }
}
