//! 输入调度（工作线 F130，architecture-review.md C6）：排队的输入、next 通道与它们的旁路状态收在一个结构里。
//!
//! 以前是 actor 的 4 个字段（`queue`、`lane`、`screened`、`queued_kinds`），在 7 个文件里直接修改；“通道里的输入一定在
//! 队列里”只靠约定，调度代码里留着找不到时的兜底分支。现在只有一个按到达顺序的序列 `items`：
//!
//! ```text
//!  items（到达顺序）： [输入 q1] [通知 n1] [插话 s1] [输入 q2] [通知 n2] …
//!  排队的输入（QueueChanged 与视图）： 全部输入，按顺序 → q1 s1 q2
//!  next 通道（优先级 next）：           通知与插话（还有 SessionStart 的首条输入），按顺序 → n1 s1 n2
//!  later（`Queue` 输入）：             其余输入，按顺序 → q1 q2
//! ```
//!
//! 一条输入只存一份，通道与队列都是它的投影，所以不变式由构造保证。输入的种类（文字、bash 模式、带内容块）与并入点
//! 筛查留下的结果跟着条目走。通道里的项与 later 输入之间的相对位置没有意义：通道里有项时总是先取通道。

use std::collections::VecDeque;

use rust_cli_kernel_api::hooks::HookOutcome;
use rust_cli_kernel_api::ids::{CommandId, MessageId};
use rust_cli_kernel_api::message::ContentBlock;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{Delivery, QueuedInput, QueuedKind};
use rust_cli_kernel_api::store::{AdmittedInput, InputDelivery};

use crate::lane::Waiting;

/// 排队输入的种类（bash.rs，tui-input.md §2.2、§3.2）。
#[derive(Debug)]
pub(crate) enum InputKind {
    /// 普通文字（正文在 `QueuedInput.text`）。
    Text,
    /// bash 模式的命令原文。
    Bash(String),
    /// 带内容块的输入（粘贴的图片）。
    Content(Vec<ContentBlock>),
    /// Fork: a manual compaction queued behind the running turn (`Command::SubmitWith`).
    Compact,
}

/// 并入点的筛查（steering.rs）。
#[derive(Debug)]
pub(crate) enum Screening {
    /// 还没在工具边界跑过 UserPromptSubmit。
    Unscreened,
    /// 跑过、留到回合结束后作为独立回合（屏障）：有结果时那个回合直接用它；None 时（领取后被中止）重跑 hook。
    Held(Option<Box<HookOutcome>>),
}

/// 一条排队的输入。
#[derive(Debug)]
pub(crate) struct Queued {
    pub(crate) input: QueuedInput,
    pub(crate) kind: InputKind,
    pub(crate) screening: Screening,
    /// 在 next 通道里：插话，与 SessionStart 给的首条输入；其余是 later。
    lane: bool,
    /// Fork: the input has a `session_input` ledger row (a submitted input; not the SessionStart hook's first input).
    ledger: bool,
}

impl Queued {
    /// 能与头一条成批进同一个回合（修复线 L-A，query.md §4.3）：普通文字、不是斜杠命令、不含 `@`。
    fn plain(&self) -> bool {
        matches!(self.kind, InputKind::Text)
            && !is_slash(&self.input.text)
            && !self.input.text.contains('@')
    }

    /// 并入点筛查留下的结果（回合结束后开它时用，不再跑 hook）。
    pub(crate) fn screened(self) -> Option<Box<HookOutcome>> {
        match self.screening {
            Screening::Held(outcome) => outcome,
            Screening::Unscreened => None,
        }
    }
}

/// 通道里一条通知的身份：只在内存，工具边界领取与交回时用它认出是哪一条（工作线 F130，审查 C8）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NoticeKey(u64);

