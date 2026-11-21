//! Fork: the GUI "Configure" settings change and its settings turn (specs/fork-rust-workflow-engine.md, 9.50, W8c, 9.53; Node
//! `amendWorkflowRunSettings` in `core/src/runtime/methods/dynamic-workflow-run-settings.ts`, and the settings turn in
//! `dynamic-workflow-run-settings-turn.ts`).
//!
//! A concurrency-only change to a live run is applied in place (the same run, no stop, no successor). Any other change
//! amends the run with the predecessor's script and arguments. Either way the parent records a settings turn: a
//! control-only turn whose text tells the model what changed. The v4 `amendWorkflowRunSettings` command reaches it through
//! the port (9.53, W9a); the sink is the protocol's, passed in by the caller. The types are in kernel-api (9.53).
//!
//! The order is Node's. Every refusal before the retune or the amend has no side effects. A failure after the amend
//! has started is not rolled back, as Node does not roll it back.
//!
//! Not built here (divergences 663 to 668): a subagent-model change (refused as `model_unavailable`), a run whose launch
//! names script models (refused the same way: the models are not rebound), the draft file for the kept script (the
//! successor has none), the background tracking of the successor.

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::workflow_run::{
    AmendRefusalReason, AmendRequest, AmendResult, DynamicWorkflowRunError, RetuneOutcome,
    RetuneRefusal, RetuneRequest, SettingsAmend, SettingsChange, SettingsOutcome, SettingsRefusal,
    SettingsRequest, SettingsTurn, WorkflowTurnSink,
};
use rust_cli_platform::ids::uuid_v4;
use rust_cli_workflow::model::RunStatus;

use super::WorkflowRunService;
use super::list::on_blocking_pool;

/// Node `buildSettingsMessageText` (9.50): the model-facing sentence of a settings change. English, because it enters the
/// provider transcript. It names only what changed, and it ends by telling the model not to change the run again.
pub fn settings_message_text(
    name: Option<&str>,
    previous: &str,
    run_id: &str,
    superseded: bool,
    amend: &SettingsAmend,
) -> String {
    let in_place = amend.predecessor_run_id.is_none();
    let named = name.map_or(String::new(), |name| format!(" (\"{name}\")"));
    let lead = format!(
        "Changed the settings of workflow run {previous}{named} from the GUI: {}.",
        change_clauses(amend, in_place).join("; ")
    );
    let closing = "Progress and results arrive as background notifications; do not amend, resume or restart it.";
    if in_place {
        // An in-place limit with no `to` is the default: the run keeps running with no limit.
        let kept = match amend.max_concurrency.and_then(|change| change.to) {
            None => format!("Run {previous} keeps running with no limit"),
            Some(_) => format!("Run {previous} keeps running under the new limit"),
        };
        return format!("{lead} {kept}; nothing was stopped and no new run was started. {closing}");
    }
    let relation = if superseded {
        "supersedes"
    } else {
        "takes over from"
    };
    format!(
        "{lead} The same script continues as run {run_id}, which {relation} run {previous} and imports everything run {previous} finished as cache. {closing}"
    )
}

/// Node `settingsChangeClauses` (9.50), without the subagent-model clause (no model change reaches it). An in-place clause
/// names its subject ("its subagents"), since no earlier clause of the same sentence does.
fn change_clauses(amend: &SettingsAmend, in_place: bool) -> Vec<String> {
    let mut changes = Vec::new();
    if let Some(change) = amend.max_concurrency {
        changes.push(match change.to {
            None => "the limit on subagents at once is back to the default".to_owned(),
            Some(to) if in_place => format!("at most {to} of its subagents run at once"),
            Some(to) => format!("at most {to} of them run at once"),
        });
    }
    changes
}

/// A limit side as the metadata keeps it: the default is absent.
fn side_of(value: f64, default: f64) -> Option<f64> {
    (value != default).then_some(value)
}

