//! 回合内的逻辑：开始回合、处理主循环的提交请求、待回答的交互、回合收尾。
//!
//! 每条消息先提交到存储，成功后才进入内存历史并发出事件；提交失败时中止本回合并以失败收尾。

use rust_cli_kernel_api::abort::AbortReason;
use rust_cli_kernel_api::hooks::HookOutcome;
use rust_cli_kernel_api::ids::{CommandId, InteractionId};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::metering::{CallStatus, Metered, ModelCall, OutputSpeed};
use rust_cli_kernel_api::model::QuerySource;
use rust_cli_kernel_api::orchestration::{
    Answer, InteractionAnswer, InteractionRequest, OrchestrationError, QueryEvent, QueryStop,
    RunView,
};
use rust_cli_kernel_api::session_api::{Ack, KernelEvent, TurnOutcome};
use rust_cli_kernel_api::store::{Fact, StoreError};
use tokio::sync::oneshot;

use crate::actor::{Actor, Pending, accepted, rejected};
use crate::lane::Waiting;
use crate::sink::SinkRequest;

/// 工具请求的改动没能落库：原因是存储的原文。
fn failed(error: StoreError) -> OrchestrationError {
    OrchestrationError::Failed {
        message: error.to_string(),
    }
}

/// footer 的 TPS（修复线 F105，docs/specs/rust-cli/tui-display.md §2.6）：只有完成的主回合请求才有；子代理、旁路与压缩
/// 请求、中断与失败的请求不更新。时刻都相对请求开始。
pub(crate) fn output_speed(call: &ModelCall) -> Option<OutputSpeed> {
    // 写法与子代理共用（kernel-api `OutputSpeed::of`，F112），这里只筛主回合。
    (call.source == QuerySource::MainThread)
        .then(|| OutputSpeed::of(call))
        .flatten()
}

/// 成批进同一个回合的一条后续输入（修复线 L-A，query.md §4.3）。
#[derive(Debug)]
pub(crate) struct MorePrompt {
    pub(crate) text: String,
    /// Fork: the App input's intent; its quotes join `text` when the input is committed.
    pub(crate) intent: Option<Box<rust_cli_kernel_api::input_intent::InputIntent>>,
    /// 在工具边界已跑过的 UserPromptSubmit 结果。
    pub(crate) screened: Option<Box<HookOutcome>>,
}

/// 开启一个回合的输入。
pub(crate) enum TurnInput {
    Human {
        command: CommandId,
        text: String,
        /// 插话在并入点已跑过的 UserPromptSubmit 结果（query.md §4.1）；有值时不再跑 hook。
        screened: Option<Box<HookOutcome>>,
        /// 与它成批进这个回合的后续排队输入（修复线 L-A，query.md §4.3），按队列顺序。
        more: Vec<MorePrompt>,
        /// Fork: the App input's intent (`text` is the typed text).
        intent: Option<Box<rust_cli_kernel_api::input_intent::InputIntent>>,
    },
    /// 回合结束后还没并入的后台通知（命令与子代理，到达顺序）：连续的几条合成一个回合，每条一条
    /// meta user 消息、只调一次模型（docs/specs/rust-cli/query.md §5，通知合并）。
    Notices(Vec<Waiting>),
    /// 到期的定时任务：prompt 原文作为 meta user 消息（docs/specs/rust-cli/tools-more.md §10.4）。
    Cron(rust_cli_kernel_api::cron::CronFire),
    /// 排队的 bash 模式命令（tui-input.md §2.2）。
    Bash { command: CommandId, line: String },
    /// 带内容块的人类输入（粘贴的图片，tui-input.md §3.2）。
    Content {
        command: CommandId,
        content: Vec<ContentBlock>,
        /// Fork: the App input's intent (the text block is the typed text).
        intent: Option<Box<rust_cli_kernel_api::input_intent::InputIntent>>,
    },
    /// Fork: a queued manual compaction (`Command::SubmitWith` with `QueuedKind::Compact`).
    Compact { command: CommandId },
    /// Fork (desktop App): a resumed goal's continuation (Node `goal-continuation`, model-only):
    /// `text` is the wrapped continuation prompt, a meta user message.
    GoalContinuation { text: String },
}

