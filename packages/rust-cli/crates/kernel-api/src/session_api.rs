//! 前端使用的内核会话 API（docs/specs/rust-cli/README.md §3、§7）。
//!
//! TUI 与 headless 只经这里驱动内核；第二阶段的 ZCode Protocol 前端也一样。事件覆盖 spec §7
//! 列出的 V4 适配层输入，每个事件带会话内单调递增的 seq，并能从持久事实重建（§6 规则 13）。

use std::sync::Arc;

use async_trait::async_trait;
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use serde::{Deserialize, Serialize};

use crate::env::WorkspaceRef;
use crate::ids::{AgentId, CommandId, InteractionId, MessageId, SessionId, ShellTaskId};
use crate::message::Message;
use crate::model::ModelSelection;
use crate::orchestration::InteractionRequest;
use crate::permission::PermissionMode;
use crate::store::{ArtifactRef, SessionFilter, SessionMeta, SessionSummary};

/// Fork: [`Command::SubmitWith`]'s rejection while a compaction runs or is queued (Node `compactOperationLock`).
pub const COMPACT_LOCKED: &str = "Compact is already running or queued";

/// 运行中提交的输入怎样投递（工具边界吸收排队消息）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    /// 当前回合结束后作为新回合发送。
    Queue,
    /// 在下一个工具边界注入当前回合。
    Steer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewindScope {
    Conversation,
    Code,
    Both,
}

/// Fork: what a code rewind to `target` would do, computed without changing anything (Node's file rewind preview).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct RewindPreview {
    /// Files the rewind would restore (or delete) without conflicts.
    pub safe: Vec<RewindSafeFile>,
    /// Files the rewind cannot restore, each with why.
    pub unsafe_files: Vec<RewindUnsafeFile>,
}

/// A file a code rewind would restore without conflicts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RewindSafeFile {
    /// As the checkpoint stores it (absolute).
    pub path: String,
    /// True when the file did not exist before and the rewind deletes it.
    pub delete: bool,
    /// Checkpoint operations on this path in the rewound range.
    pub operation_count: u32,
    /// Distinct tool names that wrote it; empty when the checkpoint records no name.
    pub tool_names: Vec<String>,
}

/// A file a code rewind cannot restore, with why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RewindUnsafeFile {
    /// As the checkpoint stores it (absolute); the artifact id when the checkpoint cannot be read.
    pub path: String,
    pub reason: RewindUnsafeReason,
    pub operation_count: u32,
    pub tool_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Why a file cannot be restored by a code rewind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewindUnsafeReason {
    /// The checkpoint references a snapshot that is gone.
    CheckpointMissing,
    /// The checkpoint artifact cannot be parsed.
    CheckpointUnreadable,
    /// The file changed on disk after ZCode edited it.
    ExternalModified,
    /// Reading the current content failed.
    FileReadFailed,
    /// The checkpoint content cannot be turned into a restore plan.
    UnsupportedCheckpoint,
}

/// Fork: the files the turn opened by one typed user message changed, answering the App's
/// per-turn summary query (Node `v4/conversation/fileChanges`): per-path counts with the writes'
/// diff hunks, plus whether the turn's checkpoints were already restored by a summary rewind.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TurnFileChanges {
    /// Per path, sorted by path.
    pub items: Vec<TurnFileItem>,
    /// True when every checkpoint of the turn was already restored.
    pub reverted: bool,
}

