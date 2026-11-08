//! `/goal`（docs/specs/rust-cli/goal.md）：会话 actor 是目标的唯一 owner。
//!
//! - 命令（§2）：人类输入开回合时先认出 `/goal …`，按本地命令写进对话的消息（不经 skill 展开）；
//! - 状态（§3）：提交 `goal_status` attachment 后才改目标（设定、清除、评估的判定都走这一条路），冷加载时
//!   从活动历史恢复；
//! - 判定（§4）：主循环报告评估结果，这里提交反馈与 `goal_status`。

use rust_cli_kernel_api::goal::{self, ActiveGoal, GoalPhase, GoalState, GoalStatus, GoalView};
use rust_cli_kernel_api::hooks::StopVerdict;
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message::{
    AttachmentMessage, ContentBlock, Message, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::store::StoreError;
use rust_cli_kernel_api::user_command::{self, LOCAL_COMMAND_SOURCE};
use rust_cli_prompts::texts::render;

use rust_cli_kernel_api::abort::AbortReason;
use rust_cli_kernel_api::session_api::{Ack, GOAL_ACTIVE_TURN, GOAL_PLAN_EXCLUSIVE};

use crate::actor::{Actor, accepted, rejected};
use crate::slash::Inputs;

/// 条件的长度上限（按 UTF-16 码元计）。
const MAX_CONDITION: usize = 4000;
/// 清除目标的参数（不分大小写）。
const CLEAR: [&str; 6] = ["clear", "stop", "off", "reset", "none", "cancel"];

/// 输入是 `/goal` 命令时给出参数（trim 后）。
pub(crate) fn command(text: &str) -> Option<&str> {
    let rest = text.trim().strip_prefix("/goal")?;
    (rest.is_empty() || rest.starts_with(char::is_whitespace)).then(|| rest.trim())
}

/// 只中和 `forked-skill-launch` 标签。
fn neutralize(text: &str) -> String {
    text.replace("<forked-skill-launch>", "&lt;forked-skill-launch>")
        .replace("</forked-skill-launch>", "&lt;/forked-skill-launch>")
}

fn turns(count: u32) -> String {
    format!("{count} {}", if count == 1 { "turn" } else { "turns" })
}

/// 目标的状态：当前目标与本会话主线程累计的输出 token（费用账的近似，goal.md D5）。
#[derive(Debug, Default)]
pub(crate) struct Goals {
    active: Option<Active>,
    output_tokens: u64,
    /// Fork (desktop App): the goal this session last finished (met or impossible), still shown
    /// in the App's goal panel until another goal is set or cleared.
    finished: Option<GoalState>,
}

#[derive(Debug, Clone)]
struct Active {
    condition: String,
    iterations: u32,
    set_at_ms: u64,
    tokens_at_start: u64,
    last_reason: Option<String>,
    /// Fork (desktop App): the `goal_status` attachment that set the goal (Node `targetId`).
    target: String,
    /// Fork (desktop App): paused by `Command::PauseGoal`; the stop-time evaluation skips it.
    paused: bool,
    /// Fork (desktop App): active time before the current active stretch, and its start.
    used_ms: u64,
    running_since: Option<u64>,
}

impl Active {
    fn new(condition: String, target: String, tokens_at_start: u64, now_ms: u64) -> Self {
        Self {
            condition,
            iterations: 0,
            set_at_ms: now_ms,
            tokens_at_start,
            last_reason: None,
            target,
            paused: false,
            used_ms: 0,
            running_since: Some(now_ms),
        }
    }

    /// Ends the current active stretch (pause or finish).
    fn settle(&mut self, now_ms: u64) {
        if let Some(since) = self.running_since.take() {
            self.used_ms += now_ms.saturating_sub(since);
        }
    }

    fn state(&self, status: GoalPhase) -> GoalState {
        GoalState {
            target: self.target.clone(),
            objective: self.condition.clone(),
            status,
            iteration: self.iterations,
            time_used_seconds: self.used_ms / 1000,
            active_run_started_at_ms: self.running_since,
        }
    }
}

fn status_of(message: &Message) -> Option<GoalStatus> {
    match message {
        Message::Attachment(attachment) if attachment.source == goal::STATUS_SOURCE => {
            serde_json::from_value(attachment.data.clone()).ok()
        }
        _ => None,
    }
}

impl Goals {
    /// 冷加载：最后一条 `goal_status` 既不是达成也不是失败时，它的条件重新生效，从 0 轮算起。
    pub(crate) fn restore(messages: &[Message], now_ms: u64) -> Self {
        let last = messages.iter().rev().find_map(status_of);
        let active = last
            .filter(|status| !status.met && !status.failed && !status.condition.is_empty())
            .map(|status| {
                // Fork: the target is the attachment that set this condition; a paused goal stays paused.
                let target = messages
                    .iter()
                    .rev()
                    .find(|message| {
                        status_of(message).is_some_and(|set| {
                            set.sentinel && !set.met && set.condition == status.condition
                        })
                    })
                    .map(|message| message.id().as_str().to_owned())
                    .unwrap_or_default();
                let mut active = Active::new(status.condition, target, 0, now_ms);
                if status.paused == Some(true) {
                    active.paused = true;
                    active.running_since = None;
                }
                active
            });
        Self {
            active,
            output_tokens: 0,
            finished: None,
        }
    }

    /// The condition the stop-time evaluation checks; a paused goal is not checked.
    pub(crate) fn condition(&self) -> Option<String> {
        self.active
            .as_ref()
            .filter(|active| !active.paused)
            .map(|active| active.condition.clone())
    }

    /// Fork (desktop App): the goal as the App shows it (Node snapshot `goal`).
    pub(crate) fn state(&self) -> Option<GoalState> {
        match &self.active {
            Some(active) if active.paused => Some(active.state(GoalPhase::Paused)),
            Some(active) => Some(active.state(GoalPhase::Active)),
            None => self.finished.clone(),
        }
    }

    /// Fork (desktop App): the pause (`true`) or resume (`false`) status to commit; None when the
    /// goal is not in the state the control changes.
    pub(crate) fn control(&self, pause: bool) -> Option<GoalStatus> {
        let active = self
            .active
            .as_ref()
            .filter(|active| active.paused != pause)?;
        Some(GoalStatus {
            sentinel: false,
            paused: Some(pause),
            ..sentinel(false, &active.condition)
        })
    }

    /// Fork (desktop App): the continuation prompt for the active goal.
    pub(crate) fn continuation(
        &self,
        now_ms: u64,
        verification: Option<(&str, &str)>,
    ) -> Option<String> {
        let active = self.active.as_ref()?;
        let running = active
            .running_since
            .map_or(0, |since| now_ms.saturating_sub(since));
        let budget = crate::goal_desktop::Budget {
            time_used_seconds: (active.used_ms + running) / 1000,
            tokens_used: self.output_tokens - active.tokens_at_start,
        };
        Some(crate::goal_desktop::continuation(
            &active.condition,
            &budget,
            verification,
        ))
    }

    /// 一条消息提交之后：`goal_status` 改目标，主线程的 assistant 累计输出 token。
    pub(crate) fn observe(&mut self, message: &Message, now_ms: u64) {
        if let Message::Assistant(assistant) = message {
            self.output_tokens += assistant.usage.map_or(0, |usage| usage.output_tokens);
            return;
        }
        let Some(status) = status_of(message) else {
            return;
        };
        if status.sentinel {
            self.finished = None;
            self.active = (!status.met).then(|| {
                Active::new(
                    status.condition,
                    message.id().as_str().to_owned(),
                    self.output_tokens,
                    now_ms,
                )
            });
            return;
        }
        let Some(active) = &mut self.active else {
            return;
        };
        if active.condition != status.condition {
            return;
        }
        if let Some(pause) = status.paused {
            if pause {
                active.settle(now_ms);
            } else if active.paused {
                active.running_since = Some(now_ms);
            }
            active.paused = pause;
        } else if status.met || status.failed {
            active.settle(now_ms);
            let phase = if status.met {
                GoalPhase::Verified
            } else {
                GoalPhase::Failed
            };
            self.finished = Some(active.state(phase));
            self.active = None;
        } else {
            active.iterations += 1;
            active.last_reason = status.reason;
        }
    }

    /// `/goal` 面板（最近一次达成、不是标记的 `goal_status`）。
    pub(crate) fn view(&self, messages: &[Message], now_ms: u64) -> GoalView {
        let achieved = messages
            .iter()
            .rev()
            .filter_map(status_of)
            .find(|status| status.met && !status.sentinel);
        GoalView {
            active: self.active.as_ref().map(|active| ActiveGoal {
                condition: active.condition.clone(),
                iterations: active.iterations,
                set_at_ms: active.set_at_ms.min(now_ms),
                tokens: self.output_tokens - active.tokens_at_start,
                last_reason: active.last_reason.clone(),
            }),
            achieved,
        }
    }

    /// 只读的文字（非交互命令的空参数）。
    fn describe(&self) -> String {
        let Some(active) = &self.active else {
            return "No goal set. Usage: `/goal <condition>`".to_owned();
        };
        let progress = if active.iterations == 0 {
            "not yet evaluated".to_owned()
        } else {
            turns(active.iterations)
        };
        let last = active
            .last_reason
            .as_deref()
            .map(|reason| {
                let first = reason.trim().split('\n').next().unwrap_or_default();
                format!("\nLast check: {first}")
            })
            .unwrap_or_default();
        format!("Goal active: {} ({progress}){last}", active.condition)
    }

    /// 判定要提交的 `goal_status`（goal.md §3）；条件不是当前目标、或判定不改目标时为 None。
    fn checked(&self, condition: &str, verdict: &StopVerdict, now_ms: u64) -> Option<GoalStatus> {
        let active = self.active.as_ref().filter(|a| a.condition == condition)?;
        let finished = |met: bool, failed: bool, reason: &Option<String>| GoalStatus {
            met,
            sentinel: false,
            failed,
            condition: condition.to_owned(),
            reason: reason.clone(),
            iterations: Some(active.iterations + 1),
            duration_ms: Some(now_ms.saturating_sub(active.set_at_ms)),
            tokens: Some(self.output_tokens - active.tokens_at_start),
            paused: None,
        };
        match verdict {
            StopVerdict::Met { reason } => Some(finished(true, false, reason)),
            StopVerdict::Impossible { reason } => Some(finished(false, true, reason)),
            StopVerdict::NotMet { reason, .. } => Some(GoalStatus {
                met: false,
                sentinel: false,
                failed: false,
                condition: condition.to_owned(),
                reason: reason.clone(),
                iterations: None,
                duration_ms: None,
                tokens: None,
                paused: None,
            }),
            StopVerdict::Failed { .. } | StopVerdict::TimedOut | StopVerdict::Cancelled => None,
        }
    }
}

fn sentinel(met: bool, condition: &str) -> GoalStatus {
    GoalStatus {
        met,
        sentinel: true,
        failed: false,
        condition: condition.to_owned(),
        reason: None,
        iterations: None,
        duration_ms: None,
        tokens: None,
        paused: None,
    }
}

impl Actor {
    fn status_message(&self, status: &GoalStatus) -> Message {
        Message::Attachment(AttachmentMessage {
            id: self.deps.ids.message(),
            source: goal::STATUS_SOURCE.to_owned(),
            text: String::new(),
            data: serde_json::to_value(status).unwrap_or_default(),
        })
    }

    fn meta(&self, source: &str, text: String) -> Message {
        Message::User(UserMessage {
            id: self.deps.ids.message(),
            content: vec![ContentBlock::Text { text }],
            origin: UserOrigin::Meta {
                source: source.to_owned(),
            },
        })
    }

    /// `/goal <args>` 写进对话的消息（goal.md §2.1）；第一条人类输入用回合预先生成的 `prompt` ID。
    pub(crate) fn goal_inputs(&self, args: &str, prompt: MessageId) -> Inputs {
        let input = Message::User(UserMessage {
            id: prompt,
            content: vec![ContentBlock::Text {
                text: user_command::command_input("goal", args),
            }],
            origin: UserOrigin::Human,
        });
        let stdout = |text: &str| {
            self.meta(
                LOCAL_COMMAND_SOURCE,
                format!(
                    "<local-command-stdout>{}</local-command-stdout>",
                    neutralize(text)
                ),
            )
        };
        let only = |text: String| Inputs {
            messages: vec![input.clone(), stdout(&text)],
            query: false,
            plain: false,
        };
        if args.is_empty() {
            return only(self.goal.describe());
        }
        if CLEAR.iter().any(|word| args.eq_ignore_ascii_case(word)) {
            return match self.goal.condition() {
                Some(condition) => Inputs {
                    messages: vec![
                        self.status_message(&sentinel(true, &condition)),
                        input.clone(),
                        stdout(&format!("Goal cleared: {condition}")),
                    ],
                    query: false,
                    plain: false,
                },
                None => only("No goal set".to_owned()),
            };
        }
        let length = args.encode_utf16().count();
        if length > MAX_CONDITION {
            return only(format!(
                "Goal condition is limited to {MAX_CONDITION} characters (got {length})"
            ));
        }
        if self.deps.desktop_goals {
            // Fork (desktop App): Node starts a continuation turn right away; the model reads
            // Node's continuation prompt (the goal is new: no time or tokens used yet).
            let budget = crate::goal_desktop::Budget {
                time_used_seconds: 0,
                tokens_used: 0,
            };
            return Inputs {
                messages: vec![
                    self.status_message(&sentinel(false, args)),
                    input,
                    self.meta(
                        goal::CONTINUATION_SOURCE,
                        crate::goal_desktop::continuation(args, &budget, None),
                    ),
                ],
                query: true,
                plain: false,
            };
        }
        Inputs {
            messages: vec![
                self.status_message(&sentinel(false, args)),
                input,
                stdout(&format!("Goal set: {args}")),
                self.meta(
                    goal::PROMPT_SOURCE,
                    render(rust_cli_prompts::goal::set_prompt(), &[("condition", args)]),
                ),
            ],
            query: true,
            plain: false,
        }
    }

    /// 提交后改目标（提交后的观察者之一，append.rs）。
    pub(crate) fn goal_committed(&mut self, message: &Message) {
        let now = self.deps.clock.now_ms();
        if !self.deps.desktop_goals {
            self.goal.observe(message, now);
            return;
        }
        let before = self.goal.state();
        self.goal.observe(message, now);
        let after = self.goal.state();
        if after != before {
            self.log
                .append(rust_cli_kernel_api::session_api::KernelEvent::GoalChanged { goal: after });
        }
    }

    /// Fork (desktop App): the goal state for the session view (Node snapshot `goal`).
    pub(crate) fn goal_state(&self) -> Option<GoalState> {
        self.deps.desktop_goals.then(|| self.goal.state()).flatten()
    }

    /// Fork (desktop App): Node `pauseGoal`: the active goal becomes paused, then the running turn
    /// is aborted (not the stop's queue hold). No active goal: a no-op.
    pub(crate) async fn pause_goal(&mut self) -> Ack {
        let Some(status) = self.goal.control(true) else {
            return accepted();
        };
        if let Err(error) = self
            .record(vec![self.status_message(&status)], Vec::new())
            .await
        {
            return rejected(error);
        }
        if let Some(running) = &self.running {
            running.abort.abort(AbortReason::User);
            self.cancel_turn_asks();
        }
        accepted()
    }

    /// Fork (desktop App): Node `resumeGoal`: refused while a turn runs or with plan on; a paused
    /// goal becomes active and a continuation turn starts. No paused goal: a no-op.
    pub(crate) async fn resume_goal(&mut self) -> Ack {
        if self.busy() {
            return rejected(GOAL_ACTIVE_TURN);
        }
        if self.execution.plan && self.goal.state().is_some() {
            return rejected(GOAL_PLAN_EXCLUSIVE);
        }
        let Some(status) = self.goal.control(false) else {
            return accepted();
        };
        if let Err(error) = self
            .record(vec![self.status_message(&status)], Vec::new())
            .await
        {
            return rejected(error);
        }
        let now = self.deps.clock.now_ms();
        let Some(text) = self.goal.continuation(now, None) else {
            return accepted();
        };
        match self
            .start_turn(crate::turn::TurnInput::GoalContinuation { text })
            .await
        {
            Ok(()) => accepted(),
            Err(error) => rejected(error),
        }
    }

    /// 主循环报告的判定（`RunSink::goal_checked`）：提交反馈与 `goal_status`，返回已提交的消息。
    pub(crate) async fn goal_checked(
        &mut self,
        condition: String,
        verdict: StopVerdict,
    ) -> Result<Vec<Message>, StoreError> {
        let now = self.deps.clock.now_ms();
        let Some(status) = self.goal.checked(&condition, &verdict, now) else {
            return Ok(Vec::new());
        };
        let mut messages = Vec::new();
        if let StopVerdict::NotMet { feedback, reason } = verdict {
            // Fork (desktop App): the model reads Node's continuation prompt with the evaluation's
            // reason as the next action, not this kernel's stop-hook feedback.
            let desktop = self.deps.desktop_goals.then(|| {
                let reason = reason.as_deref().unwrap_or_default();
                self.goal.continuation(now, Some((reason, reason)))
            });
            match desktop.flatten() {
                Some(text) => messages.push(self.meta(goal::CONTINUATION_SOURCE, text)),
                None => messages.push(feedback),
            }
        }
        messages.push(self.status_message(&status));
        self.record(messages.clone(), Vec::new()).await?;
        Ok(messages)
    }

    pub(crate) fn goal_view(&self) -> GoalView {
        self.goal.view(&self.messages, self.deps.clock.now_ms())
    }
}

#[cfg(test)]
#[path = "goal_tests.rs"]
mod tests;