impl Actor {
    pub(crate) async fn start_turn(&mut self, input: TurnInput) -> Result<(), StoreError> {
        self.start_turn_with(input, Default::default()).await
    }

    /// Fork: [`Self::start_turn`] with the limits of the input that opens the turn (automation id, hidden tools,
    /// specs/fork-rust-automations.md). Only a human input's turn takes them; Bash, a compaction, a goal continuation, a
    /// cron fire and notices run without, so no other turn can inherit an input's limits.
    pub(crate) async fn start_turn_with(
        &mut self,
        input: TurnInput,
        limits: rust_cli_kernel_api::turn_limits::TurnLimits,
    ) -> Result<(), StoreError> {
        // The held SessionStart result is written first: Node's `session_persistence` phase runs before the
        // turn's `TurnStarted`, the UserPromptSubmit hook and the input. Bash and compaction are not turns in Node
        // (`turn.ts` returns before that phase for `/compact`), so they do not write it.
        if !matches!(input, TurnInput::Bash { .. } | TurnInput::Compact { .. }) {
            self.commit_pending_session_start().await?;
        }
        let meta = |source: &str| UserOrigin::Meta {
            source: source.to_owned(),
        };
        // 定时任务触发：界面行与 `/loop` 的折叠说明（排在 prompt 之前，tools-more.md §18.3）。
        let mut fired = None;
        let (texts, notices) = match input {
            // 人类输入先跑 UserPromptSubmit（hooks.rs），输入在回合任务里提交。
            TurnInput::Human {
                command,
                text,
                screened,
                more,
                intent,
            } => {
                let content = if text.is_empty() && intent.is_some() {
                    // Quotes alone are an input (Node `session-flow.ts`); the block becomes its text.
                    Vec::new()
                } else {
                    vec![ContentBlock::Text { text }]
                };
                self.start_human_turn(command, content, (screened, more), intent, limits);
                return Ok(());
            }
            TurnInput::Content {
                command,
                content,
                intent,
            } => {
                self.start_human_turn(command, content, (None, Vec::new()), intent, limits);
                return Ok(());
            }
            TurnInput::Bash { command, line } => {
                self.start_bash_turn(command, line);
                return Ok(());
            }
            TurnInput::Compact { command } => {
                if let Err(reason) = self.start_compaction(command, None) {
                    tracing::warn!(%reason, "queued compaction could not start");
                }
                return Ok(());
            }
            TurnInput::GoalContinuation { text } => (
                vec![(text, meta(rust_cli_kernel_api::goal::CONTINUATION_SOURCE))],
                Vec::new(),
            ),
            TurnInput::Cron(fire) => {
                fired = Some(self.fire_prelude(fire.kind));
                // `/loop` 的哨兵在这里展开（tools-more.md §17.3）。
                let prompt = self.resolve_loop_prompt(fire.prompt).await;
                (vec![(prompt, meta(crate::cron::CRON_SOURCE))], Vec::new())
            }
            TurnInput::Notices(mut notices) => {
                // Node `orderTaskNotificationsForParsing`: the batch's terminal notices come first.
                crate::lane::order_for_parsing(&mut notices);
                // 同伴消息开回合时用空闲的写法与自己的来源（cross-session.md §1.7）。
                let texts = notices
                    .iter()
                    .map(|notice| (notice.turn_text(), meta(notice.source())))
                    .collect();
                (texts, notices)
            }
        };
        // Fork: the Node desktop agent stores a batch of task notifications as one user message with a
        // text block per notification (`persistBackgroundTaskNotificationBatch`); the model request is
        // the same either way. Mixed sources (a peer message among them) keep a message each.
        // The run of each stall reminder, index-aligned with the notices (None for every other notice).
        let stalls: Vec<Option<String>> = notices
            .iter()
            .map(|notice| match notice {
                Waiting::Stall(stall) => {
                    (!stall.execution_id.is_empty()).then(|| stall.execution_id.clone())
                }
                _ => None,
            })
            .collect();
        let blocks: Vec<(Vec<ContentBlock>, UserOrigin, Option<String>)> = if self.deps.one_input_per_turn
            && texts.len() > 1
            && texts.iter().all(|(_, origin)| {
                matches!(origin, UserOrigin::Meta { source } if source == crate::notices::NOTICE_SOURCE)
            }) {
            let origin = texts[0].1.clone();
            let content = texts
                .into_iter()
                .map(|(text, _)| ContentBlock::Text { text })
                .collect();
            // One block for the whole batch: its execution only when the batch is exactly one stall reminder.
            let execution = if stalls.len() == 1 { stalls[0].clone() } else { None };
            vec![(content, origin, execution)]
        } else {
            texts
                .into_iter()
                .enumerate()
                .map(|(index, (text, origin))| {
                    (
                        vec![ContentBlock::Text { text }],
                        origin,
                        stalls.get(index).cloned().flatten(),
                    )
                })
                .collect()
        };
        let before = fired
            .as_ref()
            .map(|fired| fired.before.clone())
            .unwrap_or_default();
        let users: Vec<Message> = before
            .into_iter()
            .chain(
                blocks
                    .into_iter()
                    .map(|(content, origin, stall_execution)| {
                        Message::User(UserMessage {
                            stall_execution,
                            intent: None,
                            id: self.deps.ids.message(),
                            content,
                            origin,
                        })
                    }),
            )
            .collect();
        // 一个事务：几条通知一起成立；折叠说明与定时任务的 prompt 一起成立；同伴项“已并入”的事实与它们的 user 消息
        // 一起成立（cross-session.md §2.4，F139）。checkpoint 挂在这次运行最后一条 user 消息上（drive 的同一规则）。
        let prompt = users.last().map(|message| message.id().clone());
        let merged = notices.iter().flat_map(Waiting::merged_facts).collect();
        let appended = self.append(None, users, merged).await?;
        if let (Some(fired), Some(prompt)) = (fired, &prompt) {
            self.fired(fired, prompt.clone());
        }
        // 通知已经在对话里：现在才 ack（至少一次）。
        for notice in &notices {
            self.ack_notice(notice).await;
        }
        let turn = self.deps.ids.turn();
        // 先开始回合，再发这些消息（与人类输入的回合同一个顺序）。
        self.log.append(KernelEvent::TurnStarted {
            turn: turn.clone(),
            command: None,
        });
        self.after_commit(appended).await;
        let (opening, request) = self.open_main_turn(turn);
        let runner = self.deps.runner.clone();
        let sink = opening.sink.clone();
        let signal = opening.abort.clone();
        let task = self.deps.spawner.spawn("query-run", async move {
            runner.run(request, sink, signal).await
        });
        self.launch(opening, task, prompt, None, Default::default());
        Ok(())
    }

