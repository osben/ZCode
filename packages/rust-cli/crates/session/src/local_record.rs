//! 本地命令写进对话的记录（修复线 L-A，docs/specs/rust-cli/tui-manage.md §11）：固定说明、命令输入、输出与 meta
//! 消息都是 meta user 消息（不是人类输入：不开轮次、不改标题），模型下一个请求看得到。
//!
//! 时机（§11.3）：空闲时马上提交一批；回合或压缩在跑时留在这里，这次工作收尾、开下一个回合之前提交（`start_next`）。
//! Fork (W9a, 9.53): 工作流的控制记录（启动轮、设置轮）也是 meta 消息，与本地命令记录共用这一个留存队列，按到达顺序提交。

use rust_cli_kernel_api::clock::Ids;
use rust_cli_kernel_api::ids::CommandId;
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::session_api::Ack;
use rust_cli_kernel_api::store::StoreError;
use rust_cli_kernel_api::user_command::{
    LOCAL_COMMAND_CAVEAT_SOURCE, LOCAL_COMMAND_INPUT_SOURCE, LOCAL_COMMAND_META_SOURCE,
    LOCAL_COMMAND_OUTPUT_SOURCE, LocalCommandRecord,
};
use rust_cli_kernel_api::workflow_run::{WORKFLOW_LAUNCH_SOURCE, WORKFLOW_SETTINGS_SOURCE};

use crate::actor::{Actor, accepted};

/// 这条 user 消息是本地命令的记录（固定说明、命令输入、输出或记录带的 meta），或工作流的控制记录：都不是人类输入。
pub(crate) fn is_record(user: &UserMessage) -> bool {
    matches!(&user.origin, UserOrigin::Meta { source } if [
        LOCAL_COMMAND_CAVEAT_SOURCE,
        LOCAL_COMMAND_INPUT_SOURCE,
        LOCAL_COMMAND_OUTPUT_SOURCE,
        LOCAL_COMMAND_META_SOURCE,
        WORKFLOW_LAUNCH_SOURCE,
        WORKFLOW_SETTINGS_SOURCE,
    ]
    .contains(&source.as_str()))
}

/// Fork (W9a, 9.53): one meta user message of a record. Every record message is built here.
fn meta_message(ids: &dyn Ids, source: String, text: String) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        workflow_meta: None,
        epilogue_start: None,
        intent: None,
        id: ids.message(),
        content: vec![ContentBlock::Text { text }],
        origin: UserOrigin::Meta { source },
    })
}

/// 一条记录的消息，按提交顺序。
pub(crate) fn record_messages(ids: &dyn Ids, record: &LocalCommandRecord) -> Vec<Message> {
    record
        .texts()
        .into_iter()
        .map(|(source, text)| meta_message(ids, source.to_owned(), text))
        .collect()
}

/// Fork (W9a, 9.53): a record held while a turn runs. Local records and workflow control records share one queue, so they
/// commit in the order they arrived.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum HeldRecord {
    Local(LocalCommandRecord),
    Workflow { source: String, text: String },
}

impl HeldRecord {
    fn messages(self, ids: &dyn Ids) -> Vec<Message> {
        match self {
            Self::Local(record) => record_messages(ids, &record),
            Self::Workflow { source, text } => vec![meta_message(ids, source, text)],
        }
    }
}

impl Actor {
    /// `Command::RecordLocalCommand`：空闲时提交，忙时留到收尾。提交失败只记日志（记录是给模型的上下文，丢了不影响
    /// 命令本身已经生效的结果）。
    pub(crate) async fn record_local_command(
        &mut self,
        command: CommandId,
        record: LocalCommandRecord,
    ) -> Ack {
        if self.busy() {
            self.held_records.push(HeldRecord::Local(record));
            return accepted();
        }
        let messages = record_messages(self.deps.ids.as_ref(), &record);
        if let Err(reason) = self.commit_record_messages(Some(command), messages).await {
            tracing::warn!(%reason, command = %record.name, "the local command record could not be stored");
        }
        accepted()
    }

    /// Fork (W9a, 9.53): `Command::RecordWorkflowTurn`. A workflow control record is a meta user message (no turn, no model
    /// call). Busy: it joins the held queue behind the records already waiting. Always `Accepted`; a failed store is logged.
    pub(crate) async fn record_workflow_turn(
        &mut self,
        command: CommandId,
        text: String,
        source: String,
    ) -> Ack {
        if self.busy() {
            self.held_records
                .push(HeldRecord::Workflow { source, text });
            return accepted();
        }
        let message = meta_message(self.deps.ids.as_ref(), source, text);
        if let Err(reason) = self
            .commit_record_messages(Some(command), vec![message])
            .await
        {
            tracing::warn!(%reason, "the workflow control record could not be stored");
        }
        accepted()
    }

    /// 回合或压缩收尾后：把这期间到达的记录按到达顺序一批提交。
    pub(crate) async fn flush_held_records(&mut self) {
        if self.busy() || self.held_records.is_empty() {
            return;
        }
        let held = std::mem::take(&mut self.held_records);
        let messages: Vec<Message> = held
            .into_iter()
            .flat_map(|record| record.messages(self.deps.ids.as_ref()))
            .collect();
        if let Err(reason) = self.commit_record_messages(None, messages).await {
            tracing::warn!(%reason, "the held local and workflow records could not be stored");
        }
    }

    /// 先落库，再进历史、发事件（与别的提交同一个顺序）。`messages` 之后可以接别的消息（`/cd` 的说明文字由调用方
    /// 放在同一批里）。
    pub(crate) async fn commit_record_messages(
        &mut self,
        command: Option<CommandId>,
        messages: Vec<Message>,
    ) -> Result<(), StoreError> {
        let appended = self.append(command, messages, Vec::new()).await?;
        self.after_commit(appended).await;
        Ok(())
    }
}

#[cfg(test)]
#[path = "local_record_tests.rs"]
mod tests;