/// One path's summary inside [`TurnFileChanges`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnFileItem {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
    /// How many checkpoint writes touched the path in this turn.
    pub write_count: u32,
    /// Distinct tools that wrote it, sorted; empty when the checkpoints record no name.
    pub tool_names: Vec<String>,
    /// The writes' hunks in write order, shaped like the App's `readonlyDiffHunkSchema`
    /// (`{oldStart, oldLines, newStart, newLines, lines}`).
    pub patches: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Submit {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<ArtifactRef>,
        delivery: Delivery,
    },
    Interrupt,
    /// 进程要退出（修复线 F38，docs/specs/rust-cli/session-lifecycle.md §3.5）：以 [`crate::abort::AbortReason::Shutdown`]
    /// 中止在跑的回合（之后这个回合不再记录），此后不再开回合。没有回合在跑时也 `Accepted`。
    Shutdown,
    /// esc 撤回刚发的输入（修复线 F38，session-lifecycle.md §5.5）：空闲、队列为空、
    /// 最后一条可选的人类输入之后没有回答时，对话回退到它之前（与 `Rewind{conversation}` 同一个 `session.revert`）。
    /// 回执是 [`CommandResult::Restored`]（这条输入，前端放回输入框）。条件不满足时 `Rejected`。
    RestoreCancelled,
    ResolveInteraction {
        interaction: InteractionId,
        answer: crate::interaction::Answer,
    },
    SetModel {
        selection: ModelSelection,
    },
    /// 改权限模式（plan 开关不变）；`Plan` 是旧写法，只打开 plan（修复线 F20，shell-permissions.md §4.6）。
    SetMode {
        mode: PermissionMode,
    },
    /// 打开或关掉 plan 开关，权限模式不变（修复线 F20，TUI 的 `/plan`；Node `setExecutionState({planEnabled})`）。
    SetPlan {
        enabled: bool,
    },
    Compact {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        instructions: Option<String>,
    },
    /// Fork (desktop App): an input submitted with its own execution state (Node `sendText`,
    /// `sendGoalCommand`, `compact`). Idle: the session first commits `execution` (model, mode, plan)
    /// through the same facts as [`Command::SetModel`] / [`Command::SetMode`] / [`Command::SetPlan`],
    /// then starts the turn, or the compaction for [`QueuedKind::Compact`]. Busy: the input is queued
    /// with `execution` frozen on it, and the session's state is left alone until the item drains.
    /// A compaction is refused with [`COMPACT_LOCKED`] while one runs or is queued. Non-empty
    /// `content` is the input's blocks (attachments); `text` is then its display text.
    /// `behind_held`: idle with a held queue that has inputs, the input joins the queue tail instead of
    /// starting (Node `compact` "held queue → append to the tail"; a queue promotion passes false).
    SubmitWith {
        kind: QueuedKind,
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        content: Vec<crate::message::ContentBlock>,
        delivery: Delivery,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution: Option<InputExecution>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        behind_held: bool,
    },
    /// Fork (desktop App): the permission dialog's "Full access" (Node `fullAccess`): the session's
    /// permission mode becomes bypass and every queued input's frozen mode too; plan switches are
    /// kept. The pending ask itself is answered separately. `interaction` is the ask that granted it
    /// (Node `config.permissionGrant`, [`crate::session_api_events::KernelEvent::PermissionGranted`]).
    GrantFullAccess {
        interaction: String,
    },
    /// Fork (desktop App): Node `pauseGoal`: an active goal becomes paused (persisted as a
    /// `goal_status` attachment), then the running turn is aborted. No active goal: a no-op.
    PauseGoal,
    /// Fork (desktop App): Node `resumeGoal`: a paused goal becomes active and a continuation turn
    /// starts. Rejected while a turn runs ([`GOAL_ACTIVE_TURN`]) or with plan on
    /// ([`GOAL_PLAN_EXCLUSIVE`]); no paused goal: a no-op.
    ResumeGoal,
    Rewind {
        target: MessageId,
        scope: RewindScope,
    },
    /// Fork: restore only the checkpoints of the turn opened by `target` (the App's per-turn
    /// summary rewind, Node `applyFileRewind`): the conversation is not cut, and the turn's
    /// summary flips to reverted ([`KernelEvent::TurnFilesReverted`]). Rejected while busy or when
    /// the turn has no unrestored checkpoints; the reply waits for the transaction, like
    /// [`Command::Rewind`], and reports the restored files with `removed: 0`.
    RewindTurnFiles {
        target: MessageId,
    },
    /// 从 `at` 处分叉出新会话；回执是 [`CommandResult::Forked`]。
    Fork {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<MessageId>,
    },
    /// 用户改名（`/rename`，Node `setCustomSessionTitle`）：标题来源记为 `custom`，之后不再自动生成（docs/specs/rust-cli/titles.md §4）。
    Rename {
        title: String,
    },
    /// 同 [`Command::Rename`]，另带这次命令的记录（TUI 的 `/rename <名字>`，docs/specs/rust-cli/titles.md §4）：空闲时记录与
    /// 改名同一批提交，改名被拒绝时记录也不在；回合或压缩在跑时改名马上提交，记录在改名成功之后留到这次工作收尾
    /// （同 [`Command::RecordLocalCommand`]）。
    RenameRecorded {
        title: String,
        record: crate::user_command::LocalCommandRecord,
    },
    /// 不带参数的 `/rename`（docs/specs/rust-cli/titles.md §8）：会话 actor
    /// 用模型从对话起名，再按 `Rename` 写入。回执等名字：[`CommandResult::Renamed`]，
    /// 起不出名字时 `Rejected.reason` 是给用户看的文本。
    GenerateName,
    /// 带内容块的输入（文字加粘贴的图片，docs/specs/rust-cli/tui-input.md §3）：回合与 [`Command::Submit`]
    /// 相同，输入消息的内容就是这些块；UPS、标题与斜杠展开只看文字块。
    SubmitContent {
        content: Vec<crate::message::ContentBlock>,
        delivery: Delivery,
    },
    /// bash 模式的输入（`!命令`，tui-input.md §2）：会话经 [`crate::user_input::UserInputs::bash`] 执行，
    /// 记下 `<bash-input>` 与输出两条 user 消息，再调模型。
    Bash {
        command: String,
        delivery: Delivery,
    },
    /// `/fork`（docs/specs/rust-cli/session-lifecycle.md §6.5，工作线 F75）：从一条可选的用户输入分出新会话，
    /// 新会话带到这一轮为止（这一轮最后一条 assistant），文件不动。只在空闲时接受；回执是 [`CommandResult::Forked`]
    /// （`through` 是复制到的那条消息，F78）。`input` 不是可选的输入时 `Rejected`。
    ForkFromInput {
        input: MessageId,
    },
    /// Fork from an assistant reply (Node `forkAssistant`, the row action of a turn opened by a notification): the
    /// new session carries the history through `assistant`. `assistant` must be a stored assistant reply (not the
    /// resume sentinel); a running turn's reply is refused (`Rejected`), like [`Command::ForkFromInput`].
    ForkFromAssistant {
        assistant: MessageId,
    },
    /// 批准或拒绝一条扣住的同伴消息（docs/specs/rust-cli/cross-session.md §2.4，F28）：`message` 是
    /// [`crate::peers::HeldPeerMessage::msg_id`]。已经解决（过期、改模式放行）时 `Rejected`。
    ResolvePeerMessage {
        message: String,
        approve: bool,
    },
    /// 停止会话里的一个后台任务（`/tasks`，docs/specs/rust-cli/tui-display.md §3.1）：与 TaskStop 工具同一条
    /// 停止路径。`task` 是 [`crate::manage::BackgroundEntry::id`]；回执是 [`CommandResult::Stopped`]，
    /// 找不到或不在跑时 `Rejected.reason` 是给用户看的文本。
    StopTask {
        task: String,
    },
    /// `/cd` 由会话 actor 判定（docs/specs/rust-cli/tui-manage.md §7.1，F1）：运行中 `Rejected`（固定的文字）；
    /// 否则回执是 [`CommandResult::Directory`]。移动时 actor 设 shell cwd、改工作区、
    /// 发 [`KernelEvent::WorkspaceChanged`]，给模型的说明（固定的说明文字加新目录的规则文件）由 actor 组成并提交。
    ChangeDirectory {
        root: crate::env::EnvPath,
    },
    /// Fork: the session runs in the execution worktree `root` from now on (desktop prepared-worktree activation,
    /// specs/fork-rust-agent-parity.md "Execution worktree"). Like [`Command::ChangeDirectory`] the actor sets the
    /// shell cwd and the workspace and emits [`KernelEvent::WorkspaceChanged`], but it commits no note: Node starts
    /// the runtime in the worktree, so the model sees no move. `Rejected` while a turn or compaction runs.
    SetExecutionRoot {
        root: crate::env::EnvPath,
    },
    /// Fork: the incognito profile a prepared execution worktree's activation freezes (specs/fork-rust-agent-parity.md,
    /// "Incognito sessions"). The actor's meta takes it while it has none, so a fork of the session keeps it; the same
    /// profile again is `Accepted`, another one `Rejected`. Sent after [`Kernel::freeze_incognito`] and before
    /// [`Command::SetExecutionRoot`] releases the held SessionStart.
    SetIncognito {
        profile: crate::incognito::IncognitoProfile,
    },
    /// 同 [`Command::ChangeDirectory`]，移动成功时 `record` 与说明文字同一批、排在它之前提交（修复线 L-A，
    /// docs/specs/rust-cli/tui-manage.md §11.2：对照实现的 `/cd` 先记命令输入与输出，说明文字是之后的 meta 消息）。
    ChangeDirectoryRecorded {
        root: crate::env::EnvPath,
        record: crate::user_command::LocalCommandRecord,
    },
    /// 本地命令写进对话的记录（修复线 L-A，docs/specs/rust-cli/tui-manage.md §11）：空闲时马上提交一批；回合或压缩在跑时
    /// 留到它收尾、开下一个回合之前提交。总是 `Accepted`（提交失败只记日志）。
    RecordLocalCommand {
        record: crate::user_command::LocalCommandRecord,
    },
    /// 把这个会话在跑的前台 Bash 转到后台（修复线 L-A，docs/specs/rust-cli/tui-input.md §11）：用户的转后台键
    /// （`User`），或低延迟投递的输入（`DeliverMessage`）。会话 actor 交给本机的执行环境；总是 `Accepted`：没有回合在跑
    /// 时是 [`CommandResult::Done`]，否则是 [`CommandResult::Backgrounded`]（转了的个数）。
    BackgroundForeground {
        reason: crate::env_command::BackgroundReason,
    },
    /// 把续写时补在内存里、还没落库的 assistant（`No response requested.`，docs/specs/rust-cli/session-lifecycle.md
    /// §6.3.1，工作线 F79；有补给未结调用的中断结果时一起，§6.3，工作线 F81）现在单独提交一批。交互界面在会话里切到这个会话（`/resume`、`/fork`）之后发：切过去就算换了
    /// 对话。没有要写的（没有补、已经写过、被回退掉）时什么都不做，回执是 `Accepted`；提交失败时 `Rejected`，它留到下一批
    /// 带消息的提交。
    StoreResumeSentinel,
    /// 取回还在排队的输入（query.md §4.4）：`command` 是提交它的 [`CommandEnvelope::id`]。在队列里时出队（`QueueChanged`）、`Accepted`；已经发出（开了回合或并入了回合）时 `Rejected`，`reason` 给用户看。
    Dequeue {
        command: CommandId,
    },
    /// Replace the text of an input that is still queued, keeping its place and delivery (Node `editQueueItem`).
    /// Rejected with the same reason as [`Command::Dequeue`] when the input already started a turn or was
    /// merged into one.
    EditQueued {
        command: CommandId,
        text: String,
    },
    /// Move a queued input before another queued input, or to the end of the queue when `before` is `None`
    /// (Node `reorderQueueItem`). Rejected with the same reason as [`Command::Dequeue`] when either input is
    /// no longer queued.
    ReorderQueued {
        command: CommandId,
        before: Option<CommandId>,
    },
    /// Pause or resume the automatic drain of the queue (Node `setAutoDrain`; `held` is `!autoDrain`). While
    /// held, a finished turn does not start the next queued input; releasing the hold while idle starts the
    /// head of the queue, as a turn end would. Always `Accepted`; every change emits `QueueChanged` once.
    HoldQueue {
        held: bool,
    },
    /// Fork: the foreground promotion lease (Node `acquireForegroundPromotionLease`, `send-now:`/`sendQueuedNow`). While
    /// reserved, nothing starts a turn on its own (queued inputs, background notices, cron): the caller interrupts the
    /// running turn and submits the promoted input to the idle session. Releasing while idle resumes the drain as a turn
    /// end would. Unlike [`Command::HoldQueue`] it is not the user's `autoDrain` and emits no `QueueChanged`. Always
    /// `Accepted`.
    ReserveForeground {
        reserved: bool,
    },
}