    pub(crate) async fn on_sink(&mut self, request: SinkRequest) {
        match request {
            SinkRequest::Message { message, reply } => {
                let _ = reply.send(self.record(vec![message], Vec::new()).await);
            }
            SinkRequest::Event(event) => self.forward(event),
            SinkRequest::ArmMonitor {
                monitor,
                events,
                reply,
            } => {
                let _ = reply.send(self.arm_monitor(monitor, events));
            }
            SinkRequest::Ask { request, reply } => {
                self.ask(request, reply, crate::actor::AskScope::Turn);
            }
            SinkRequest::CancelAsk { tool_use } => self.cancel_ask(&tool_use),
            SinkRequest::ClaimSteering {
                prompts_only,
                reply,
            } => {
                self.prune_stalls().await;
                let _ = reply.send(self.claim_steering(prompts_only));
            }
            SinkRequest::SettleSteering {
                fates,
                notices,
                reply,
            } => {
                let settled = self.settle_steering(fates, notices).await;
                let _ = reply.send(settled);
            }
            SinkRequest::Metered {
                message,
                metered,
                reply,
            } => {
                self.note_request(&metered);
                let speed = match metered.as_ref() {
                    Metered::Model(call) => output_speed(call),
                    Metered::Tool(_) => None,
                };
                // 没有消息的计量（没有内容的失败请求、丢弃的响应）单独一批。
                let messages = message.into_iter().collect();
                let result = self.record(messages, vec![Fact::from(*metered)]).await;
                // 先落库，再记下并发出（只在内存，F105）。
                if let (Ok(()), Some(speed)) = (&result, speed) {
                    self.output_speed = Some(speed);
                    self.log.append(KernelEvent::OutputSpeed { speed });
                }
                let _ = reply.send(result);
            }
            SinkRequest::Messages { messages, reply } => {
                let _ = reply.send(self.record(messages, Vec::new()).await);
            }
            SinkRequest::Compaction {
                messages,
                session_start_context,
                reply,
            } => {
                // A compaction whose SessionStart run gave a context replaces the held result, once the batch has
                // committed (Node `discardPendingSessionStartContext` after `compactSessionStart.hasContext`).
                let result = self.record(messages, Vec::new()).await;
                if session_start_context && result.is_ok() {
                    self.pending_session_start.clear();
                }
                let _ = reply.send(result);
            }
            SinkRequest::CompactStarted(trigger) => crate::compact::compact_started(self, trigger),
            SinkRequest::CompactFailed(trigger, message) => {
                self.log
                    .append(KernelEvent::CompactFailed { trigger, message });
            }
            SinkRequest::CompactSkipped(trigger) => {
                self.log.append(KernelEvent::CompactSkipped { trigger });
            }
            SinkRequest::SetPlan {
                enabled,
                tool_call,
                reply,
            } => {
                let changed = self.change_plan(enabled, tool_call).await;
                let _ = reply.send(changed.map_err(failed));
            }
            SinkRequest::View { reply } => {
                let _ = reply.send(self.run_view());
            }
            SinkRequest::Title(title) => self.retitle(title).await,
            SinkRequest::SetWorkspace { root, reply } => {
                let _ = reply.send(self.change_workspace(root).await);
            }
            SinkRequest::Conversation { reply } => {
                let _ = reply.send(self.messages.clone());
            }
            SinkRequest::GoalChecked {
                condition,
                verdict,
                reply,
            } => {
                let _ = reply.send(self.goal_checked(condition, verdict).await);
            }
        }
    }

