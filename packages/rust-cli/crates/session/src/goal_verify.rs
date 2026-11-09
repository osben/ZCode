//! Fork (desktop App): Node's goal completion verifier (core `target-completion-verification.ts`,
//! `target-continuation-loop.ts`; specs/fork-rust-goal-verifier.md). After a main turn of a session with an active
//! desktop goal completes, the actor runs one verification as a session job (busy, cancellable by `Interrupt`); the
//! verdict commits the goal's `goal_status` and, when it is not met and names a next action, starts the goal's
//! continuation turn. The session actor stays the single goal owner.

use rust_cli_kernel_api::goal::{GoalVerification, VerificationStatus, VerificationVerdict};
use rust_cli_kernel_api::ids::{SessionId, TurnId};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::{
    ApiMessage, ModelPort, ModelRequest, ModelSelection, SystemBlock,
};
use rust_cli_kernel_api::orchestration::QueryRunner;
use rust_cli_kernel_api::session_api::KernelEvent;
use rust_cli_kernel_api::side_request::{Requester, SideReply, SideSource};
use rust_cli_kernel_api::store::Fact;
use rust_cli_prompts::models;
use rust_cli_prompts::texts::identity;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

use crate::actor::{Actor, Job, JobDone};
use crate::goal_verify_text::{Facts, fail_open, parse, prompt};

/// The output limit for a model the cards do not know (as the main loop).
const DEFAULT_MAX_TOKENS: u32 = models::UNKNOWN_MAX_OUTPUT_TOKENS;

/// How a verification request ended.
pub(crate) enum Outcome {
    Verdict(VerificationVerdict),
    /// The request failed (fails open, Node `failed_closed`).
    Failed(String),
    Cancelled,
}

/// The running verification (`Actor::goal_verify`): the step fields shared by its started and terminal steps.
pub(crate) struct Pending {
    target: String,
    iteration: u32,
    verification_id: String,
    anchor_turn: TurnId,
    anchor_message: Option<String>,
}

impl Pending {
    fn step(
        &self,
        status: VerificationStatus,
        verification: Option<VerificationVerdict>,
    ) -> GoalVerification {
        GoalVerification {
            target_id: self.target.clone(),
            status,
            verification_id: self.verification_id.clone(),
            verification,
            goal_iteration: self.iteration,
            anchor_assistant_message_id: self.anchor_message.clone(),
            anchor_turn_id: Some(self.anchor_turn.as_str().to_owned()),
        }
    }
}

/// The verification request: the active history normalized like the main loop, then Node's prompt as the last user
/// message; the session's main model, no tools.
async fn verify(
    model: Arc<dyn ModelPort>,
    runner: Arc<dyn QueryRunner>,
    selection: ModelSelection,
    session: SessionId,
    history: Vec<Message>,
    text: String,
    cancel: CancellationToken,
) -> Outcome {
    let found = model.capabilities(&selection).await;
    let configured_output = found.as_ref().and_then(|found| found.max_output_tokens);
    let mid_system = found.map(|found| found.supports_mid_conversation_system);
    let mut messages = runner.transcript(&history, &selection, mid_system);
    messages.push(ApiMessage::user_text(text));
    let max_tokens = models::card_output_limit(&selection.model, configured_output)
        .unwrap_or(DEFAULT_MAX_TOKENS);
    let mut request = ModelRequest::side(
        selection.clone(),
        SideSource::GoalVerification,
        vec![SystemBlock {
            text: identity().to_owned(),
            cache_control: None,
        }],
        messages,
        max_tokens,
        Requester {
            session,
            run: None,
            agent: None,
        },
    );
    request.options.effort = models::card_effort(&selection.model, selection.reasoning.as_deref());
    let reply = SideReply::collect(model.stream(request, cancel.clone())).await;
    if cancel.is_cancelled() {
        return Outcome::Cancelled;
    }
    match reply {
        Ok(reply) => Outcome::Verdict(parse(&reply.text())),
        Err(error) => Outcome::Failed(error.to_string()),
    }
}

impl Actor {
    /// The model's session never needs a verification: Node's yield conditions (queued input or a waiting notice runs
    /// first and is verified itself), plan mode, background agents still running, a closing session.
    async fn verification_due(&self) -> bool {
        if !self.deps.desktop_goals
            || self.closing.is_some()
            || self.shutting_down
            || self.execution.plan
            || self.goal.condition().is_none()
            || self.has_next_input()
        {
            return false;
        }
        self.deps
            .agents
            .background_agents(&self.meta.id)
            .await
            .is_empty()
    }

