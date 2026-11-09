//! next 通道（L18，docs/specs/rust-cli/query.md §5）：插话输入与两种后台通知按到达顺序排在一起。
//!
//! 插话、后台命令通知与子代理通知都是优先级 `next`，工具边界按队列顺序取，回合
//! 结束后也按这个顺序开回合；`Queue` 输入是 `later`，不进通道。通道与排队的输入是 actor 的 `Inbox`（inbox.rs）
//! 的两个投影：一条输入只存一份。
//!
//! 修正（L18）：以前通知只在回合结束后各开一个回合（按缺省优先级 `later`
//! 理解），排在全部排队输入之后；通知应是 `next`，在下一个工具边界并入。

use rust_cli_kernel_api::agents::AgentNotice;
use rust_cli_kernel_api::hooks::queued_command;
use rust_cli_kernel_api::ids::CommandId;
use rust_cli_kernel_api::machine_notices::MachineNotice;
use rust_cli_kernel_api::message::{ContentBlock, Message, UserOrigin};
use rust_cli_kernel_api::session_api::InputExecution;
use rust_cli_kernel_api::store::Fact;

use crate::actor::Actor;
use crate::inbox::{InputKind, Item, LaneItem, Queued, is_slash};
use crate::notices::{NOTICE_SOURCE, task_notification};
use crate::peers::{PEER_SOURCE, PeerItem};
use crate::turn::TurnInput;

/// 取回时输入已经不在队列里（`Command::Dequeue` 的 `Rejected.reason`，给用户看）。
pub(crate) const ALREADY_SENT: &str = "the message already went out";

/// 一条等候中的后台通知，或跨会话的消息与回执（同伴消息同样是优先级 `next`，cross-session.md §1.7）。
#[derive(Debug, Clone)]
pub(crate) enum Waiting {
    /// 后台命令的终态通知，带它所在的机器（R3：ack 发给那台机器）。
    Shell(MachineNotice),
    Agent(AgentNotice),
    Peer(PeerItem),
    /// Monitor 的事件或说明（工作线 F83，tools-more.md §19.6）：actor 自己产生，全文已包装；不 ack，也不按文字去重
    /// （同样的一行可以出现多次）。
    MonitorEvent(String),
    /// Monitor 的终态通知（带剩下的行），提交后 ack 它的 `ShellNotice`。
    MonitorEnd {
        notice: Box<MachineNotice>,
        text: String,
    },
}

impl Waiting {
    /// 通知全文（`<system-reminder>` 包装）：工具边界并入用它；后台通知开回合也用它。
    pub(crate) fn text(&self) -> String {
        match self {
            Self::Shell(notice) => task_notification(&notice.notice),
            Self::Agent(notice) => notice.text.clone(),
            Self::Peer(item) => item.text(),
            Self::MonitorEvent(text) | Self::MonitorEnd { text, .. } => text.clone(),
        }
    }

    /// 空闲时开回合的 user 消息文字（同伴消息的第一行不同）。
    pub(crate) fn turn_text(&self) -> String {
        match self {
            Self::Peer(item) => item.turn_text(),
            _ => self.text(),
        }
    }

    /// 开回合的 meta user 消息的来源。
    pub(crate) fn source(&self) -> &'static str {
        match self {
            Self::Peer(_) => PEER_SOURCE,
            _ => NOTICE_SOURCE,
        }
    }

    /// 只在工具边界并入、不开回合（`-p` 的回执，passive）。
    pub(crate) fn passive(&self) -> bool {
        matches!(self, Self::Peer(item) if item.passive())
    }

    /// 并入对话时与那条消息同一批提交的事实：同伴的消息与回执是 `peer_merged`（cross-session.md §2.4，F139），其余没有。
    pub(crate) fn merged_facts(&self) -> Vec<Fact> {
        match self {
            Self::Peer(item) => item.merged_facts(),
            _ => Vec::new(),
        }
    }

    pub(crate) fn same(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Shell(a), Self::Shell(b)) => {
                a.machine == b.machine && a.notice.seq == b.notice.seq
            }
            (Self::Agent(a), Self::Agent(b)) => a.seq == b.seq,
            (Self::Peer(a), Self::Peer(b)) => a == b,
            (Self::MonitorEnd { notice: a, .. }, Self::MonitorEnd { notice: b, .. }) => {
                a.machine == b.machine && a.notice.seq == b.notice.seq
            }
            _ => false,
        }
    }
}

/// 消息里的通知全文：开回合的 meta user 消息，或工具边界并入的 `task-notification` attachment。
/// Fork: a desktop notice batch is one meta message with a text block per notification, so each
/// block is a notification of its own.
fn notice_texts(message: &Message) -> Vec<&str> {
    match message {
        Message::User(user) if matches!(&user.origin, UserOrigin::Meta { source } if source == NOTICE_SOURCE || source == PEER_SOURCE) => {
            user.content
                .iter()
                .map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Option<Vec<_>>>()
                .unwrap_or_default()
        }
        Message::Attachment(attachment)
            if attachment.source == queued_command::SOURCE
                && attachment.data[queued_command::MODE_KEY] == NOTICE_SOURCE =>
        {
            vec![attachment.text.as_str()]
        }
        _ => Vec::new(),
    }
}