    /// 会话现在的状态（[`SinkRequest::View`]）：判决用的模式（plan 开时是 plan）、计划模式的会话标志、工作目录、主模型与
    /// 目标，同一时刻的值。
    pub(crate) fn run_view(&self) -> RunView {
        RunView {
            base_mode: self.execution.mode,
            plan_flags: self.plan_flags,
            selection: Some(self.selection.clone()),
            // Fork (desktop App): the desktop goal is verified after the turn (goal_verify.rs), not by the stop hook.
            goal: self.goal.condition().filter(|_| !self.deps.desktop_goals),
            execution_worktree: self.execution_worktree,
            turn: self
                .running
                .as_ref()
                .map(|running| running.limits.clone())
                .unwrap_or_default(),
            ..RunView::new(self.mode(), self.meta.workspace.clone())
        }
    }

    fn failure(&self) -> Option<StoreError> {
        self.running
            .as_ref()
            .and_then(|running| running.failure.clone())
    }

    /// 提交失败：记下原因并中止本回合，之后的提交一律拒绝。主循环拿到的是存储原样的错误。
    ///
    /// 工作线 F77：记一条 warn。以前原因只进回合的结局（界面上的 `storage error: …`），日志里没有一行。
    fn fail(&mut self, error: StoreError) -> StoreError {
        if let Some(running) = &mut self.running {
            running.abort.abort(AbortReason::User);
            running.failure.get_or_insert_with(|| error.clone());
        }
        tracing::warn!(event = "session.write.failed", session = %self.meta.id, reason = %error, "a turn write could not be stored; the turn stops");
        error
    }