/// 带 ID 的命令；同一个 ID 重复提交时返回 [`Ack::Duplicate`]，不重复执行。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandEnvelope {
    pub id: CommandId,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Ack {
    Accepted {
        #[serde(default, skip_serializing_if = "CommandResult::is_done")]
        result: CommandResult,
    },
    Duplicate,
    Rejected {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CreateSession {
    /// 第二阶段由 Host 给出会话 ID；为空时内核生成。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<SessionId>,
    pub workspace: WorkspaceRef,
    pub selection: ModelSelection,
    /// 权限模式；`Plan` 是旧写法（plan 开、default）。
    pub mode: PermissionMode,
    /// plan 开关（修复线 F20；serde 缺省 false）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
    /// Fork: the incognito profile, frozen into the new row (specs/fork-rust-agent-parity.md, "Incognito sessions").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incognito: Option<crate::incognito::IncognitoProfile>,
}

/// 会话的当前视图（前端重连或首次打开时用）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionView {
    pub meta: SessionMeta,
    /// 显示用的历史：冷读取时是只供显示的压缩点之前的消息（[`crate::store::LoadedSession::earlier`]）接上会话 actor 的
    /// 历史（工作线 F102，docs/specs/rust-cli/compact.md §5.1）。要模型侧的那一段时取 [`crate::history::active`]。
    pub messages: Vec<Message>,
    pub selection: ModelSelection,
    /// 权限模式（修复线 F20 起不会是 `Plan`）。
    pub mode: PermissionMode,
    /// plan 开关（修复线 F20；serde 缺省 false）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub plan: bool,
    pub pending: Vec<(InteractionId, InteractionRequest)>,
    pub queue: Vec<QueuedInput>,
    pub last_seq: u64,
    /// `last_seq` 时的状态 revision（缺口 G1，同 [`SequencedEvent::revision`]；serde 缺省 0）。
    #[serde(default)]
    pub revision: u64,
    /// 有回合正在运行。
    #[serde(default)]
    pub running: bool,
    /// Fork: the running turn's id (the actor's own turn, else the mirrored subagent run's), so a projection rebuilt
    /// while it runs keys that turn like the events that follow. `None` when idle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running_turn: Option<crate::ids::TurnId>,
    /// 执行环境里还没有处理完的后台命令（`ShellState::background`）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub background: Vec<ShellTaskId>,
    /// 扣住、等用户批准的同伴消息（cross-session.md §2.4，F28；serde 缺省为空）。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub peer_held: Vec<crate::peers::HeldPeerMessage>,
    /// 上下文用量（token、有效窗口）：会话 actor 按当前历史与模型经 `Compactor::context_usage` 算（compact.md §2.1、
    /// tui-display.md §2.6，修复线 F27；子代理的快照由 agents 按子会话同样算，F112）；压缩模块不知道时为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<crate::compaction::ContextOccupancy>,
    /// 上下文快满的提示（同一处算，F27）：冷加载后不用等下一条回复。
    #[serde(default)]
    pub context_notice: crate::compaction::ContextNotice,
    /// 本进程里最近一个完成的主回合请求（子代理的快照是子代理请求，F112）的输出速度（F105）：只在内存里，冷打开的为空。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_speed: Option<crate::metering::OutputSpeed>,
    /// Fork: the command that submitted each typed user message (`anchor.sourceCommandId`), so a cold projection can
    /// put `sourceCommandId` on its rows after an agent restart. Empty when unknown.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub commands: std::collections::BTreeMap<MessageId, CommandId>,
    /// Fork: per-turn file-change summaries for the projection (the App's turn header
    /// `fileChanges`), keyed by the typed user message that opened the turn. Filled by the session
    /// actor from its checkpoints; empty for sessions without file writes.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub turn_files: std::collections::BTreeMap<MessageId, TurnFileFacts>,
    /// Fork: the desktop goal state (Node snapshot `goal`); None without a goal or outside the
    /// desktop App.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal: Option<crate::goal::GoalState>,
    /// Fork: the model each assistant message ran on (stored, or recorded at commit), so a cold projection draws Node's
    /// model switch dividers between turns. Empty when unknown.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub message_models: std::collections::BTreeMap<MessageId, crate::model::ModelSelection>,
}

/// The command id prefix of the input a SessionStart hook gives (`initial_user_message`): it is not typed input, so
/// it is no evidence that a client's first input was admitted (fork prepared-worktree activation).
pub const SESSION_START_INPUT: &str = "session-start-";

/// Fork: `Command::ResumeGoal` while a turn runs (Node reason `activeTurn`).
pub const GOAL_ACTIVE_TURN: &str = "activeTurn";
/// Fork: `Command::ResumeGoal` with plan on (Node `guard.planGoalMutuallyExclusive`).
pub const GOAL_PLAN_EXCLUSIVE: &str = "guard.planGoalMutuallyExclusive";

/// One turn's file summary carried in [`SessionView::turn_files`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnFileFacts {
    /// Per path, sorted by path.
    pub files: Vec<TurnFileCount>,
    /// The turn's checkpoints can be rewound (they were when they settled).
    pub rewindable: bool,
    /// Every checkpoint of the turn was already restored.
    pub reverted: bool,
}

