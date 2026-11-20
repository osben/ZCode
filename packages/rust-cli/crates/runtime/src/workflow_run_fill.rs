//! Fork: the run service's FillWorkflowHole (specs/fork-rust-workflow-engine.md, 9.45, W7-12; Node `fillDynamicWorkflowHole`
//! in `bootstrap/src/app/dynamic-workflow-run-fill.ts`).
//!
//! The order is Node's, and a refusal has no side effects: the run is found (`run_not_found`), it is in flight in this
//! process (`hole_not_waiting`, with Node's stop and end hints), the helper prepares the fill (the splice, the analysis, the
//! site stability check and the compile, whose refusals are Node's), and the owner applies the fill in one step (the
//! effective script, the hole-filled event and the release of the parked branch). A fill is serialized with every other
//! fill of this service (Node serializes per run; divergence 510). The draft file is not rewritten and no draft is minted
//! (divergence 511). The run's model bindings are not carried, so the helper checks no named model (divergence 512).

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::workflow_child::{FillPrepareInput, FillPrepareOutcome};
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, FillHoleOutcome, FillHoleRequest, FillRefusalReason,
};
use rust_cli_workflow::engine_holes::{FillHoleResult, HoleFill};
use rust_cli_workflow::model::RunRow;
use serde_json::Value;

use super::list::on_blocking_pool;
use super::{WorkflowRunService, resume::tables_of};

/// A journal error as the port's error.
fn store_failure(error: anyhow::Error) -> DynamicWorkflowRunError {
    DynamicWorkflowRunError::new(format!("{error:#}"))
}

/// Node's hint for a run that is not in flight in this process, by its journal status.
fn not_in_flight(run_id: &str, row: &RunRow) -> String {
    match row.status.as_str() {
        "stopped" => format!(
            "Run {run_id} is stopped; ResumeWorkflowRun it first, after which the hole asks again."
        ),
        status @ ("completed" | "errored") => {
            format!("Run {run_id} has ended ({status}); nothing is waiting.")
        }
        _ => format!("Run {run_id} is not in flight in this session."),
    }
}

/// The helper's refusal reason, as the port's enum. An unknown reason is a wiring fault.
fn reason_of(code: &str) -> Result<FillRefusalReason, DynamicWorkflowRunError> {
    match code {
        "hole_not_waiting" => Ok(FillRefusalReason::HoleNotWaiting),
        "compile_failed" => Ok(FillRefusalReason::CompileFailed),
        "fill_ids_unstable" => Ok(FillRefusalReason::FillIdsUnstable),
        other => Err(DynamicWorkflowRunError::new(format!(
            "the fill helper refused with an unknown reason ({other})"
        ))),
    }
}

fn refused(reason: FillRefusalReason, message: String) -> FillHoleOutcome {
    FillHoleOutcome::Refused {
        reason,
        message,
        diagnostics: None,
    }
}

/// A string list field of the helper's reply (absent or non-text items are skipped).
fn strings_of(reply: &Value, key: &str) -> Vec<String> {
    reply
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

impl WorkflowRunService {
    /// Node `fillHole` (9.45) for the parent session the port belongs to.
    pub(crate) async fn fill_hole_run(
        &self,
        parent: &str,
        request: FillHoleRequest,
    ) -> Result<FillHoleOutcome, DynamicWorkflowRunError> {
        // The permit is held to the end of this call; the semaphore is never closed, so the acquire cannot fail.
        let _turn = self
            .inner
            .fills
            .acquire()
            .await
            .map_err(|_| DynamicWorkflowRunError::new("the fill queue is closed"))?;
        let run_id = request.run_id.as_str().to_owned();
        let Some(store) = self.inner.store.get().cloned() else {
            return Err(DynamicWorkflowRunError::unsupported("fillHole"));
        };

        // 1. The run: its journal row (of this session), then its live entry in this process.
        let lookup_store = store.clone();
        let lookup_id = run_id.clone();
        let row = on_blocking_pool(move || lookup_store.get_run(&lookup_id).map_err(store_failure))
            .await?;
        let row = match row {
            Some(row) if row.parent_session_id.as_deref() == Some(parent) => row,
            _ => {
                return Ok(refused(
                    FillRefusalReason::RunNotFound,
                    format!("No run with id {run_id}."),
                ));
            }
        };
        let live = {
            let state = self.inner.state.lock_unpoisoned();
            if state.starting.contains(&run_id) {
                None
            } else {
                state
                    .runs
                    .get(&run_id)
                    .filter(|entry| entry.serve.is_some())
                    .map(|entry| entry.handle.clone())
            }
        };
        let Some(handle) = live else {
            return Ok(refused(
                FillRefusalReason::HoleNotWaiting,
                not_in_flight(&run_id, &row),
            ));
        };

        // 2. The helper prepares the fill from the run's stored script (a fill writes it back, so the row is current).
        let Some(script_text) = row.script_text.clone() else {
            return Ok(refused(
                FillRefusalReason::HoleNotWaiting,
                format!("Run {run_id} has no script, so nothing is waiting."),
            ));
        };
        let prepared = self
            .inner
            .runner
            .prepare_fill(FillPrepareInput {
                script_text,
                run_id: run_id.clone(),
                hole_id: request.hole_id.clone(),
                body: request.body.clone(),
                model_bindings: None,
            })
            .await
            .map_err(|error| {
                DynamicWorkflowRunError::new(format!("the fill could not be prepared: {error}"))
            })?;
        let reply = match prepared {
            FillPrepareOutcome::Refused {
                reason,
                message,
                diagnostics,
            } => {
                return Ok(FillHoleOutcome::Refused {
                    reason: reason_of(&reason)?,
                    message,
                    diagnostics,
                });
            }
            FillPrepareOutcome::Ready(reply) => reply,
        };

        // 3. The owner applies it: the tables, the effective script, the event and the release, in one step.
        let (ask_specs, site_phases) = tables_of(&reply).map_err(DynamicWorkflowRunError::new)?;
        let field = |key: &str| {
            reply
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| DynamicWorkflowRunError::new(format!("the fill reply has no {key}")))
        };
        let script_text = field("effectiveText")?;
        let phases_added = strings_of(&reply, "phasesAdded");
        let fill = HoleFill {
            site_id: request.hole_id.clone(),
            code: field("code")?,
            script_text: script_text.clone(),
            script_hash: field("scriptHash")?,
            ask_specs,
            site_phases,
            phase_names: strings_of(&reply, "phaseNames"),
            holes: reply
                .get("holes")
                .and_then(Value::as_array)
                .map(|items| items.iter().filter_map(Value::as_u64).collect()),
            filled_by: request
                .parent_session_id
                .as_ref()
                .map(|session| session.as_str().to_owned()),
            script_path: None,
        };
        let hole = request.hole_id.clone();
        let applied = on_blocking_pool(move || {
            handle.fill_hole(fill).map_err(|error| {
                DynamicWorkflowRunError::new(format!("the owner refused the fill: {error}"))
            })
        })
        .await?;
        Ok(match applied {
            FillHoleResult::Filled => FillHoleOutcome::Filled {
                phases_added,
                script_text,
            },
            FillHoleResult::NotWaiting => refused(
                FillRefusalReason::HoleNotWaiting,
                format!(
                    "Run {run_id} is not waiting at {hole}: it has not reached it yet, or it is already filled."
                ),
            ),
            FillHoleResult::Settled => refused(
                FillRefusalReason::HoleNotWaiting,
                format!("Run {run_id} has already settled; nothing is waiting."),
            ),
        })
    }
}
