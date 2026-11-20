//! Fork: the run's cancel from the background registry (specs/fork-rust-workflow-engine.md, 9.48, W8a; Node
//! `stopDynamicWorkflowBackgroundTask`, `core/src/runtime/methods/background-stop-dynamic-workflow.ts`).
//!
//! GUI cancel, the Stop button and the model's TaskStop all reach `cancel_run_of` through the agents' stop path, one
//! path for the three. The run settles as `stopped(user | model)`: its in-flight asks are cancelled and its parked
//! questions withdrawn. Node's retired-question table (`bootstrap/src/app/workflow-escalation-registry.ts`) answers a
//! later resolve of a withdrawn or answered question: `run_not_in_flight` or `already_resolved` (divergence 391).

use std::collections::{HashMap, VecDeque};

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::workflow_run::{CancelInitiator, DynamicWorkflowRunError};
use rust_cli_workflow::driver_owner::StopInitiator;
use serde_json::Value;

use super::WorkflowRunService;

/// Node `RETIRED_HISTORY_LIMIT`: past this many retired questions, the oldest is forgotten.
const RETIRED_HISTORY_LIMIT: usize = 256;

/// How a question left the registry: answered, or withdrawn with its ask (the run was stopped).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Retired {
    Resolved,
    Withdrawn,
}

/// The retired questions of the process, by qid. Qids are minted per process, so one table serves every session.
#[derive(Default)]
pub(crate) struct RetiredQuestions {
    reasons: HashMap<String, Retired>,
    order: VecDeque<String>,
}

impl RetiredQuestions {
    /// Retires `qid`. A question already answered stays answered: a withdrawal never downgrades it (Node's `withdraw`
    /// retires only a parked question, so a resolved one keeps `already_resolved`).
    fn retire(&mut self, qid: &str, how: Retired) {
        if how == Retired::Withdrawn && self.reason(qid) == Some(Retired::Resolved) {
            return;
        }
        if self.reasons.insert(qid.to_owned(), how).is_none() {
            self.order.push_back(qid.to_owned());
        }
        while self.order.len() > RETIRED_HISTORY_LIMIT {
            if let Some(oldest) = self.order.pop_front() {
                self.reasons.remove(&oldest);
            }
        }
    }

    fn reason(&self, qid: &str) -> Option<Retired> {
        self.reasons.get(qid).copied()
    }
}

/// The qids in a run's snapshot `pendingQuestions` (the projection's list of parked questions). Entries without a string
/// `qid` are skipped.
fn pending_question_ids(run: &Value) -> Vec<String> {
    run.get("pendingQuestions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .filter_map(|question| question.get("qid").and_then(Value::as_str))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The stop initiator of a cancel. The amend path stops its predecessor itself (9.43), so no cancel names a successor, and
/// that is a caller error rather than a missing capability.
fn stop_initiator(initiator: &CancelInitiator) -> Result<StopInitiator, DynamicWorkflowRunError> {
    match initiator {
        CancelInitiator::User => Ok(StopInitiator::User),
        CancelInitiator::Model => Ok(StopInitiator::Model),
        CancelInitiator::Superseded(_) => Err(DynamicWorkflowRunError::new(
            "a cancel names no successor: amend stops its predecessor itself",
        )),
    }
}

impl WorkflowRunService {
    /// Node `cancel` (9.48): stops the live run `run_id` of `parent`. `Ok(false)` when this session holds no such run live
    /// (unknown, already settled, or another session's), and nothing is stopped.
    pub(crate) fn cancel_run_of(
        &self,
        parent: &str,
        run_id: &str,
        initiator: &CancelInitiator,
    ) -> Result<bool, DynamicWorkflowRunError> {
        let initiator = stop_initiator(initiator)?;
        let handle = {
            let state = self.inner.state.lock_unpoisoned();
            state
                .runs
                .get(run_id)
                .filter(|entry| entry.parent == parent)
                .map(|entry| entry.handle.clone())
        };
        let Some(handle) = handle else {
            return Ok(false);
        };
        // The parked questions are read before the stop: the stop withdraws them, and a later answer is refused.
        // Approximation (divergence 606): a question parked after this read and before the stop is withdrawn but not
        // retired, so its later answer reads as `unknown_question`.
        let parked = self.parked_question_ids(parent, run_id);
        if !handle.stop_run(initiator) {
            // The owner is gone, so the run is settling or settled: there is nothing left to stop.
            return Ok(false);
        }
        self.retire_questions(&parked, Retired::Withdrawn);
        Ok(true)
    }

    /// The qids of one run's parked questions, from its projection (the snapshot's `pendingQuestions`).
    fn parked_question_ids(&self, parent: &str, run_id: &str) -> Vec<String> {
        self.run_snapshot_of(parent, run_id)
            .as_ref()
            .map(pending_question_ids)
            .unwrap_or_default()
    }

    /// Records questions that left the registry without an answer, or with one (the retired table, 9.48).
    pub(crate) fn retire_questions(&self, qids: &[String], how: Retired) {
        let mut state = self.inner.state.lock_unpoisoned();
        for qid in qids {
            state.retired.retire(qid, how);
        }
    }

    /// How a question left the registry, if it did and was not parked since.
    pub(crate) fn retired_reason(&self, qid: &str) -> Option<Retired> {
        self.inner.state.lock_unpoisoned().retired.reason(qid)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Retired, RetiredQuestions, pending_question_ids};

    #[test]
    fn the_parked_ids_come_from_the_projection_qids() {
        // The field names are the projection's (`pendingQuestions`, `qid`); an entry without a string qid is skipped.
        let run = json!({
            "runId": "wf_1",
            "pendingQuestions": [
                {"qid": "q_1", "question": "which?"},
                {"question": "no id"},
                {"qid": "q_2"}
            ]
        });
        assert_eq!(pending_question_ids(&run), vec!["q_1", "q_2"]);
        assert!(pending_question_ids(&json!({"runId": "wf_1"})).is_empty());
    }

    #[test]
    fn a_withdrawal_never_downgrades_an_answered_question() {
        let mut table = RetiredQuestions::default();
        table.retire("q_1", Retired::Resolved);
        table.retire("q_1", Retired::Withdrawn);
        assert_eq!(table.reason("q_1"), Some(Retired::Resolved));
        table.retire("q_2", Retired::Withdrawn);
        assert_eq!(table.reason("q_2"), Some(Retired::Withdrawn));
    }
}