/// One path's counts inside [`SessionView::turn_files`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnFileCount {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

// 内核事件与回合结局放在分出的文件里（800 行上限，工作线 F131；路径与名字不变）。
#[path = "session_api_events.rs"]
mod events;
pub use events::{
    FileChange, InputExecution, KernelEvent, NoticeLevel, QueuedInput, QueuedKind, SequencedEvent,
    TurnOutcome,
};

// 命令的结果放在分出的文件里（800 行上限，工作线 F134）。
#[path = "session_api_results.rs"]
mod results;
pub use results::{CommandResult, Forked, RewoundFile};

// 会话生命周期的类型（SessionStart / SessionEnd 的来源、rewind 选择器的条目）放在分出的文件里（400 行上限，
// L24 合并后拆出；路径与名字不变）。
#[path = "session_api_lifecycle.rs"]
mod lifecycle;
pub use lifecycle::{EndReason, RewindOption, StartSource};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum KernelError {
    #[error("session not found: {session}")]
    NotFound { session: SessionId },
    #[error("{message}")]
    Failed { message: String },
    #[error("not implemented: {what}")]
    Unsupported { what: String },
}

/// 一个打开着的会话（前端经它发命令、订阅事件、取快照）。
///
/// 方法都没有缺省体（工作线 F134，审查 K6）：以前 9 个缺省 `Unsupported` 或空实现只服务测试替身。测试替身用
/// `testing::HandleOverride`（只写 ID、命令、订阅与视图，其余是中性的缺省）。
#[async_trait]
pub trait SessionHandle: Send + Sync {
    fn id(&self) -> &SessionId;

