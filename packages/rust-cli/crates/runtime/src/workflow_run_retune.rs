//! Fork: the in-place retune of a live run (specs/fork-rust-workflow-engine.md, 9.50, W8c, divergence 455; Node
//! `retuneRunConcurrency` in `bootstrap/src/app/dynamic-workflow-run-retune.ts`).
//!
//! A concurrency-only change to a run in flight keeps the run: the same run id, no stop and no successor. The owner applies
//! it on its own thread (the engine writes the cap and the event, and the bound follows), so the answer is the owner's. A run
//! that is not live in this process (unknown, settled, still starting, or being stopped) is `NotLive`: the caller then
//! amends the run instead. A run of another session is `NotLive` too, since this service holds none of its runs.

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, RetuneOutcome, RetuneRefusal, RetuneRequest,
};
use rust_cli_workflow::actor_mailbox::MailboxError;
use rust_cli_workflow::driver_owner::RetuneAnswer;

use super::WorkflowRunService;
use super::list::on_blocking_pool;

impl WorkflowRunService {
    /// Node `retuneConcurrency` for the parent session the port belongs to (9.50). A refusal is an answer; an error is a
    /// failure (a wiring fault, or a non-finite limit, refused before anything is read).
    pub(crate) async fn retune_run(
        &self,
        parent: &str,
        request: RetuneRequest,
    ) -> Result<RetuneOutcome, DynamicWorkflowRunError> {
        let Some(default) = self.default_concurrency_value() else {
            return Err(DynamicWorkflowRunError::unsupported("retuneConcurrency"));
        };
        let next = match request.max_concurrency {
            None => default,
            Some(value) if !value.is_finite() => {
                return Err(DynamicWorkflowRunError::new(
                    "the concurrency limit must be a finite number, so the run is not retuned",
                ));
            }
            Some(value) => value.floor().max(1.0),
        };
        let run_id = request.run_id.as_str().to_owned();
        // The live entry of this parent, and only while it is not being stopped: a stop holds the entry's serve thread.
        let handle = {
            let state = self.inner.state.lock_unpoisoned();
            if state.starting.contains(&run_id) {
                return Ok(RetuneOutcome::Refused(RetuneRefusal::NotLive));
            }
            match state.runs.get(&run_id) {
                Some(entry) if entry.parent == parent && entry.serve.is_some() => {
                    entry.handle.clone()
                }
                _ => return Ok(RetuneOutcome::Refused(RetuneRefusal::NotLive)),
            }
        };
        let answer = on_blocking_pool(move || match handle.retune(next) {
            Ok(answer) => Ok(answer),
            // The owner settled the run after the liveness check, and its mailbox is gone: not live, the settled answer.
            Err(MailboxError::NotDelivered) => Ok(RetuneAnswer::NotLive),
            Err(error) => Err(DynamicWorkflowRunError::new(format!(
                "the owner refused the retune: {error}"
            ))),
        })
        .await?;
        Ok(match answer {
            RetuneAnswer::Retuned { previous, current } => RetuneOutcome::Retuned {
                previous,
                max_concurrency: current,
                default_concurrency: default,
            },
            RetuneAnswer::Unchanged { current } => {
                RetuneOutcome::Refused(RetuneRefusal::Unchanged { current })
            }
            RetuneAnswer::NotLive => RetuneOutcome::Refused(RetuneRefusal::NotLive),
        })
    }
}