    /// 主循环交来的消息（一条、一组或没有）与计量：一个事务（[`Self::append`]），成功后进历史（[`Self::after_commit`]）；
    /// 失败时中止本回合（[`Self::fail`]），之后的提交一律拒绝。批次带上本回合开头那条输入的命令（`command_of`）。
    ///
    /// 工作线 F130：以前一条消息、一组消息（压缩的结果、目标的判定）与只有计量各走一条路径，一组消息那条内联了失败处理、
    /// 少了 warn 日志。
    pub(crate) async fn record(
        &mut self,
        messages: Vec<Message>,
        usage: Vec<Fact>,
    ) -> Result<(), StoreError> {
        if let Some(error) = self.failure() {
            return Err(error);
        }
        let command = messages
            .iter()
            .find_map(|message| self.command_of(message.id()));
        match self.append(command, messages, usage).await {
            Ok(appended) => {
                self.after_commit(appended).await;
                Ok(())
            }
            Err(error) => Err(self.fail(error)),
        }
    }

    fn forward(&mut self, event: QueryEvent) {
        let Some(turn) = self.running.as_ref().map(|running| running.turn.clone()) else {
            return;
        };
        if let QueryEvent::ToolFinished { tool_use, output } = &event {
            self.ledger.tool_finished(tool_use, output);
        }
        self.log.append(kernel_event(turn, event));
    }

    pub(crate) async fn finish_turn(&mut self) {
        let Some(running) = self.running.take() else {
            return;
        };
        self.cancel_turn_asks();
        let result = running.task.await;
        let outcome = match (running.failure, result) {
            (Some(error), _) => TurnOutcome::Failed {
                message: error.to_string(),
                code: None,
            },
            (None, Ok(Ok(QueryStop::Completed))) => TurnOutcome::Success,
            (None, Ok(Ok(QueryStop::Aborted))) => TurnOutcome::Interrupted,
            (None, Ok(Ok(QueryStop::HookStopped))) => TurnOutcome::HookStopped,
            (None, Ok(Ok(QueryStop::StopHookPrevented))) => TurnOutcome::StopHookPrevented,
            (None, Ok(Ok(QueryStop::MaxTurns))) => TurnOutcome::Failed {
                message: "reached the maximum number of turns".to_owned(),
                code: None,
            },
            (None, Ok(Ok(QueryStop::Blocked { message } | QueryStop::ApiError { message }))) => {
                TurnOutcome::Failed {
                    message,
                    code: None,
                }
            }
            (None, Ok(Err(error))) => TurnOutcome::Failed {
                message: error.to_string(),
                code: error.code().map(str::to_owned),
            },
            (None, Err(error)) => TurnOutcome::Failed {
                message: error.to_string(),
                code: None,
            },
        };
        // Node `turn_usage`（usage.md §2.4）：只在这次运行的输入已经落库时写；压缩运行没有输入。用量行是观测，
        // 写不进去只记日志，不改回合的结果。
        let prompted = running
            .prompt
            .as_ref()
            .is_some_and(|prompt| self.messages.iter().rev().any(|m| m.id() == prompt));
        if prompted {
            let status = match &outcome {
                TurnOutcome::Success
                | TurnOutcome::HookStopped
                | TurnOutcome::StopHookPrevented => CallStatus::Completed,
                TurnOutcome::Interrupted => CallStatus::Cancelled,
                TurnOutcome::Failed { .. } => CallStatus::Error,
            };
            if let Err(reason) = self.commit(None, vec![Fact::TurnEnded { status }]).await {
                tracing::warn!(%reason, "the turn usage could not be stored");
            }
        }
        let usage = self
            .messages
            .iter()
            .rev()
            .find_map(|message| match message {
                Message::Assistant(assistant) => assistant.usage,
                _ => None,
            });
        // 回合结束那一行（修复线 F118，tui-display.md §2.7）：排在 TurnFinished 之后、下一个回合之前。
        let interrupted = matches!(outcome, TurnOutcome::Interrupted);
        let completed = matches!(
            outcome,
            TurnOutcome::Success | TurnOutcome::HookStopped | TurnOutcome::StopHookPrevented
        );
        let failed = matches!(outcome, TurnOutcome::Failed { .. });
        // A compaction turn has no run (`start_compaction`); only main-loop turns pause the queue.
        let main_loop = running.run.is_some();
        let turn = running.turn.clone();
        let anchor_turn = running.turn.clone();
        self.log.append(KernelEvent::TurnFinished {
            turn: running.turn,
            outcome,
            usage,
        });
        self.turn_duration(turn, running.timing, interrupted).await;
        self.goal_touched = true;
        self.after_turn(completed);
        if interrupted {
            self.pause_goal_after_cancel().await;
        }
        // Fork: Node core pauses the queue on a turn error (`queueAutoDrain = false`), so the waiting inputs stay
        // queued until the user continues (`setAutoDrain`); the projection shows `pauseReason: "error"`.
        if failed
            && main_loop
            && self.deps.error_holds_queue
            && self.inbox.has_inputs()
            && self.inbox.set_held(true)
        {
            self.emit_queue();
        }
        // The `/goal X` control turn: its continuation is the first, unverified one (Node `verifyBeforeFirstContinue`).
        let control = self.goal.continue_after_set;
        if self.continue_goal_after_set(completed).await {
            return;
        }
        if !control && completed && self.verify_goal_after_turn(anchor_turn).await {
            return;
        }
        self.start_next().await;
    }