    /// After a completed main turn (`anchor_turn`): starts the goal's completion verification when it is due; returns
    /// whether it started.
    pub(crate) async fn verify_goal_after_turn(&mut self, anchor_turn: TurnId) -> bool {
        if !self.verification_due().await {
            return false;
        }
        let now = self.deps.clock.now_ms();
        let Some((target, iteration, objective, tokens_used, time_used_seconds)) =
            self.goal.verification_start(now)
        else {
            return false;
        };
        let anchor_message = self
            .messages
            .iter()
            .rev()
            .find_map(|message| match message {
                Message::Assistant(assistant) => Some(assistant.id.as_str().to_owned()),
                _ => None,
            });
        let pending = Pending {
            target,
            iteration,
            verification_id: format!("goalverify_{}", self.deps.ids.operation().as_str()),
            anchor_turn,
            anchor_message,
        };
        self.emit_goal();
        self.verification_step(pending.step(VerificationStatus::Started, None), now)
            .await;
        let text = prompt(&Facts {
            objective: &objective,
            status: "active",
            tokens_used,
            time_used_seconds,
        });
        let model = self.deps.side_model.clone();
        let runner = self.deps.runner.clone();
        let selection = self.selection.clone();
        let session = self.meta.id.clone();
        let history = self.messages.clone();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = self.deps.spawner.spawn("goal-verification", async move {
            JobDone::GoalVerified(Box::new(
                verify(model, runner, selection, session, history, text, token).await,
            ))
        });
        self.goal_verify = Some(pending);
        self.job = Some(Job {
            task,
            cancel: Some(cancel),
        });
        true
    }

    /// Records a verification step (a Node session entry) and shows it (the timeline marker).
    async fn verification_step(&mut self, verification: GoalVerification, at_ms: u64) {
        let fact = Fact::GoalVerificationRecorded {
            verification: verification.clone(),
            at_ms,
        };
        if let Err(reason) = self.commit(None, vec![fact]).await {
            tracing::warn!(%reason, "the goal verification step was not stored");
        }
        self.log.append(KernelEvent::GoalVerification {
            verification,
            at_ms,
        });
    }

    fn emit_goal(&self) {
        self.log.append(KernelEvent::GoalChanged {
            goal: self.goal_state(),
        });
    }

    /// The verification job ended (`None`: its task was lost, it fails open like a failed request).
    pub(crate) async fn finish_goal_verification(&mut self, outcome: Option<Outcome>) {
        let Some(pending) = self.goal_verify.take() else {
            self.start_next().await;
            return;
        };
        let now = self.deps.clock.now_ms();
        let outcome =
            outcome.unwrap_or_else(|| Outcome::Failed("the verification task ended".to_owned()));
        let (status, verdict) = match outcome {
            Outcome::Verdict(verdict) => (VerificationStatus::Completed, verdict),
            Outcome::Failed(message) => {
                tracing::warn!(error = %message, "goal completion verification failed open");
                (
                    VerificationStatus::FailedClosed,
                    fail_open(format!("Completion verifier request failed: {message}")),
                )
            }
            Outcome::Cancelled => (
                VerificationStatus::Cancelled,
                VerificationVerdict {
                    passed: false,
                    reason: "Completion verifier request was cancelled.".to_owned(),
                    next_action: None,
                },
            ),
        };
        let step = pending.step(status, Some(verdict.clone()));
        let item = step.item(now);
        self.verification_step(step, now).await;
        self.goal.verification_end(&pending.target, item);
        let cancelled = status == VerificationStatus::Cancelled;
        let goal_status = if cancelled {
            // Node pauses the goal when its verifier is cancelled.
            self.goal.control(true)
        } else {
            self.goal
                .verdict_status(&pending.target, verdict.passed, &verdict.reason, now)
        };
        // Committing the `goal_status` shows the goal (`goal_committed`); otherwise it is shown here.
        let unshown = self.goal_state();
        if let Some(goal_status) = goal_status {
            let message = self.status_message(&goal_status);
            if let Err(reason) = self.record(vec![message], Vec::new()).await {
                tracing::warn!(%reason, "the goal verdict was not stored");
            }
        }
        if self.goal_state() == unshown {
            self.emit_goal();
        }
        let next = verdict
            .next_action
            .as_deref()
            .filter(|_| !cancelled && !verdict.passed);
        if let Some(next) = next
            && self.verification_due().await
        {
            self.goal.continuation_started();
            if let Some(text) = self.goal.continuation(now, Some((&verdict.reason, next))) {
                match self
                    .start_turn(crate::turn::TurnInput::GoalContinuation { text })
                    .await
                {
                    Ok(()) => {
                        // The continuation cleared `notSatisfied`.
                        self.emit_goal();
                        return;
                    }
                    Err(error) => {
                        tracing::warn!(%error, "the goal continuation turn could not start");
                    }
                }
            }
        }
        self.start_next().await;
    }
}

#[cfg(test)]
#[path = "goal_verify_tests.rs"]
mod tests;
