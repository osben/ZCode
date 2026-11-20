//! Fork: the run service's amend (specs/fork-rust-workflow-engine.md, 9.43, W7-10; Node `amendDynamicWorkflowRun` in
//! `dynamic-workflow-run-submit.ts`).
//!
//! The order is Node's. A preflight of the predecessor (it exists in this session, and every completed ask has a
//! boundary) comes first, and a refusal changes nothing. A successor id is minted. A live predecessor is stopped as
//! `superseded` by that id, and the stop is awaited through the owner's own settlement, not a poll. The predecessor's
//! finished work is imported as a cache, and the successor starts through the same path as a submit, with
//! `resumedFrom` and the inherited tokens. The import cache has no transcript count here (the transcript surface is not
//! composed), so completed asks import and an in-flight continuation does not (divergence 451).

use std::path::PathBuf;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::WorkflowRunId;
use rust_cli_kernel_api::workflow_child::LaunchInput;
use rust_cli_kernel_api::workflow_run::{
    AmendRefusalReason, AmendRequest, AmendResult, DynamicWorkflowRunError,
};
use rust_cli_platform::ids::uuid_v4;
use rust_cli_workflow::engine::EngineConfig;
use rust_cli_workflow::event::LaunchFields;
use rust_cli_workflow::import_build::{BuildOutcome, ImportRefusal};
use rust_cli_workflow::model::Caps;

use super::list::on_blocking_pool;
use super::submit::{
    compile_check, mint_run_id, record_parent_mode_on_blocking_pool, start_failure,
};
use super::{WorkflowRunService, buffer_failures, join_owner};
use crate::workflow_owner::ActorBindingsPort;
use std::sync::Arc;

/// The refusal a preflight names, in the port's vocabulary.
fn refusal_of(reason: ImportRefusal) -> AmendRefusalReason {
    match reason {
        ImportRefusal::RunNotFound => AmendRefusalReason::RunNotFound,
        // `not_amendable` is a build refusal, not a preflight one; a preflight never reports it, and a build that does is
        // a host fault (see `amend_run`).
        ImportRefusal::MissingBoundaries | ImportRefusal::NotAmendable => {
            AmendRefusalReason::MissingBoundaries
        }
    }
}

/// A journal error as the port's error.
fn store_failure(error: anyhow::Error) -> DynamicWorkflowRunError {
    DynamicWorkflowRunError::new(format!("{error:#}"))
}

impl WorkflowRunService {
    /// Node `getScript` for one parent session (9.43). Blocking: it reads the journal, so the caller runs it on the pool.
    pub(crate) fn script_of(
        &self,
        parent: &str,
        run_id: &str,
    ) -> Result<Option<String>, DynamicWorkflowRunError> {
        let Some(store) = self.inner.store.get().cloned() else {
            return Err(DynamicWorkflowRunError::unsupported("getScript"));
        };
        let row = store.get_run(run_id).map_err(store_failure)?;
        Ok(row
            .filter(|row| row.parent_session_id.as_deref() == Some(parent))
            .and_then(|row| row.script_text))
    }