    async fn send(&self, command: CommandEnvelope) -> Ack;

    /// 订阅 `after` 之后的事件；`after` 为空时从当前位置开始。
    fn subscribe(&self, after: Option<u64>) -> BoxStream<'static, SequencedEvent>;

    async fn view(&self) -> Result<SessionView, KernelError>;

    /// 前端离开会话时调用：运行 SessionEnd hook，返回只给用户看的提示（失败的 hook）。
    async fn close(&self, reason: EndReason) -> Vec<String>;

    /// rewind 选择器的条目（活动历史里可选的 user 消息，按顺序）。
    async fn rewind_options(&self) -> Result<Vec<RewindOption>, KernelError>;

    /// Fork: what a code rewind to `target` would restore and which files conflicts block, computed
    /// without changing anything (Node's file rewind preview).
    async fn rewind_preview(&self, target: &MessageId) -> Result<RewindPreview, KernelError>;

    /// Fork: the files the turn opened by the typed user message `turn_input` changed (the App's
    /// per-turn "N files changed" summary query, Node `v4/conversation/fileChanges`). The actor
    /// picks the turn's unrestored checkpoints; the artifact reads run in the caller's task.
    async fn turn_file_changes(
        &self,
        turn_input: &MessageId,
    ) -> Result<TurnFileChanges, KernelError>;

    /// Fork: what restoring only that turn's own checkpoints would do (the App's per-turn
    /// `v4/conversation/fileRewindPreview`), computed without changing anything.
    async fn turn_rewind_preview(
        &self,
        turn_input: &MessageId,
    ) -> Result<RewindPreview, KernelError>;

    /// `/goal` 面板的数据：会话 actor 的当前目标与最近一次达成的结果（docs/specs/rust-cli/goal.md §6.2）。
    async fn goal(&self) -> Result<crate::goal::GoalView, KernelError>;

    /// 会话里还在跑的后台命令与后台子代理（`/tasks` 与 footer 的计数，tui-display.md §2.3、§3.1）。
    async fn background_tasks(&self) -> Result<Vec<crate::manage::BackgroundEntry>, KernelError>;