impl Actor {
    /// 通知到达：已在对话里或已在通道里（重复送达）时只 ack；否则排进通道。返回是否新排进。
    pub(crate) async fn enqueue_notice(&mut self, notice: Waiting) -> bool {
        let text = notice.text();
        let seen = self
            .messages
            .iter()
            .any(|message| notice_texts(message).contains(&text.as_str()));
        let waiting = self.inbox.has_notice(&notice);
        if seen || waiting {
            if !waiting {
                self.ack_notice(&notice).await;
            }
            return false;
        }
        self.inbox.push_notice(notice);
        true
    }

    /// 提交之后才 ack（至少一次）。同伴的消息与回执在收到时已经提交并 ack（peers.rs）。
    pub(crate) async fn ack_notice(&self, notice: &Waiting) {
        match notice {
            Waiting::Shell(notice) => self.ack(notice).await,
            Waiting::MonitorEnd { notice, .. } => self.ack(notice).await,
            Waiting::Agent(notice) => self.ack_agent(notice.seq).await,
            Waiting::Peer(_) | Waiting::MonitorEvent(_) => {}
        }
    }

    /// 工具边界并入的 `task-notification` 已提交：按交给主循环时给的消息 ID 从通道取走这条通知并 ack（工作线 F130：
    /// 以前按 attachment 的文字与通知全文相等找回）。
    pub(crate) async fn notice_absorbed(&mut self, message: &Message) {
        let Message::Attachment(attachment) = message else {
            return;
        };
        if let Some(notice) = self.inbox.take_absorbed(&attachment.id) {
            self.ack_notice(&notice).await;
        }
    }

    /// 回合结束后与头一条输入成批的后续输入（修复线 L-A，query.md §4.3，同对照实现）：头一条是
    /// 普通文字、不是斜杠命令时，往后连着取通道里的插话、再取队列里的 `Queue` 输入；遇到通知、斜杠命令、bash、
    /// 带图片的输入、含 `@` 的文字就停（留在原处）。
    ///
    /// 配置了 UserPromptSubmit 时不成批（暂定）：对照实现在入队时就逐条筛查，本工程在开回合的任务里只筛查头一条，头一条被
    /// 阻塞时成批的后续输入会跟着丢掉。
    ///
    /// SessionStart 给的首条输入单独一个回合（同对照实现的启动命令）。
    fn take_batch(&mut self, command: &CommandId, head: &str) -> Vec<crate::turn::MorePrompt> {
        let screening = self
            .deps
            .hooks
            .has_hooks(rust_cli_kernel_api::hooks::HookEventName::UserPromptSubmit);
        let startup = command
            .as_str()
            .starts_with(crate::hooks::SESSION_START_INPUT);
        if is_slash(head) || screening || startup || self.deps.one_input_per_turn {
            return Vec::new();
        }
        let mut more = Vec::new();
        while let Some(queued) = self.inbox.take_batched() {
            let text = queued.input.text.clone();
            more.push(crate::turn::MorePrompt {
                screened: queued.screened(),
                text,
            });
        }
        if !more.is_empty() {
            self.emit_queue();
        }
        more
    }

    /// `Command::Dequeue`（query.md §4.4）：还在队列里的输入取回——从队列与通道去掉（输入的种类与并入点筛查的结果
    /// 跟着条目一起去掉）。判断与出队在 actor 的一次处理里：开回合、成批与工具边界的结局（`settle_steering`）也都在
    /// actor 里出队，所以一条输入要么取回、要么发出，不会两样都有。
    pub(crate) fn dequeue(&mut self, command: &CommandId) -> rust_cli_kernel_api::session_api::Ack {
        if self
            .inbox
            .remove_input(command, crate::inbox::Left::Cancelled("user_removed"))
            .is_none()
        {
            return crate::actor::rejected(ALREADY_SENT);
        }
        self.emit_queue();
        crate::actor::accepted()
    }

    /// Fork: `Command::EditQueued` (Node `editQueueItem`): replace the text of a still-queued input in
    /// place — position, delivery and screening are kept. The same miss and rejection as
    /// [`Self::dequeue`] when the input already went out.
    pub(crate) fn edit_queued(
        &mut self,
        command: &CommandId,
        text: String,
    ) -> rust_cli_kernel_api::session_api::Ack {
        if !self.inbox.edit_input(command, text) {
            return crate::actor::rejected(ALREADY_SENT);
        }
        self.emit_queue();
        crate::actor::accepted()
    }