    /// Node `amend`, for the parent session the port belongs to (9.43). A refusal is an answer; an error is a failure
    /// Node would throw. A refusal changes nothing; the stop of a live predecessor happens only after its preflight passed.
    pub(crate) async fn amend_run(
        &self,
        parent: &str,
        request: AmendRequest,
    ) -> Result<AmendResult, DynamicWorkflowRunError> {
        // Options this host does not carry are refused up front. Dropping them would start a successor that differs
        // from what the caller asked for, after the predecessor is already stopped.
        if request.subagent_model.is_some() || request.model_bindings.is_some() {
            return Err(DynamicWorkflowRunError::new(
                "this host cannot amend a run's subagent model or script-named models yet, so the run is not amended",
            ));
        }
        if request.phase_names.is_some()
            || request.phase_alongside.is_some()
            || request.inherit_args
        {
            return Err(DynamicWorkflowRunError::new(
                "this host cannot amend a run with phase routing or inherited arguments yet, so the run is not amended",
            ));
        }
        if let Some(limit) = request.max_concurrency
            && !limit.is_finite()
        {
            return Err(DynamicWorkflowRunError::new(
                "the concurrency limit must be a finite number, so the run is not amended",
            ));
        }
        let Some(default) = self.default_concurrency_value() else {
            return Err(DynamicWorkflowRunError::unsupported("amend"));
        };
        let Some(store) = self.inner.store.get().cloned() else {
            return Err(DynamicWorkflowRunError::unsupported("amend"));
        };
        let Some(bindings) = self.inner.bindings.get().cloned() else {
            return Err(DynamicWorkflowRunError::new(
                "the run service cannot read the parent's permission mode, so the run is not amended",
            ));
        };
        // Per-session routing (divergence 394): a predecessor of another session is unknown to this one.
        if let Some(named) = request.parent_session_id.as_ref()
            && named.as_str() != parent
        {
            return Err(DynamicWorkflowRunError::new(format!(
                "the amend names the parent session {} but its run port belongs to {parent}, so the run is not amended",
                named.as_str()
            )));
        }
        let predecessor = request.predecessor_run_id.as_str().to_owned();

        // 1. Preflight: a refusal has no side effects.
        let preflight_store = store.clone();
        let preflight_id = predecessor.clone();
        let row = match on_blocking_pool(move || {
            preflight_store
                .amend_preflight(&preflight_id)
                .map_err(store_failure)
        })
        .await?
        {
            Ok(row) => row,
            Err(reason) => return Ok(AmendResult::Refused(refusal_of(reason))),
        };
        if row.parent_session_id.as_deref() != Some(parent) {
            return Ok(AmendResult::Refused(AmendRefusalReason::RunNotFound));
        }

        // 2. The successor's id, then 3. the stop of a live predecessor, awaited through its own settlement.
        let successor = mint_run_id();
        self.stop_superseded_if_live(&predecessor, &successor)
            .await?;

        // 4. The import cache, built from the settled predecessor. The preflight passed, so a refusal here means the
        // predecessor is not terminal (owned by another process): a host fault, not an answer.
        let import_store = store.clone();
        let import_id = predecessor.clone();
        let cache = match on_blocking_pool(move || {
            import_store.amend_import(&import_id).map_err(store_failure)
        })
        .await?
        {
            BuildOutcome::Built { cache, .. } => cache,
            BuildOutcome::Refused(reason) => {
                return Err(DynamicWorkflowRunError::new(format!(
                    "dynamic workflow amend could not import from run {predecessor} after preflight: {}",
                    reason.as_str()
                )));
            }
        };

        // 5. The settled row, re-read after the stop: the tokens, the limit and the name are its final values. Whether
        // this amend stopped the predecessor is read from the row too: a run that settled on its own before the stop
        // reached it keeps its own stop reason and has no successor.
        let settled_store = store.clone();
        let settled_id = predecessor.clone();
        let settled = on_blocking_pool(move || {
            settled_store.get_run(&settled_id).map_err(store_failure)
        })
        .await?
        .ok_or_else(|| {
            DynamicWorkflowRunError::new(format!(
                "run {predecessor} has no row after its settlement, so the amend cannot read it"
            ))
        })?;
        let superseded = settled.superseded_by.as_deref() == Some(successor.as_str());

        // Node: an omitted limit keeps the predecessor's, which the snapshot reports only when it differs from the default.
        let max_concurrency = match request.max_concurrency {
            Some(value) => value.floor().max(1.0),
            None if settled.caps.max_concurrency == default => default,
            None => settled.caps.max_concurrency,
        };

        // 6. The launch, as a submit does, with the predecessor as `resumedFrom`.
        let input = LaunchInput {
            script_text: request.script_text.clone(),
            run_id: successor.clone(),
            args: None,
            resumed_from: Some(predecessor.clone()),
            cwd: PathBuf::from(&request.cwd),
        };
        let config = EngineConfig {
            run_id: successor.clone(),
            caps: Caps { max_concurrency },
            script_text: Some(request.script_text),
            name: request.name.or(settled.name),
            args: None,
            parent_session_id: Some(parent.to_owned()),
            cwd: Some(request.cwd),
            tool_call_id: request.tool_call_id,
            resumed_from: Some(predecessor.clone()),
            // Divergence 452: Node's revision inherits the predecessor's input id; the row does not keep it, so a new one.
            launch: Some(LaunchFields {
                input_id: uuid_v4(),
                script_path: request.script_path,
                ..LaunchFields::default()
            }),
            inherited_tokens: Some(settled.spent_tokens),
            imported_cache: Some(cache),
            ..EngineConfig::default()
        };
        match self.launch_successor(input, config, bindings).await {
            Ok(()) => Ok(AmendResult::Started {
                run_id: WorkflowRunId::new(successor),
                superseded_run_id: superseded.then(|| WorkflowRunId::new(predecessor)),
            }),
            // The predecessor is already stopped when the start fails. Say so, so the caller does not assume nothing changed:
            // its finished work stays importable by a new amend.
            Err(error) if superseded => Err(DynamicWorkflowRunError::new(format!(
                "{} Run {predecessor} was already stopped as superseded before this start failed, so its finished work stays importable: amend it again to retry.",
                error.message
            ))),
            Err(error) => Err(error),
        }
    }

    /// The start of the successor: the parent's mode is recorded, then the child, the compile and the owner start.
    async fn launch_successor(
        &self,
        input: LaunchInput,
        config: EngineConfig,
        bindings: Arc<dyn ActorBindingsPort>,
    ) -> Result<(), DynamicWorkflowRunError> {
        let config = record_parent_mode_on_blocking_pool(config, bindings).await?;
        self.start(input, config, Some(compile_check()))
            .await
            .map_err(start_failure)
    }

    /// Stops the predecessor as superseded by `successor` if it is live in this process, and waits for its settlement.
    /// A predecessor that is not live (settled, or unknown here) is left alone. A predecessor that is still starting
    /// cannot be stopped yet, and a second stop of one that is already being stopped is refused, both as host faults.
    async fn stop_superseded_if_live(
        &self,
        run_id: &str,
        successor: &str,
    ) -> Result<(), DynamicWorkflowRunError> {
        let serve = {
            let mut state = self.inner.state.lock_unpoisoned();
            if state.starting.contains(run_id) {
                return Err(DynamicWorkflowRunError::new(format!(
                    "run {run_id} is still starting, so it cannot be superseded yet"
                )));
            }
            let Some(entry) = state.runs.get_mut(run_id) else {
                return Ok(());
            };
            let Some(serve) = entry.serve.take() else {
                return Err(DynamicWorkflowRunError::new(format!(
                    "run {run_id} is already being stopped, so it cannot be superseded again"
                )));
            };
            // The stop is posted under the lock. If the owner already settled the run on its own, the post is not
            // delivered and the join below ends at once; the caller reads the settled row and so sees no successor.
            entry.handle.stop_superseded(successor);
            serve
        };
        let failures = join_owner(serve).await;
        if !failures.is_empty() {
            buffer_failures(&mut self.inner.state.lock_unpoisoned().failures, failures);
        }
        Ok(())
    }
}
