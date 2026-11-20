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

use rust_cli_base::sync::LockUnpoisoned;

use super::submit::{
    compile_check, mint_run_id, record_parent_mode_on_blocking_pool, start_failure,
};
use super::{WorkflowRunService, buffer_failures, join_owner};

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

/// A journal read on the blocking pool. A failed read is a failure the caller reports; a refusal is an `Ok` value.
async fn on_pool<T: Send + 'static>(
    work: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, DynamicWorkflowRunError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| {
            DynamicWorkflowRunError::new(format!("the amend did not finish: {error}"))
        })?
        .map_err(|error| DynamicWorkflowRunError::new(format!("{error:#}")))
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
        let row = store
            .get_run(run_id)
            .map_err(|error| DynamicWorkflowRunError::new(format!("{error:#}")))?;
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
        if request.subagent_model.is_some() || request.model_bindings.is_some() {
            return Err(DynamicWorkflowRunError::new(
                "this host cannot amend a run's subagent model or script-named models yet, so the run is not amended",
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
        let row = match on_pool(move || preflight_store.amend_preflight(&preflight_id)).await? {
            Ok(row) => row,
            Err(reason) => return Ok(AmendResult::Refused(refusal_of(reason))),
        };
        if row.parent_session_id.as_deref() != Some(parent) {
            return Ok(AmendResult::Refused(AmendRefusalReason::RunNotFound));
        }

        // 2. The successor's id, then 3. the stop of a live predecessor, awaited through its own settlement.
        let successor = mint_run_id();
        let superseded = self
            .stop_superseded_if_live(&predecessor, &successor)
            .await?;

        // 4. The import cache, built from the settled predecessor. The preflight passed, so a refusal here means the
        // predecessor is not terminal (owned by another process): a host fault, not an answer.
        let import_store = store.clone();
        let import_id = predecessor.clone();
        let cache = match on_pool(move || import_store.amend_import(&import_id)).await? {
            BuildOutcome::Built { cache, .. } => cache,
            BuildOutcome::Refused(reason) => {
                return Err(DynamicWorkflowRunError::new(format!(
                    "dynamic workflow amend could not import from run {predecessor} after preflight: {}",
                    reason.as_str()
                )));
            }
        };

        // 5. The settled row: the inherited tokens and the name are read after the stop (Node reads them again there).
        let settled_store = store.clone();
        let settled_id = predecessor.clone();
        let settled = on_pool(move || settled_store.get_run(&settled_id))
            .await?
            .unwrap_or(row);

        // Node: an omitted limit keeps the predecessor's, which the snapshot reports only when it differs from the default.
        let max_concurrency = match request.max_concurrency {
            Some(value) => value.floor().max(1.0),
            None if (settled.caps.max_concurrency - default).abs() < f64::EPSILON => default,
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
        let config = record_parent_mode_on_blocking_pool(config, bindings).await?;
        match self.start(input, config, Some(compile_check())).await {
            Ok(()) => Ok(AmendResult::Started {
                run_id: WorkflowRunId::new(successor),
                superseded_run_id: superseded.then(|| WorkflowRunId::new(predecessor)),
            }),
            Err(error) => Err(start_failure(error)),
        }
    }

    /// Stops the predecessor as superseded by `successor` if it is live in this process, and waits for its settlement.
    /// Returns whether it was live. A predecessor that is still starting cannot be stopped yet, and a second stop of
    /// one that is already being stopped is refused, both as host faults.
    async fn stop_superseded_if_live(
        &self,
        run_id: &str,
        successor: &str,
    ) -> Result<bool, DynamicWorkflowRunError> {
        let serve = {
            let mut state = self.inner.state.lock_unpoisoned();
            if state.starting.contains(run_id) {
                return Err(DynamicWorkflowRunError::new(format!(
                    "run {run_id} is still starting, so it cannot be superseded yet"
                )));
            }
            let Some(entry) = state.runs.get_mut(run_id) else {
                return Ok(false);
            };
            let Some(serve) = entry.serve.take() else {
                return Err(DynamicWorkflowRunError::new(format!(
                    "run {run_id} is already being stopped, so it cannot be superseded again"
                )));
            };
            // The stop is posted under the lock: the owner's thread settles the run, and `serve` ends with the settlement.
            entry.handle.stop_superseded(successor);
            serve
        };
        let failures = join_owner(serve).await;
        if !failures.is_empty() {
            buffer_failures(&mut self.inner.state.lock_unpoisoned().failures, failures);
        }
        Ok(true)
    }
}