    /// Fork: `Command::ReorderQueued` (Node `reorderQueueItem`): move a queued input before another
    /// queued input, or to the end of the queue when `before` is `None`. Either no longer queued → the
    /// same rejection as [`Self::dequeue`], with the queue unchanged.
    pub(crate) fn reorder_queued(
        &mut self,
        command: &CommandId,
        before: Option<&CommandId>,
    ) -> rust_cli_kernel_api::session_api::Ack {
        if !self.inbox.reorder_input(command, before) {
            return crate::actor::rejected(ALREADY_SENT);
        }
        self.emit_queue();
        crate::actor::accepted()
    }

    /// Fork: `Command::HoldQueue` (Node `setAutoDrain`, `held` is `!autoDrain`): while held, a finished
    /// turn does not start the next queued input ([`Self::next_turn_input`] checks the flag). Releasing
    /// while idle starts the head of the queue as a turn end would (`start_next` also looks at cron and
    /// held local records); while busy it only clears the flag and the running turn's end resumes the
    /// drain. Always `Accepted`.
    pub(crate) async fn hold_queue(&mut self, held: bool) -> rust_cli_kernel_api::session_api::Ack {
        let was = self.inbox.held();
        if self.inbox.set_held(held) {
            self.emit_queue();
        }
        if was && !held && !self.busy() {
            self.start_next().await;
        }
        crate::actor::accepted()
    }

    /// 回合结束后的下一项（query.md §5）：通道头是输入就是它；是通知就取走头部连续的通知，合成一个
    /// 回合（通知合并）；通道空时是 `Queue` 输入（优先级 `later`）。定时任务由调用方最后看。
    /// The next turn's input, with the execution state frozen on it when it was submitted
    /// (`Command::SubmitWith`); the caller applies that state before the turn starts.
    pub(crate) fn next_turn_input(&mut self) -> Option<(TurnInput, Option<InputExecution>)> {
        // 只在工具边界并入的项（`-p` 的回执）不开回合：留在通道里，看后面的项。
        let passive = self.inbox.take_passive_prefix();
        let next = self.next_active_input();
        self.inbox.restore_front(passive);
        next
    }

    /// 通道头不是只在工具边界并入的项时的下一项。
    fn next_active_input(&mut self) -> Option<(TurnInput, Option<InputExecution>)> {
        match self.inbox.lane_front() {
            // Fork: the queue is held (`Command::HoldQueue`): queued inputs wait. A notice behind a held
            // input waits too — the lane is the arrival order and the drain may not skip ahead of it.
            Some(LaneItem::Input(_)) if self.inbox.held() => None,
            Some(LaneItem::Input(_)) => {
                let Some(Item::Input(queued)) = self.inbox.pop_lane_front() else {
                    return None;
                };
                self.emit_queue();
                let execution = queued.input.execution.clone();
                Some((self.human_turn(queued), execution))
            }
            Some(LaneItem::Notice(_)) => {
                let mut notices = Vec::new();
                while let Some(LaneItem::Notice(notice)) = self.inbox.lane_front() {
                    if notice.waiting.passive() {
                        break;
                    }
                    if let Some(Item::Notice(notice)) = self.inbox.pop_lane_front() {
                        notices.push(notice.waiting);
                    }
                }
                Some((TurnInput::Notices(notices), None))
            }
            None => {
                // Fork: held stops the `later` inputs as well — they are part of the same queue.
                if self.inbox.held() {
                    return None;
                }
                let next = self.inbox.pop_later()?;
                self.emit_queue();
                let command = next.input.command.clone();
                let execution = next.input.execution.clone();
                let input = match next.kind {
                    InputKind::Bash(line) => TurnInput::Bash { command, line },
                    InputKind::Content(content) => TurnInput::Content { command, content },
                    InputKind::Compact => TurnInput::Compact { command },
                    InputKind::Text => self.human_turn(next),
                };
                Some((input, execution))
            }
        }
    }

    /// Fork (desktop App): [`Self::start_next`] would start a turn (a lane notice, an input not held, a due cron fire
    /// already taken); the goal verifier yields to it (Node `yieldToPendingCommands`).
    pub(crate) fn has_next_input(&self) -> bool {
        let notice = self
            .inbox
            .lane()
            .any(|item| matches!(item, LaneItem::Notice(notice) if !notice.waiting.passive()));
        notice || (!self.inbox.held() && self.inbox.has_inputs()) || !self.cron_fires.is_empty()
    }

    /// 一条文字输入开的回合，连同与它成批的后续输入。
    fn human_turn(&mut self, queued: Queued) -> TurnInput {
        let command = queued.input.command.clone();
        let text = queued.input.text.clone();
        let screened = queued.screened();
        let more = self.take_batch(&command, &text);
        TurnInput::Human {
            screened,
            command,
            text,
            more,
        }
    }
}

#[cfg(test)]
#[path = "batch_tests.rs"]
mod batch_tests;