    /// 这个顶层会话里本进程启动过的子代理（含嵌套的），按启动顺序（tui-panels.md §1.1，L30）。
    async fn subagents(&self) -> Result<Vec<crate::panels::SubagentEntry>, KernelError>;

    /// 子代理的状态有变化时产生一项（多次变化可能合并成一项）；收到后重取 [`SessionHandle::tasks_snapshot`]
    /// （修复线 F34）。
    fn subagent_changes(&self) -> BoxStream<'static, ()>;

    /// Fork: the run feed of one of this session's subagent child sessions ([`crate::agents::AgentSignals::child_run`]),
    /// read by the App's telemetry facts. None when the kernel keeps no live runs (the TUI).
    fn child_run(&self, _child: &SessionId) -> Option<crate::agents::ChildLiveFeed> {
        None
    }

    /// 子代理列表与后台任务的同一份快照（修复线 F34，tui-panels.md §0、§3.1）：一次查询、一次回执。前端在子代理的变化
    /// 通知与后台任务相关的事件之后都重取它，不再分别取 [`SessionHandle::subagents`] 与
    /// [`SessionHandle::background_tasks`]。
    async fn tasks_snapshot(&self) -> Result<crate::panels::TasksSnapshot, KernelError>;

    /// 子代理的只读快照：子会话里已提交的消息；`running` 是它是否在跑（tui-panels.md §1.4）。
    async fn subagent_view(&self, agent: &AgentId) -> Result<SessionView, KernelError>;

    /// 一个后台命令的详情（Shell 详情，tui-panels.md §3.3）；不认识时为 None。
    async fn shell_detail(
        &self,
        task: &str,
    ) -> Result<Option<crate::panels::ShellDetail>, KernelError>;

    /// Fork: a background Bash command's output window (the desktop detail pane); None when this session has
    /// no such Bash command or output file.
    async fn background_bash_output(
        &self,
        task: &str,
    ) -> Result<Option<crate::panels::BashOutputRead>, KernelError>;
}

#[async_trait]
pub trait Kernel: Send + Sync {
    async fn create_session(&self, request: CreateSession) -> Result<SessionId, KernelError>;