    /// 空闲时开下一个回合：先 next 通道（插话与后台通知，到达顺序），再 `Queue` 输入（优先级 `later`），
    /// 最后是到期的定时任务（lane.rs）。
    pub(crate) async fn start_next(&mut self) {
        // 关闭中（R1-1）：排队的输入、通知与定时任务都不再开回合；通知没有 ack，会话再打开时送达。进程要退出
        // （`Shutdown`，修复线 F38）时同样。
        if self.closing.is_some() || self.shutting_down {
            return;
        }
        // Fork: a promoted input holds the foreground (`Command::ReserveForeground`); it starts its own turn.
        if self.inbox.reserved() {
            return;
        }
        // 这次工作期间到达的本地命令记录先进对话，再开下一个回合（修复线 L-A，tui-manage.md §11.3）。
        self.flush_held_records().await;
        self.prune_stalls().await;
        let (input, execution) = if let Some(next) = self.next_turn_input() {
            next
        } else if let Some(fire) = self.next_cron().await {
            (TurnInput::Cron(fire), None)
        } else {
            return;
        };
        // Fork: the item's turn limits (automation id, hidden tools) belong to the turn it opens.
        let limits = execution
            .as_ref()
            .map(|execution| execution.limits.clone())
            .unwrap_or_default();
        // Fork: the item's frozen state becomes the session's through the same facts as `SetModel` /
        // `SetMode` / `SetPlan`, so a cold open sees what the turn ran with.
        if let Some(execution) = execution
            // Boxed: the mode change's peer release is an async path back into `start_next` (not taken
            // here, `submitted_execution` does not start peers, but the future type is recursive).
            && let Err(reason) = Box::pin(self.submitted_execution(execution)).await
        {
            tracing::warn!(%reason, "queued input's execution state could not be applied");
        }
        // 提交失败时只记日志：排队输入已出队，前端从 QueueChanged 看到它消失；通知没有 ack，
        // 会再次送达。
        let started = self.start_turn_with(input, limits).await;
        if let Err(reason) = started {
            tracing::warn!(%reason, "queued input could not start a turn");
        }
    }
}

#[path = "turn_interact.rs"]
mod interact;

/// The log event of a query event in `turn` (the actor's own run and a mirrored child run, crate::child_live).
pub(crate) fn kernel_event(
    turn: rust_cli_kernel_api::ids::TurnId,
    event: QueryEvent,
) -> KernelEvent {
    event.into_kernel_event(turn)
}

#[cfg(test)]
#[path = "write_failure_tests.rs"]
mod write_failure_tests;

#[cfg(test)]
#[path = "error_hold_tests.rs"]
mod error_hold_tests;
