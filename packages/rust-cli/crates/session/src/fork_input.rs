//! `/fork`（docs/specs/rust-cli/session-lifecycle.md §6.5，工作线 F75）：从一条可选的用户输入分出新会话。
//!
//! 可选的输入与 `/rewind` 相同（`rewind_plan::selectable`）。新会话带到这一轮为止：复制到这一轮最后一条 assistant，
//! 由存储一次写完（`SessionStore::fork`）；文件不动。

use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::session_api::{Ack, CommandResult, Forked};
use rust_cli_kernel_api::store::SessionFork;

use crate::actor::{Actor, rejected};
use crate::rewind_plan::selectable;

/// 复制到哪一条（§6.5.1）：`input` 这一轮（到下一条可选的输入之前）里最后一条 assistant；这一轮没有 assistant
/// 时是 `input` 本身。`input` 不是可选的输入时为 None。
///
/// 续写时补的 `No response requested.`（§6.3.1）不算：它是占位，不是这一轮的回答；还没落库时拿它当复制的终点，
/// 存储找不到这条消息、分叉失败。
pub(crate) fn through(messages: &[Message], input: &MessageId) -> Option<MessageId> {
    let start = messages
        .iter()
        .position(|message| message.id() == input && selectable(message).is_some())?;
    let turn = &messages[start + 1..];
    let end = turn
        .iter()
        .position(|message| selectable(message).is_some())
        .unwrap_or(turn.len());
    let answer = turn[..end].iter().rev().find_map(|message| match message {
        Message::Assistant(assistant) if !assistant.is_resume_sentinel() => {
            Some(assistant.id.clone())
        }
        _ => None,
    });
    Some(answer.unwrap_or_else(|| input.clone()))
}

/// `input` starts the last turn of the history (no selectable input after it).
fn is_last_turn(messages: &[Message], input: &MessageId) -> bool {
    messages
        .iter()
        .rev()
        .find(|message| selectable(message).is_some())
        .is_some_and(|message| message.id() == input)
}

/// The position of `id` when it is a stored assistant reply (not the resume sentinel).
fn reply_position(messages: &[Message], id: &MessageId) -> Option<usize> {
    messages.iter().position(|message| {
        message.id() == id
            && matches!(message, Message::Assistant(assistant) if !assistant.is_resume_sentinel())
    })
}

/// Where the running turn starts in `messages`: its opening user message (`Running::prompt`, a typed input or the
/// last notification of a notification turn). Without a stored prompt (compaction, or a prompt not committed yet)
/// the last selectable input stands in.
fn running_turn_start(messages: &[Message], prompt: Option<&MessageId>) -> Option<usize> {
    prompt
        .and_then(|prompt| messages.iter().position(|message| message.id() == prompt))
        .or_else(|| {
            messages
                .iter()
                .rposition(|message| selectable(message).is_some())
        })
}

/// While a turn runs, a reply at `at` is a completed turn when it precedes the running turn's opening message.
fn completed_while_running(messages: &[Message], at: usize, prompt: Option<&MessageId>) -> bool {
    running_turn_start(messages, prompt).is_some_and(|start| at < start)
}

const RUNNING: &str = "a turn is running; fork after it finishes";

impl Actor {
    /// `ForkFromInput`：空闲时按内存里的活动历史算出终点，交给存储一次写完新会话（§6.5.2）。
    pub(crate) async fn fork_from_input(&self, input: MessageId) -> Ack {
        if self.busy() && !self.deps.fork_while_running {
            return rejected(RUNNING);
        }
        let Some(through) = through(&self.messages, &input) else {
            return rejected(format!("{input} is not a message to fork from"));
        };
        // Fork (node_desktop): only a completed turn is a stable target while a turn runs; the running turn
        // is the last one in the active history, so its input has no later selectable input.
        if self.busy() && is_last_turn(&self.messages, &input) {
            return rejected(RUNNING);
        }
        self.copy_through(through).await
    }

    /// `ForkFromAssistant`: the copy ends at `assistant`. Only the projection's offer decides which reply the App
    /// may fork from; here a running turn is refused: a reply from the running turn's opening message on belongs to
    /// it, a reply before it is a completed turn (also when a notification opened the running turn).
    pub(crate) async fn fork_from_assistant(&self, assistant: MessageId) -> Ack {
        let Some(at) = reply_position(&self.messages, &assistant) else {
            return rejected(format!("{assistant} is not a message to fork from"));
        };
        if self.busy() {
            if !self.deps.fork_while_running {
                return rejected(RUNNING);
            }
            let prompt = self
                .running
                .as_ref()
                .and_then(|running| running.prompt.as_ref());
            if !completed_while_running(&self.messages, at, prompt) {
                return rejected(RUNNING);
            }
        }
        self.copy_through(assistant).await
    }

    /// Writes the child session that carries the history through `through` (`SessionStore::fork`, files untouched).
    async fn copy_through(&self, through: MessageId) -> Ack {
        let child = self.deps.ids.session();
        let fork = SessionFork {
            parent: self.meta.id.clone(),
            child: child.clone(),
            created_at_ms: self.deps.clock.now_ms(),
            through: through.clone(),
            selection: self.selection.clone(),
            mode: self.execution.mode,
            plan: self.execution.plan,
        };
        let receipt = match self.deps.store.fork(fork).await {
            Ok(receipt) => receipt,
            Err(error) => return rejected(error.to_string()),
        };
        // 回执的文字（Node 分叉对话的原文）由 `Forked::response` 给出；`through` 与 `copied` 给界面拼中文提示（工作线 F78）。
        Ack::Accepted {
            result: CommandResult::Forked(Forked {
                session: child,
                through: Some(through),
                copied: receipt.copied,
            }),
        }
    }
}

#[cfg(test)]
#[path = "fork_input_tests.rs"]
mod tests;