/// 通道里的一条通知。
#[derive(Debug)]
pub(crate) struct LaneNotice {
    pub(crate) waiting: Waiting,
    pub(crate) key: NoticeKey,
    /// 在工具边界交给主循环时给它的 attachment 的消息 ID：那条消息提交之后按这个 ID 取走并 ack（lane.rs）。以前按
    /// attachment 的文字与通道里的通知全文相等找回。
    attachment: Option<MessageId>,
}

/// 序列里的一项。
#[derive(Debug)]
pub(crate) enum Item {
    Input(Queued),
    Notice(LaneNotice),
}

impl Item {
    /// 在 next 通道里（通知、插话）。
    fn in_lane(&self) -> bool {
        match self {
            Self::Input(queued) => queued.lane,
            Self::Notice(_) => true,
        }
    }
}

/// 通道里的一项（只读）。
pub(crate) enum LaneItem<'a> {
    Input(&'a Queued),
    Notice(&'a LaneNotice),
}

/// 斜杠命令：trim 之后以 `/` 开头（与插话的跳过规则相同，query.md §4）。
pub(crate) fn is_slash(text: &str) -> bool {
    text.trim().starts_with('/')
}

/// Fork: a change of a queued input for Node's `session_input` ledger (specs/fork-rust-agent-parity.md, Input ledger).
/// The inbox journals it where the input enters or leaves; the actor writes the journal ([`Inbox::take_journal`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum LedgerChange {
    Admitted(AdmittedInput),
    Promoted(CommandId),
    Cancelled(CommandId, &'static str),
}

/// Fork: why [`Inbox::remove_input`] took an input out of the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Left {
    /// Into the running turn (absorbed at a tool boundary).
    Promoted,
    /// Without a turn, with the ledger reason.
    Cancelled(&'static str),
}

/// The ledger row of a queued input.
fn admitted(queued: &Queued) -> AdmittedInput {
    // Node's queue item kinds; a bash-mode or content input is typed text there.
    let kind = match (&queued.kind, queued.input.kind) {
        (InputKind::Compact, _) | (_, QueuedKind::Compact) => "compact",
        (_, QueuedKind::Goal) => "sendGoalCommand",
        _ => "sendText",
    };
    AdmittedInput {
        command: queued.input.command.clone(),
        kind: kind.to_owned(),
        delivery: match queued.input.delivery {
            Delivery::Steer => InputDelivery::Guide,
            _ => InputDelivery::Queue,
        },
        text: queued.input.text.clone(),
    }
}

/// 会话 actor 的输入调度：只在 actor 里经 `&mut` 访问。
#[derive(Debug, Default)]
pub(crate) struct Inbox {
    items: VecDeque<Item>,
    /// Fork: ledger changes not written yet, in order.
    journal: Vec<LedgerChange>,
    /// 下一条通知的 [`NoticeKey`]。
    next_key: u64,
    /// Fork: the drain is paused (`Command::HoldQueue`, Node `setAutoDrain` with `autoDrain: false`):
    /// turn ends do not start queued inputs until it is released.
    held: bool,
    /// Fork: the foreground promotion lease (`Command::ReserveForeground`): no turn starts on its own.
    reserved: bool,
}

impl Inbox {
    /// 运行中到达的输入：插话（`Steer`）进通道，其余是 later。
    pub(crate) fn push_input(&mut self, input: QueuedInput, kind: InputKind) {
        let lane = input.delivery == Delivery::Steer;
        let queued = Queued {
            input,
            kind,
            screening: Screening::Unscreened,
            lane,
            ledger: true,
        };
        self.journal.push(LedgerChange::Admitted(admitted(&queued)));
        self.items.push_back(Item::Input(queued));
    }

    /// Fork: the ledger changes since the last call, in order.
    pub(crate) fn take_journal(&mut self) -> Vec<LedgerChange> {
        std::mem::take(&mut self.journal)
    }

    /// Fork: journal an input leaving the queue.
    fn left(&mut self, queued: &Queued, how: Left) {
        if !queued.ledger {
            return;
        }
        let command = queued.input.command.clone();
        self.journal.push(match how {
            Left::Promoted => LedgerChange::Promoted(command),
            Left::Cancelled(reason) => LedgerChange::Cancelled(command, reason),
        });
    }

    /// SessionStart 给的首条输入：排在最前（通道与队列的头部），回合结束后先开它（hooks.rs）。
    pub(crate) fn push_first(&mut self, input: QueuedInput) {
        self.items.push_front(Item::Input(Queued {
            input,
            kind: InputKind::Text,
            screening: Screening::Unscreened,
            lane: true,
            ledger: false,
        }));
    }

    pub(crate) fn push_notice(&mut self, waiting: Waiting) {
        let key = NoticeKey(self.next_key);
        self.next_key += 1;
        self.items.push_back(Item::Notice(LaneNotice {
            waiting,
            key,
            attachment: None,
        }));
    }

    /// 排队的输入，按到达顺序（`QueueChanged` 与视图的唯一来源）。
    pub(crate) fn queued(&self) -> Vec<QueuedInput> {
        self.inputs().map(|queued| queued.input.clone()).collect()
    }

    fn inputs(&self) -> impl Iterator<Item = &Queued> {
        self.items.iter().filter_map(|item| match item {
            Item::Input(queued) => Some(queued),
            Item::Notice(_) => None,
        })
    }

    pub(crate) fn has_inputs(&self) -> bool {
        self.inputs().next().is_some()
    }

    /// 通道里有插话（低延迟投递转不转后台，workspace.rs）。
    pub(crate) fn has_lane_input(&self) -> bool {
        self.inputs().any(|queued| queued.lane)
    }

    /// 通道里没有项（通知、插话）。
    pub(crate) fn lane_is_empty(&self) -> bool {
        !self.items.iter().any(Item::in_lane)
    }

    /// 通道里的项，按顺序（工具边界的领取，steering.rs）。
    pub(crate) fn lane(&self) -> impl Iterator<Item = LaneItem<'_>> {
        self.items.iter().filter_map(|item| match item {
            Item::Input(queued) if queued.lane => Some(LaneItem::Input(queued)),
            Item::Input(_) => None,
            Item::Notice(notice) => Some(LaneItem::Notice(notice)),
        })
    }

    pub(crate) fn contains_input(&self, command: &CommandId) -> bool {
        self.inputs().any(|queued| queued.input.command == *command)
    }

    /// 去掉一条输入（并入、丢弃、成批取走）。
    pub(crate) fn remove_input(&mut self, command: &CommandId, how: Left) -> Option<Queued> {
        let at = self.items.iter().position(
            |item| matches!(item, Item::Input(queued) if queued.input.command == *command),
        )?;
        match self.items.remove(at) {
            Some(Item::Input(queued)) => {
                self.left(&queued, how);
                Some(queued)
            }
            Some(Item::Notice(_)) | None => None,
        }
    }

    /// Fork: replace the text of a still-queued input in place (Node `editQueueItem`, kernel
    /// `EditQueued`) — the input keeps its position, delivery and screening. `false` when it is no
    /// longer queued (already started or merged into a turn), the same miss as `remove_input`.
    /// For bash-mode and content-block inputs this rewrites the display text only; their turn input
    /// comes from the kind, and the App's queue panel only edits typed text inputs.
    pub(crate) fn edit_input(&mut self, command: &CommandId, text: String) -> bool {
        for item in &mut self.items {
            if let Item::Input(queued) = item
                && queued.input.command == *command
                // A queued compaction has no text to edit (Node `queueEdit` refuses maintenance items).
                && !matches!(queued.kind, InputKind::Compact)
            {
                // Node `editPendingInputById`: the intent's text follows; its quotes stay.
                if let Some(intent) = &mut queued.input.intent {
                    intent.set_text(&text);
                }
                queued.input.text = text;
                if queued.ledger {
                    self.journal.push(LedgerChange::Admitted(admitted(queued)));
                }
                return true;
            }
        }
        false
    }

    /// Fork: a compaction is already queued (Node `compactOperationLock`).
    pub(crate) fn has_compact(&self) -> bool {
        self.items.iter().any(
            |item| matches!(item, Item::Input(queued) if matches!(queued.kind, InputKind::Compact)),
        )
    }

    /// Fork: full access rewrites the frozen permission mode of every queued input that carries one,
    /// keeping its plan switch (Node's `fullAccess` rewrites the queued intents). `true` when one changed.
    pub(crate) fn set_queued_mode(&mut self, mode: PermissionMode) -> bool {
        let mut changed = false;
        for item in &mut self.items {
            if let Item::Input(queued) = item
                && let Some(execution) = &mut queued.input.execution
                && execution.state.mode != mode
            {
                execution.state = execution.state.with_mode(mode);
                changed = true;
            }
        }
        changed
    }

    /// Fork: move a queued input before another queued input, or to the end of the queue when `before`
    /// is `None` (Node `reorderQueueItem`, kernel `ReorderQueued`). `false` — leaving everything
    /// unchanged — when either input is no longer queued (a `before` equal to the moved input counts as
    /// a miss: it is not there once the moved one is taken out).
    pub(crate) fn reorder_input(
        &mut self,
        command: &CommandId,
        before: Option<&CommandId>,
    ) -> bool {
        let Some(at) = self.items.iter().position(
            |item| matches!(item, Item::Input(queued) if queued.input.command == *command),
        ) else {
            return false;
        };
        let Some(Item::Input(moved)) = self.items.remove(at) else {
            return false;
        };
        let target = before.and_then(|before| {
            self.items.iter().position(
                |item| matches!(item, Item::Input(queued) if queued.input.command == *before),
            )
        });
        match target {
            // The position is taken after the removal, so the moved input lands right before the target.
            Some(target) => {
                self.items.insert(target, Item::Input(moved));
                true
            }
            None if before.is_none() => {
                self.items.push_back(Item::Input(moved));
                true
            }
            // The anchor is gone: put the input back where it was.
            None => {
                self.items.insert(at, Item::Input(moved));
                false
            }
        }
    }

    /// Fork: the queue is held (`Command::HoldQueue`, Node `setAutoDrain`): turn ends do not start
    /// queued inputs.
    pub(crate) fn held(&self) -> bool {
        self.held
    }

    /// Fork: the foreground is reserved for a promoted input (`Command::ReserveForeground`).
    pub(crate) fn reserved(&self) -> bool {
        self.reserved
    }

    /// Fork: set the reservation; returns the previous value.
    pub(crate) fn set_reserved(&mut self, reserved: bool) -> bool {
        std::mem::replace(&mut self.reserved, reserved)
    }

    /// Fork: set the hold; returns whether it changed (the actor emits `QueueChanged` on a change).
    pub(crate) fn set_held(&mut self, held: bool) -> bool {
        std::mem::replace(&mut self.held, held) != held
    }

    /// 并入点筛查后留下（`Fate::Waits`）。
    pub(crate) fn hold(&mut self, command: &CommandId, outcome: Option<Box<HookOutcome>>) {
        for item in &mut self.items {
            if let Item::Input(queued) = item
                && queued.input.command == *command
            {
                queued.screening = Screening::Held(outcome);
                return;
            }
        }
    }

    /// 通道里有没有同一条通知（重复送达）。
    pub(crate) fn has_notice(&self, notice: &Waiting) -> bool {
        self.items
            .iter()
            .any(|item| matches!(item, Item::Notice(queued) if queued.waiting.same(notice)))
    }

    /// 工具边界把这条通知交给主循环，它的 attachment 用消息 ID `attachment`（再领取时换成新的）。
    pub(crate) fn absorbing(&mut self, key: NoticeKey, attachment: MessageId) {
        for item in &mut self.items {
            if let Item::Notice(notice) = item
                && notice.key == key
            {
                notice.attachment = Some(attachment);
                return;
            }
        }
    }

    /// 在工具边界交给主循环、attachment 用消息 ID `attachment` 的那一项（还在通道里）：提交这条 attachment 时把它并入的
    /// 事实放进同一批（append.rs，F139）。
    pub(crate) fn absorbing_item(&self, attachment: &MessageId) -> Option<&Waiting> {
        self.items.iter().find_map(|item| match item {
            Item::Notice(notice) if notice.attachment.as_ref() == Some(attachment) => {
                Some(&notice.waiting)
            }
            _ => None,
        })
    }

    /// 消息 ID 是 `attachment` 的那条通知已经并入对话：取走它。
    pub(crate) fn take_absorbed(&mut self, attachment: &MessageId) -> Option<Waiting> {
        let at = self.items.iter().position(|item| {
            matches!(item, Item::Notice(notice) if notice.attachment.as_ref() == Some(attachment))
        })?;
        match self.items.remove(at) {
            Some(Item::Notice(notice)) => Some(notice.waiting),
            Some(Item::Input(_)) | None => None,
        }
    }

    /// 通道头部连续的、只在工具边界并入的通知（`-p` 的回执，passive）：开回合时跳过它们，之后用
    /// [`Self::restore_front`] 放回原处。
    pub(crate) fn take_passive_prefix(&mut self) -> Vec<Item> {
        let mut taken = Vec::new();
        while let Some(at) = self.items.iter().position(Item::in_lane) {
            let passive =
                matches!(&self.items[at], Item::Notice(notice) if notice.waiting.passive());
            if !passive {
                break;
            }
            if let Some(item) = self.items.remove(at) {
                taken.push(item);
            }
        }
        taken
    }

    /// 放回 [`Self::take_passive_prefix`] 取走的项（仍在通道的最前面）。
    pub(crate) fn restore_front(&mut self, items: Vec<Item>) {
        for item in items.into_iter().rev() {
            self.items.push_front(item);
        }
    }

    /// 通道头上的项是什么（不取走）。
    pub(crate) fn lane_front(&self) -> Option<LaneItem<'_>> {
        self.lane().next()
    }

    /// 取走通道头上的项。
    pub(crate) fn pop_lane_front(&mut self) -> Option<Item> {
        let at = self.items.iter().position(Item::in_lane)?;
        let item = self.items.remove(at)?;
        if let Item::Input(queued) = &item {
            self.left(queued, Left::Promoted);
        }
        Some(item)
    }

    /// 取走第一条 later 输入（通道为空时，优先级 `later`）。
    pub(crate) fn pop_later(&mut self) -> Option<Queued> {
        let at = self
            .items
            .iter()
            .position(|item| matches!(item, Item::Input(queued) if !queued.lane))?;
        match self.items.remove(at) {
            Some(Item::Input(queued)) => {
                self.left(&queued, Left::Promoted);
                Some(queued)
            }
            Some(Item::Notice(_)) | None => None,
        }
    }

    /// 与头一条成批的下一条（修复线 L-A，query.md §4.3）：通道头是插话时是它，是通知时没有；通道空时是第一条 later
    /// 输入。它能成批（[`Queued::plain`]）时取走。
    pub(crate) fn take_batched(&mut self) -> Option<Queued> {
        let at = match self.items.iter().position(Item::in_lane) {
            Some(at) => match &self.items[at] {
                Item::Input(_) => at,
                Item::Notice(_) => return None,
            },
            None => self
                .items
                .iter()
                .position(|item| matches!(item, Item::Input(_)))?,
        };
        match &self.items[at] {
            Item::Input(queued) if queued.plain() => {}
            Item::Input(_) | Item::Notice(_) => return None,
        }
        match self.items.remove(at) {
            Some(Item::Input(queued)) => {
                self.left(&queued, Left::Promoted);
                Some(queued)
            }
            Some(Item::Notice(_)) | None => None,
        }
    }
}

#[cfg(test)]
#[path = "inbox_tests.rs"]
mod tests;
