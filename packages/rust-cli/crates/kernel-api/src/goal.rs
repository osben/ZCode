//! `/goal`：停止前检查的目标与 `goal_status` attachment（docs/specs/rust-cli/goal.md）。
//!
//! 目标的唯一 owner 是会话 actor；对话里的 `goal_status` attachment 是持久事实（resume 时从它恢复）。
//! 这里只有形状与来源名，状态变化与文字在 session，评估在 hooks。

use serde::{Deserialize, Serialize};

/// `goal_status` attachment 的来源（attachment type）。文本为空，发给模型时不渲染。
pub const STATUS_SOURCE: &str = "goal_status";
/// 设定目标时给模型的说明的 meta 来源。
pub const PROMPT_SOURCE: &str = "goal";

/// `goal_status` attachment 的数据（键名固定，resume 时读回）。`sentinel` 是设定 / 清除时的标记，不显示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalStatus {
    pub met: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sentinel: bool,
    /// 条件被判为不可能。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub failed: bool,
    pub condition: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    /// Fork (desktop App): a pause (`Some(true)`) or resume (`Some(false)`) of the active goal
    /// (Node `pauseGoal` / `resumeGoal`); None for set, clear and evaluation statuses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
}

/// Fork: the meta source of the desktop goal continuation prompt (Node `target_continuation`).
pub const CONTINUATION_SOURCE: &str = "target_continuation";

/// Fork: the desktop goal's status (Node `goalStateSchema.status`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GoalPhase {
    Active,
    Paused,
    /// A completion verification runs (specs/fork-rust-goal-verifier.md).
    Verifying,
    Verified,
    /// The last verification found the goal not complete.
    NotSatisfied,
    Failed,
}

/// Fork: Node `TargetCompletionVerificationStatus`, one step of a goal completion verification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationStatus {
    Started,
    Completed,
    /// The request failed; the verdict fails open (passed).
    FailedClosed,
    Cancelled,
}

/// Fork: Node `GoalCompletionVerificationOutput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationVerdict {
    pub passed: bool,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,
}

/// Fork: Node `TargetCompletionVerificationPayload` (the session entry's `payload`, same keys).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalVerification {
    pub target_id: String,
    pub status: VerificationStatus,
    pub verification_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verification: Option<VerificationVerdict>,
    #[serde(default)]
    pub goal_iteration: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_assistant_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_turn_id: Option<String>,
}

/// Fork: a verification step and its time (`LoadedSession::goal_verifications`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedVerification {
    pub verification: GoalVerification,
    pub at_ms: u64,
}

/// Fork: the outcome of a finished verification (Node `verifications[].outcome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VerificationOutcome {
    Pass,
    NotSatisfied,
    Failed,
}

/// Fork: a finished verification of the goal (Node `goalStateSchema.verifications[]`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationItem {
    pub iteration: u32,
    pub outcome: VerificationOutcome,
    pub at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_action: Option<String>,
    /// The assistant message the verification followed (`anchorAssistantMessageId`): a cold projection places the
    /// marker after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_message: Option<String>,
}

/// Fork: the latest step per target and iteration, in the order each verification first appears (Node dedupes the
/// timeline by `targetId` + `goalIteration`).
pub fn latest_steps(
    steps: impl IntoIterator<Item = RecordedVerification>,
) -> Vec<RecordedVerification> {
    let mut latest: Vec<RecordedVerification> = Vec::new();
    for step in steps {
        let same = |known: &&mut RecordedVerification| {
            known.verification.target_id == step.verification.target_id
                && known.verification.goal_iteration == step.verification.goal_iteration
        };
        match latest.iter_mut().find(same) {
            Some(known) => *known = step,
            None => latest.push(step),
        }
    }
    latest
}

/// Fork: Node `PROTOCOL_V4_LIMITS.goalVerificationsRetained`.
pub const VERIFICATIONS_RETAINED: usize = 20;

impl GoalVerification {
    /// The finished item of a terminal step; None for `started` and `cancelled` (Node lists neither).
    pub fn item(&self, at_ms: u64) -> Option<VerificationItem> {
        let outcome = match (self.status, &self.verification) {
            (VerificationStatus::Completed, Some(verdict)) if verdict.passed => {
                VerificationOutcome::Pass
            }
            (VerificationStatus::Completed, Some(_)) => VerificationOutcome::NotSatisfied,
            (VerificationStatus::FailedClosed, _) => VerificationOutcome::Failed,
            _ => return None,
        };
        Some(VerificationItem {
            iteration: self.goal_iteration,
            outcome,
            at_ms,
            reason: self
                .verification
                .as_ref()
                .map(|verdict| verdict.reason.clone()),
            next_action: self
                .verification
                .as_ref()
                .and_then(|verdict| verdict.next_action.clone()),
            anchor_message: self.anchor_assistant_message_id.clone(),
        })
    }
}

/// Fork: the desktop goal as the App shows it (Node snapshot `goal`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalState {
    /// The `goal_status` attachment that set the goal.
    pub target: String,
    pub objective: String,
    pub status: GoalPhase,
    /// Evaluations that found the goal not met yet; on the desktop path, the last verification's iteration.
    pub iteration: u32,
    /// Time spent active before the current active stretch.
    pub time_used_seconds: u64,
    /// When the current active stretch started; None while paused or finished.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_run_started_at_ms: Option<u64>,
    /// Fork (desktop App): the goal's short title (Node `target.summaryTitle`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_title: Option<String>,
    /// Fork (desktop App): the goal's finished verifications, the last [`VERIFICATIONS_RETAINED`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verifications: Vec<VerificationItem>,
}

/// 正在生效的目标的快照。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveGoal {
    pub condition: String,
    /// 已评估且未达成的次数。
    pub iterations: u32,
    pub set_at_ms: u64,
    /// 设定以来主线程的输出 token。
    pub tokens: u64,
    /// 上一次评估给出的原因。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_reason: Option<String>,
}

/// `/goal` 面板的数据（`SessionHandle::goal`）：当前目标，以及最近一次达成的结果。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoalView {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active: Option<ActiveGoal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub achieved: Option<GoalStatus>,
}

#[cfg(test)]
#[path = "goal_tests.rs"]
mod tests;
