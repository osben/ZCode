//! Fork: goal completion verification markers, like Node's `onTargetVerification` (bootstrap
//! `zcode-protocol-v4/product-projection.ts`; specs/fork-rust-goal-verifier.md §4). One `timelineMarker` row per
//! target and iteration, in the `turnTailBoundary` lane of the turn the verification followed: `running` when it
//! starts, then `pass`, `notSatisfied` or `failed`. While it runs the control shows a `goalVerifier` work.

use rust_cli_kernel_api::goal::{
    GoalState, GoalVerification, VerificationItem, VerificationOutcome, VerificationStatus,
};
use serde_json::{Map, Value, json};

use super::{Projection, RowKind, state::Phase};

fn marker_key(target: &str, iteration: u32) -> String {
    format!("goal_verify:{target}_{iteration}")
}

fn outcome_name(outcome: VerificationOutcome) -> &'static str {
    match outcome {
        VerificationOutcome::Pass => "pass",
        VerificationOutcome::NotSatisfied => "notSatisfied",
        VerificationOutcome::Failed => "failed",
    }
}

impl Projection {
    /// Node `goalVerifyTurnId`: the anchor turn when it has rows, else the running or latest turn.
    fn verify_turn(&self, anchor: Option<&str>) -> String {
        if let Some(anchor) = anchor
            && self
                .rows
                .iter()
                .any(|row| row.get("turnId").and_then(Value::as_str) == Some(anchor))
        {
            return anchor.to_owned();
        }
        if let Some(turn) = &self.turn {
            return turn.id.clone();
        }
        self.rows
            .iter()
            .rev()
            .find_map(|row| row.get("turnId").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default()
    }

    /// Appends the marker row, or replaces the marker of the row the same target and iteration already has.
    fn put_verify_marker(
        &mut self,
        key: String,
        turn: &str,
        marker: Value,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        if self.index.contains_key(&key) {
            self.upsert(
                &key,
                |row| {
                    row.insert("marker".into(), marker);
                },
                out,
            );
            return;
        }
        let entity = key.replace(':', "_");
        let mut row: Map<String, Value> =
            self.base(turn, &entity, RowKind::TimelineMarker, now, seq);
        row.insert("lane".into(), json!("turnTailBoundary"));
        row.insert("marker".into(), marker);
        self.append(key, row, out);
    }

    /// A live verification step: the marker and the control's `goalVerifier` work.
    pub(super) fn goal_verification(
        &mut self,
        step: &GoalVerification,
        now: u64,
        seq: u64,
        out: &mut Vec<Value>,
    ) {
        let key = marker_key(&step.target_id, step.goal_iteration);
        let turn = self.verify_turn(step.anchor_turn_id.as_deref());
        let iteration = step.goal_iteration;
        if step.status == VerificationStatus::Started {
            let marker =
                json!({"type": "goalVerify", "iteration": iteration, "outcome": "running"});
            self.put_verify_marker(key, &turn, marker, now, seq, out);
            self.goal_verifier = Some(now);
            self.goal_verifier_failed = false;
            self.phase = Phase::Running;
            self.error = None;
            return;
        }
        let outcome = match (step.status, &step.verification) {
            (VerificationStatus::Completed, Some(verdict)) if verdict.passed => "pass",
            (VerificationStatus::Completed, _) => "notSatisfied",
            _ => "failed",
        };
        let mut marker = json!({"type": "goalVerify", "iteration": iteration, "outcome": outcome});
        if step.status == VerificationStatus::Cancelled {
            marker["detail"] = json!("cancelled");
        } else if let Some(reason) = step
            .verification
            .as_ref()
            .map(|verdict| verdict.reason.as_str())
            .filter(|reason| !reason.is_empty())
        {
            marker["detail"] = json!(reason);
        }
        self.put_verify_marker(key, &turn, marker, now, seq, out);
        if self.goal_verifier.take().is_some() {
            self.goal_verifier_failed = step.status == VerificationStatus::FailedClosed;
            self.phase = match step.status {
                VerificationStatus::Cancelled => Phase::CompletedInterrupted,
                VerificationStatus::FailedClosed => Phase::Error,
                _ => Phase::CompletedSuccess,
            };
        }
    }

    /// The cold marker of a finished verification (after its anchor message's row, see [`super::cold`]).
    pub(super) fn verified(&mut self, target: &str, item: &VerificationItem, out: &mut Vec<Value>) {
        let key = marker_key(target, item.iteration);
        let turn = self.verify_turn(None);
        let mut marker = json!({
            "type": "goalVerify",
            "iteration": item.iteration,
            "outcome": outcome_name(item.outcome),
        });
        if let Some(reason) = item.reason.as_deref().filter(|reason| !reason.is_empty()) {
            marker["detail"] = json!(reason);
        }
        self.put_verify_marker(key, &turn, marker, item.at_ms, 0, out);
    }

    /// Snapshot `goal.verifications` (Node `goalStateSchema`): `anchorRowId` is the marker row.
    pub(super) fn verifications_json(&self, goal: &GoalState) -> Value {
        goal.verifications
            .iter()
            .map(|item| {
                let mut value = json!({
                    "iteration": item.iteration,
                    "outcome": outcome_name(item.outcome),
                    "at": item.at_ms,
                    "anchorRowId": self.row_id(&marker_key(&goal.target, item.iteration)),
                });
                if let Some(reason) = item.reason.as_deref().filter(|reason| !reason.is_empty()) {
                    value["reason"] = json!(reason);
                }
                if let Some(next) = &item.next_action {
                    value["nextAction"] = json!(next);
                }
                value
            })
            .collect()
    }
}