    async fn open_session(
        &self,
        session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError>;

    async fn list_sessions(
        &self,
        filter: SessionFilter,
    ) -> Result<Vec<SessionSummary>, KernelError>;

    /// 同 [`Kernel::create_session`]，另给 SessionStart 的来源（`/clear` 之后的新会话是 `Clear`）。
    async fn create_session_as(
        &self,
        request: CreateSession,
        _source: StartSource,
    ) -> Result<SessionId, KernelError> {
        self.create_session(request).await
    }

    /// Fork: a new session that runs in an execution worktree from its first moment (specs/fork-rust-agent-parity.md
    /// "Execution worktree"). `request.workspace` is the stored workspace the session is listed under; the worktree
    /// is stored before the session starts, so SessionStart and every turn run in it. A kernel without it refuses.
    async fn create_session_in_worktree(
        &self,
        _request: CreateSession,
        _worktree: crate::env::EnvPath,
        _branch: Option<String>,
    ) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "execution worktree sessions".to_owned(),
        })
    }

    /// Fork: a new session reserved for a prepared execution worktree (specs/fork-rust-agent-parity.md "Execution
    /// worktree"). It is listed under `request.workspace`; SessionStart waits for `Command::SetExecutionRoot`, so
    /// the hook runs in the worktree at activation, as Node starts the runtime there. A kernel without it refuses.
    async fn create_prepared_session(
        &self,
        _request: CreateSession,
    ) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "prepared worktree sessions".to_owned(),
        })
    }

    /// Fork: freezes the incognito profile of a prepared execution worktree at its activation
    /// (specs/fork-rust-agent-parity.md, "Incognito sessions"): the row's `fork_incognito` once, then the in-memory
    /// profile every gate reads, before the activation releases SessionStart or admits the first input. A row that
    /// holds another profile, or a store that cannot hold one, fails it. A kernel without it refuses.
    async fn freeze_incognito(
        &self,
        _session: &SessionId,
        _profile: crate::incognito::IncognitoProfile,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "incognito profiles".to_owned(),
        })
    }

    /// Fork: opens a stored session whose prepared execution worktree is not active yet (an agent restart before the
    /// activation): SessionStart waits for `Command::SetExecutionRoot`, as after [`Kernel::create_prepared_session`],
    /// so the hook never runs in the parent checkout. A session already open keeps its state. A kernel without it
    /// refuses.
    async fn open_prepared_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        Err(KernelError::Unsupported {
            what: "prepared worktree sessions".to_owned(),
        })
    }

    /// 同 [`Kernel::open_session`]，另给 SessionStart 的来源（刚 fork 出的会话是 `Fork`）。
    /// 会话已经打开时来源不起作用。
    async fn open_session_as(
        &self,
        session: &SessionId,
        _source: StartSource,
    ) -> Result<Arc<dyn SessionHandle>, KernelError> {
        self.open_session(session).await
    }

    /// 上下文用量（`/context`，docs/specs/rust-cli/context-usage.md）：只读，不改会话。
    async fn context_usage(
        &self,
        _query: crate::context_usage::ContextUsageQuery,
    ) -> Result<crate::context_usage::ContextUsage, KernelError> {
        Err(KernelError::Unsupported {
            what: "context usage".to_owned(),
        })
    }

    /// `@` 补全的文件清单（docs/specs/rust-cli/tui-input.md §1.2）：相对 shell 当前目录的文件路径。
    async fn workspace_files(
        &self,
        _workspace: &crate::env::WorkspaceRef,
    ) -> Result<Vec<String>, KernelError> {
        Err(KernelError::Unsupported {
            what: "workspace files".to_owned(),
        })
    }

    /// Fork (desktop App): the Composer skill reference catalog of this workspace. Default: none.
    async fn skill_references(
        &self,
        _workspace: &crate::env::WorkspaceRef,
    ) -> Vec<crate::user_command::SkillReference> {
        Vec::new()
    }

    /// 这个工作区里用户可调用的斜杠命令（skill，TUI 的补全；ext.md §2.7，L22）。默认没有。
    async fn user_commands(
        &self,
        _workspace: &crate::env::WorkspaceRef,
    ) -> Vec<crate::user_command::UserCommand> {
        Vec::new()
    }

    /// MCP 服务器的状态（`/mcp`、`/status`，tui-display.md §3.4，L28）。默认没有。
    async fn mcp_servers(&self) -> Vec<crate::manage::McpServerInfo> {
        Vec::new()
    }

    /// `/plan open`（tui-manage.md §8，L29）：会话的计划文件位置，以及它是否有内容。
    async fn plan_file(
        &self,
        _query: crate::manage::PlanFileQuery,
    ) -> Result<crate::manage::PlanFile, KernelError> {
        Err(KernelError::Unsupported {
            what: "plan file".to_owned(),
        })
    }

    /// `/cd <path>`（tui-manage.md §7，L29）：解析与检查路径；有会话时经会话 actor 换工作目录。错误是给用户看的
    /// 文字（`Failed`）。
    async fn change_directory(
        &self,
        _request: crate::manage::ChangeDirectory,
    ) -> Result<crate::manage::DirectoryChanged, KernelError> {
        Err(KernelError::Unsupported {
            what: "changing the working directory".to_owned(),
        })
    }

    /// `/mcp reconnect|enable|disable`（tui-manage.md §6，L29）：经 ext 的连接管理改连接，返回这些服务器
    /// 改动后的状态。默认 `Unsupported`。
    async fn mcp_control(
        &self,
        _control: crate::manage::McpControl,
    ) -> Result<Vec<crate::manage::McpServerInfo>, KernelError> {
        Err(KernelError::Unsupported {
            what: "MCP server control".to_owned(),
        })
    }

    /// 当前生效的 hook 配置（`/hooks`，tui-display.md §3.5，L28）：只读。默认没有。
    async fn hooks(&self) -> Vec<crate::manage::HookEntry> {
        Vec::new()
    }

    /// `/diff` 的未提交改动（tui-manage.md §4，L29）：执行环境里 git 的原始输出。
    async fn uncommitted_diff(
        &self,
        _workspace: &crate::env::WorkspaceRef,
    ) -> Result<crate::env_git::GitDiff, KernelError> {
        Err(KernelError::Unsupported {
            what: "uncommitted diff".to_owned(),
        })
    }

    /// `/export <文件名>`（tui-manage.md §3，L29）：经执行环境写文件，返回写入的绝对路径。
    async fn write_export(&self, _file: crate::manage::ExportFile) -> Result<String, KernelError> {
        Err(KernelError::Unsupported {
            what: "exporting the conversation".to_owned(),
        })
    }

    /// `/permissions` 的规则列表（tui-manage.md §1.1，L29）：规则快照、本机项目规则集（现读）与会话规则。
    async fn permission_rules(
        &self,
        _query: crate::permission::PermissionRulesQuery,
    ) -> Result<Vec<crate::permission::SourcedRule>, KernelError> {
        Err(KernelError::Unsupported {
            what: "permission rules".to_owned(),
        })
    }

    /// `/permissions` 的修改（tui-manage.md §1.1）：落库后换上新的规则快照，返回修改后的列表。
    async fn change_permission_rules(
        &self,
        _change: crate::permission::PermissionRulesChange,
    ) -> Result<Vec<crate::permission::SourcedRule>, KernelError> {
        Err(KernelError::Unsupported {
            what: "changing permission rules".to_owned(),
        })
    }

    /// 存储的只读查询与前端记录（审查 K7：`/usage` 的 API 时长、footer 的请求统计、App 的命令事实）：前端直接问存储，
    /// 不经会话 actor。以前是 4 个透传的方法（`session_metering`、`request_stats`、`put_session_record`、
    /// `session_records`）。
    fn queries(&self) -> Arc<dyn crate::store::StoreQueries>;

    /// Fork: the artifact store of this kernel's sessions (the App attachment upload stores prompt attachments in it).
    /// Kernels without one return `None` and the attachment methods report `fault.attachment.putUnsupported`.
    fn artifacts(&self) -> Option<Arc<dyn crate::store::ArtifactStore>> {
        None
    }

    /// 活动统计（`/stats`，usage.md §5）：今天与时区偏移取自内核的时钟，聚合在存储。默认 `Unsupported`。
    async fn activity(
        &self,
        _range: crate::metering::ActivityRange,
    ) -> Result<crate::metering::ActivityStats, KernelError> {
        Err(KernelError::Unsupported {
            what: "activity stats".to_owned(),
        })
    }

    /// ← 项目页与 `/resume` 页的会话（修复线 F29，tui-panels.md §2.1）：存储的查询加本进程里打开着的会话的
    /// 实时状态与目录的分支。默认 `Unsupported`。
    async fn project_sessions(
        &self,
        _query: crate::store::SessionQuery,
    ) -> Result<crate::panels::ProjectSessions, KernelError> {
        Err(KernelError::Unsupported {
            what: "project sessions".to_owned(),
        })
    }

    /// 写现在的会话的现场（tui-cockpit.md §4）；跨会话关闭时什么也不做。
    async fn set_presence(&self, _session: &SessionId, _presence: crate::peers::PeerPresence) {}

    /// 让别的进程中止在跑的回合（tui-cockpit.md §1.3）。
    async fn stop_peer(&self, _address: &crate::peers::PeerAddress) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "stop peer".to_owned(),
        })
    }

    /// 给会话改名（F29，tui-manage.md §10.6）：打开着的经它的 actor（`Command::Rename`），否则直接写存储。
    async fn rename_session(
        &self,
        _session: &SessionId,
        _title: String,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "renaming sessions".to_owned(),
        })
    }

    /// 删除会话（F29，tui-manage.md §10.6）：打开着的拒绝（`Failed`），否则存储软删除。
    async fn delete_session(&self, _session: &SessionId) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "deleting sessions".to_owned(),
        })
    }

    /// Fork: the store erased these sessions (`session/eraseTree`, after their runtimes closed). The kernel stops what it
    /// still runs for them: the agents' notice forwarders, and on every machine their background commands and pending
    /// notices (`close_session` with `forget`), as Node's runtime close cancels them.
    async fn sessions_erased(&self, _sessions: Vec<SessionId>) {}

    /// Fork: the sessions among `sessions` that a running subagent runs in (`AgentSignals::running_agent_sessions`).
    /// `session/eraseTree` counts them as running and refuses the erase.
    fn running_agent_sessions(&self, _sessions: &[SessionId]) -> Vec<SessionId> {
        Vec::new()
    }

    /// 会话的只读快照（F29，`/resume` 页的预览与全屏对话）：打开着的问它的 actor，否则从存储冷加载；不打开会话、
    /// 不启动 actor、不跑 SessionStart。
    async fn session_snapshot(&self, _session: &SessionId) -> Result<SessionView, KernelError> {
        Err(KernelError::Unsupported {
            what: "session snapshots".to_owned(),
        })
    }

    /// 会话可用的工具、agent 与 skill（`-p` 的 stream-json 写 `system/init`，docs/specs/rust-cli/headless.md §3.3，
    /// 修复线 F39）：只读。默认 `Unsupported`。
    async fn session_catalog(
        &self,
        _query: crate::catalog::CatalogQuery,
    ) -> Result<crate::catalog::SessionCatalog, KernelError> {
        Err(KernelError::Unsupported {
            what: "session catalog".to_owned(),
        })
    }

    /// 工作区的 agent 类型（agents.md §8 的 PT 增量）：不要会话，顺序同 agent 目录。缺省空。
    async fn agent_definitions(&self, _workspace: &WorkspaceRef) -> Vec<crate::catalog::AgentInfo> {
        Vec::new()
    }

    /// 旧会话的询问（docs/specs/rust-cli/agents.md §4.1.2，工作线 F72）：先给出还没回答的，再给出之后的变化。缺省
    /// 没有（流不结束）。
    fn detached_asks(&self) -> BoxStream<'static, crate::interaction::DetachedEvent> {
        futures_util::stream::pending().boxed()
    }

    /// 回答旧会话的询问（回答同 [`Command::ResolveInteraction`]）。缺省 `Unsupported`。
    async fn resolve_detached(
        &self,
        _interaction: &InteractionId,
        _answer: crate::interaction::Answer,
    ) -> Result<(), KernelError> {
        Err(KernelError::Unsupported {
            what: "answering questions of closed sessions".to_owned(),
        })
    }

    /// 工作区的会话（与 [`Kernel::list_sessions`] 同一个来源），合并本进程里打开着的会话的实时状态
    /// （← 面板，tui-panels.md §2.1，L30）。默认没有实时状态。
    async fn workspace_sessions(
        &self,
        filter: SessionFilter,
    ) -> Result<Vec<crate::panels::WorkspaceSession>, KernelError> {
        Ok(self
            .list_sessions(filter)
            .await?
            .into_iter()
            .map(|summary| crate::panels::WorkspaceSession {
                summary,
                activity: None,
                last_reply: None,
            })
            .collect())
    }
}

#[path = "session_view.rs"]
mod view;
