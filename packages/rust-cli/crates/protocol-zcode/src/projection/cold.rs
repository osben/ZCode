//! 冷投影：从会话视图（已提交的消息）重建行。没有事件的时间，行的时间取会话的创建时间；回合以真人输入为界。

use rust_cli_kernel_api::message::{ContentBlock, Message, SystemMessage, UserOrigin};
use rust_cli_kernel_api::session_api::{SequencedEvent, SessionView};
use rust_cli_kernel_api::user_input::INTERRUPT_TEXTS;

use super::{Projection, state::Phase, tool_key};

/// 从视图的消息建行；阶段按最后一个回合与 `running` 定。
pub(super) fn rows(projection: &mut Projection, view: &SessionView) {
    let at = view.meta.created_at_ms;
    let mut out = Vec::new();
    let mut turns = 0u64;
    let mut interrupted = false;
    // Fork: the last assistant message ended its turn (no tool call waits for a result), so a
    // notification after it opened a turn of its own instead of joining a tool boundary.
    let mut turn_ended = true;
    // Fork: the current turn was opened by notifications and no assistant message followed yet, so
    // the next notification is part of the same batch (each notification is its own message).
    let mut notice_batch = false;
    // Fork: a typed input opens a turn; the stored model of a turn's first reply draws Node's switch divider.
    let opens_turn = |message: &Message| {
        matches!(message, Message::User(user) if user.origin == UserOrigin::Human
            && !INTERRUPT_TEXTS.contains(&super::text_of(&user.content).as_str()))
    };
    for (index, message) in view.messages.iter().enumerate() {
        match message {
            Message::User(user)
                if user.origin == UserOrigin::Human
                    && !INTERRUPT_TEXTS.contains(&super::text_of(&user.content).as_str()) =>
            {
                if projection.turn.is_some() {
                    projection.close_cold_turn(interrupted, at, &mut out);
                }
                interrupted = false;
                notice_batch = false;
                turns += 1;
                turn_ended = false;
                let turn = format!("{}:turn:{turns}", user.id.as_str());
                // Fork: the stored submitting command, so the App settles its pending command after a restart.
                let command = view.commands.get(&user.id).map(|c| c.as_str().to_owned());
                let model = super::model_change::cold_turn_model(view, index, opens_turn);
                projection.start_turn(&turn, command, model, at, 0, &mut out);
                projection.message(message, at, 0, &mut out);
            }
            Message::User(user)
                if turn_ended && super::rows::is_task_notification(&user.origin) =>
            {
                if projection.turn.is_some() {
                    projection.close_cold_turn(interrupted, at, &mut out);
                }
                interrupted = false;
                turns += 1;
                turn_ended = false;
                let turn = format!("{}:turn:{turns}", user.id.as_str());
                let model = super::model_change::cold_turn_model(view, index, opens_turn);
                projection.start_turn(&turn, None, model, at, 0, &mut out);
                projection.message(message, at, 0, &mut out);
                notice_batch = true;
            }
            Message::User(user)
                if notice_batch && super::rows::is_task_notification(&user.origin) =>
            {
                projection.message(message, at, 0, &mut out);
            }
            Message::User(user) => {
                if INTERRUPT_TEXTS.contains(&super::text_of(&user.content).as_str()) {
                    interrupted = true;
                }
                // Fork: a notification merged into this turn still settles the calls it names (background_result.rs).
                if super::rows::is_task_notification(&user.origin) {
                    let text = super::text_of(&user.content);
                    projection.remember_notified(&text);
                    projection.settle_notified_tools(&text, at, &mut out);
                }
                // 工具结果：给对应的工具行结果。
                for block in &user.content {
                    if let ContentBlock::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } = block
                    {
                        let output = rust_cli_kernel_api::tool::ToolOutput {
                            content: content.clone(),
                            is_error: *is_error,
                            display: serde_json::Value::Null,
                        };
                        let event = SequencedEvent {
                            seq: 0,
                            event: rust_cli_kernel_api::session_api::KernelEvent::ToolDone {
                                tool_use: tool_use_id.clone(),
                                output,
                            },
                            revision: projection.revision,
                        };
                        if projection
                            .index
                            .contains_key(&tool_key(tool_use_id.as_str()))
                        {
                            projection.apply(&event, at);
                        }
                    }
                }
            }
            Message::Assistant(assistant) => {
                notice_batch = false;
                turn_ended = !assistant
                    .content
                    .iter()
                    .any(|block| matches!(block, ContentBlock::ToolUse { .. }));
                projection.message(message, at, 0, &mut out);
                // Fork: the stored goal verifications that followed this message (projection/goal_verify.rs).
                if let Some(goal) = &view.goal {
                    for item in goal.verifications.iter().filter(|item| {
                        item.anchor_message.as_deref() == Some(assistant.id.as_str())
                    }) {
                        projection.verified(&goal.target, item, &mut out);
                    }
                }
            }
            Message::System(SystemMessage::Interrupted { .. }) => interrupted = true,
            // Fork: a stored compaction shows as its timeline marker (projection/markers.rs).
            Message::System(SystemMessage::CompactBoundary(boundary)) => {
                projection.compacted(boundary.trigger, boundary.pre_tokens, at, &mut out);
            }
            // 附件不投成行（P1）; fork: an absorbed steer is a guided user row of the current turn (rows.rs).
            Message::Attachment(_) => projection.message(message, at, 0, &mut out),
        }
    }
    projection.seed_turn_model(turns);
    // Fork: a verification whose anchor message is not in the active history shows at the end.
    if let Some(goal) = &view.goal {
        for item in &goal.verifications {
            let key = format!("goal_verify:{}_{}", goal.target, item.iteration);
            if !projection.index.contains_key(&key) {
                projection.verified(&goal.target, item, &mut out);
            }
        }
    }
    if projection.turn.is_some() {
        if view.running {
            projection.phase = Phase::Running;
        } else {
            projection.close_cold_turn(interrupted, at, &mut out);
        }
    }
}

impl Projection {
    fn close_cold_turn(&mut self, interrupted: bool, at: u64, out: &mut Vec<serde_json::Value>) {
        let Some(turn) = self.turn.as_ref().map(|turn| turn.id.clone()) else {
            return;
        };
        let outcome = if interrupted {
            rust_cli_kernel_api::session_api::TurnOutcome::Interrupted
        } else {
            rust_cli_kernel_api::session_api::TurnOutcome::Success
        };
        self.finish_turn(&turn, &outcome, None, at, out);
    }
}