/// Node's `displayNameOfSnapshot`: the trimmed name, absent when blank. A run's title is never its id.
fn display_name(name: Option<&str>) -> Option<String> {
    name.map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// A journal error as the port's error.
fn store_error(error: anyhow::Error) -> DynamicWorkflowRunError {
    DynamicWorkflowRunError::new(format!("{error:#}"))
}

impl WorkflowRunService {
    /// Node `amendWorkflowRunSettings` for the parent session the port belongs to (9.50). Ordered as Node's: the run is found
    /// and configurable, the change is normalized, a concurrency-only change to a live run is retuned in place, and otherwise
    /// the run is amended with its own script, arguments and the new limit. The sink then records the settings turn.
    pub async fn amend_settings(
        &self,
        parent: &str,
        request: SettingsRequest,
        sink: &dyn WorkflowTurnSink,
    ) -> Result<SettingsOutcome, DynamicWorkflowRunError> {
        let Some(store) = self.inner.store.get().cloned() else {
            return Err(DynamicWorkflowRunError::unsupported(
                "amendWorkflowRunSettings",
            ));
        };
        let Some(default) = self.default_concurrency_value() else {
            return Err(DynamicWorkflowRunError::unsupported(
                "amendWorkflowRunSettings",
            ));
        };
        let parent_id = SessionId::new(parent);
        let run_id = request.run_id.as_str().to_owned();

        // (1) The run exists and belongs to this session; a settled or superseded run is not configurable (2).
        let row_store = store.clone();
        let row_id = run_id.clone();
        let Some(row) =
            on_blocking_pool(move || row_store.get_run(&row_id).map_err(store_error)).await?
        else {
            return Ok(SettingsOutcome::Refused(SettingsRefusal::NotFound));
        };
        if row.parent_session_id.as_deref() != Some(parent) {
            return Ok(SettingsOutcome::Refused(SettingsRefusal::NotFound));
        }
        if row.status == RunStatus::Completed || row.superseded_by.is_some() {
            return Ok(SettingsOutcome::Refused(SettingsRefusal::NotConfigurable));
        }

        // (3) A subagent-model change is not built (divergence 663).
        if request.subagent_model.is_some() {
            return Ok(SettingsOutcome::Refused(SettingsRefusal::ModelUnavailable {
                message: "this host cannot change a run's subagent model yet, so the run is not changed".to_owned(),
            }));
        }

        // (4) The limit: omitted keeps the run's own, `null` is the default, a value is floored and kept at least 1.
        let current = row.caps.max_concurrency;
        let next = match request.max_concurrency {
            None => current,
            Some(None) => default,
            Some(Some(value)) if !value.is_finite() => {
                return Err(DynamicWorkflowRunError::new(
                    "the concurrency limit must be a finite number, so the run is not changed",
                ));
            }
            Some(Some(value)) => value.floor().max(1.0),
        };
        // (5) Nothing changed: no retune, no amendment.
        if next == current {
            return Ok(SettingsOutcome::Refused(SettingsRefusal::Unchanged));
        }

        // (6) A concurrency-only change to a live run is applied in place: same run, no stop, no successor.
        match self
            .retune_run(
                parent,
                RetuneRequest {
                    run_id: request.run_id.clone(),
                    max_concurrency: Some(next),
                },
            )
            .await?
        {
            RetuneOutcome::Retuned {
                previous,
                max_concurrency,
                default_concurrency,
            } => {
                let tool_call_id = format!("settings-{}", uuid_v4());
                let name = display_name(row.name.as_deref());
                let amend = SettingsAmend {
                    predecessor_run_id: None,
                    max_concurrency: Some(SettingsChange {
                        from: side_of(previous, default_concurrency),
                        to: side_of(max_concurrency, default_concurrency),
                    }),
                    default_concurrency,
                };
                let text = settings_message_text(name.as_deref(), &run_id, &run_id, false, &amend);
                if !sink.activate() {
                    tracing::warn!(
                        event = "workflow.run.settings.activation_missed",
                        "the parent has no gate record to activate the workflow tools in"
                    );
                }
                sink.settings_turn(SettingsTurn {
                    text,
                    run_id: request.run_id.clone(),
                    tool_call_id: tool_call_id.clone(),
                    title_input: name.clone().unwrap_or_else(|| run_id.clone()),
                    name,
                    amend,
                });
                return Ok(SettingsOutcome::Retuned {
                    run_id: request.run_id,
                    tool_call_id,
                });
            }
            RetuneOutcome::Refused(RetuneRefusal::Unchanged { .. }) => {
                return Ok(SettingsOutcome::Refused(SettingsRefusal::Unchanged));
            }
            RetuneOutcome::Refused(RetuneRefusal::NotLive) => {}
        }

        // (7) The script is the run's own. Node reads it after the in-place branch, so a run without one can still be retuned.
        let Some(script) = row.script_text.clone().filter(|text| !text.is_empty()) else {
            return Ok(SettingsOutcome::Refused(SettingsRefusal::ScriptMissing));
        };
        let Some(cwd) = row.cwd.clone() else {
            return Ok(SettingsOutcome::Refused(SettingsRefusal::StartFailed {
                message: "the run has no working directory to start its successor in".to_owned(),
            }));
        };
        // (8) A script that names models is refused: the models are not rebound here (divergence 665).
        let binds_store = store.clone();
        let binds_id = run_id.clone();
        let binds = on_blocking_pool(move || {
            binds_store
                .launch_binds_models(&binds_id)
                .map_err(store_error)
        })
        .await?;
        if binds {
            return Ok(SettingsOutcome::Refused(
                SettingsRefusal::ModelUnavailable {
                    message: format!(
                        "the models named in the script of run {run_id} cannot be rebound by this host yet, so the run is not changed"
                    ),
                },
            ));
        }

        // (9) Amend: the same script and the stored arguments, with the new limit. The tool call id is `settings-`, as Node's.
        let tool_call_id = format!("settings-{}", uuid_v4());
        let answer = self
            .amend_run(
                parent,
                AmendRequest {
                    script_text: script,
                    cwd,
                    predecessor_run_id: request.run_id.clone(),
                    name: None,
                    parent_session_id: Some(parent_id.clone()),
                    tool_call_id: Some(tool_call_id.clone()),
                    phase_names: None,
                    max_concurrency: Some(next),
                    subagent_model: None,
                    model_bindings: None,
                    script_path: None,
                    phase_alongside: None,
                    inherit_args: true,
                },
            )
            .await;
        match answer {
            Ok(AmendResult::Started {
                run_id: successor,
                superseded_run_id,
            }) => {
                let name = display_name(row.name.as_deref());
                let amend = SettingsAmend {
                    predecessor_run_id: Some(request.run_id.clone()),
                    max_concurrency: Some(SettingsChange {
                        from: side_of(current, default),
                        to: side_of(next, default),
                    }),
                    default_concurrency: default,
                };
                let text = settings_message_text(
                    name.as_deref(),
                    &run_id,
                    successor.as_str(),
                    superseded_run_id.is_some(),
                    &amend,
                );
                if !sink.activate() {
                    tracing::warn!(
                        event = "workflow.run.settings.activation_missed",
                        "the parent has no gate record to activate the workflow tools in"
                    );
                }
                sink.settings_turn(SettingsTurn {
                    text,
                    run_id: successor.clone(),
                    tool_call_id: tool_call_id.clone(),
                    title_input: name.clone().unwrap_or_else(|| run_id.clone()),
                    name,
                    amend,
                });
                Ok(SettingsOutcome::Amended {
                    run_id: successor,
                    tool_call_id,
                    superseded_run_id,
                })
            }
            Ok(AmendResult::Refused(reason)) => Ok(SettingsOutcome::Refused(match reason {
                AmendRefusalReason::RunNotFound => SettingsRefusal::NotFound,
                AmendRefusalReason::MissingBoundaries => SettingsRefusal::MissingBoundaries,
            })),
            // Node reports a thrown amend as `start_failed` with its message.
            Err(error) => Ok(SettingsOutcome::Refused(SettingsRefusal::StartFailed {
                message: error.message,
            })),
        }
    }
}
