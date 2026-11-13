//! 会话 actor 的循环：命令、主循环的提交请求、回合收尾都在这一个任务里按序处理（会话状态的
//! 唯一 owner）。回合内的逻辑见 [`crate::turn`]。

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use rust_cli_base::Task;
use rust_cli_kernel_api::abort::{Abort, AbortReason};
use rust_cli_kernel_api::agents::AgentSignal;
use rust_cli_kernel_api::ids::{CommandId, InteractionId, MessageId, RunId, ToolUseId, TurnId};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::orchestration::{
    InteractionAnswer, InteractionRequest, OrchestrationError, QueryError, QueryStop,
};
use rust_cli_kernel_api::run_ledger::RunLedger;
use rust_cli_kernel_api::session_api::{
    Ack, Command, CommandEnvelope, CommandResult, KernelEvent, QueuedInput, SessionView,
};
use rust_cli_kernel_api::store::{Fact, SessionMeta, StoreError, WorkspaceCheckpoint};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::SessionDeps;
use crate::agent_signals::AgentStream;
use crate::cron::CronStream;
use crate::log::EventLog;
use crate::notices::{Notices, next_notice};
use crate::sink::SinkRequest;
use crate::title::{TitleState, title_done};
use crate::turn::TurnInput;

pub(crate) enum Request {
    Command {
        envelope: CommandEnvelope,
        reply: oneshot::Sender<Ack>,
    },
    View {
        reply: oneshot::Sender<SessionView>,
    },
    Meta {
        reply: oneshot::Sender<SessionMeta>,
    },
    /// Fork: the meta for SessionEnd, `None` while SessionStart is still held (a prepared execution worktree that
    /// was never activated: Node has no runtime for it, so nothing ends).
    EndMeta {
        reply: oneshot::Sender<Option<SessionMeta>>,
    },
    RewindOptions {
        reply: oneshot::Sender<crate::rewind::Snapshot>,
    },
    /// Fork: a dry-run preview of a code rewind (Node's file rewind preview): the actor only picks
    /// the same machine groups `Command::Rewind{Code}` would run; artifact reads and the hash check
    /// happen in the caller's task — nothing is prepared or applied.
    RewindPreview {
        target: MessageId,
        reply: oneshot::Sender<Result<crate::rewind::Preview, String>>,
    },
    /// Fork: the files the turn opened by `turn_input` changed (the App's per-turn summary query):
    /// the actor picks the turn's unrestored checkpoints (or reports the turn already reverted);
    /// the artifact reads and the per-path summary run in the caller's task.
    TurnFileChanges {
        turn_input: MessageId,
        reply: oneshot::Sender<Result<crate::turn_files::Files, String>>,
    },
    /// Fork: a dry-run preview of restoring only that turn's checkpoints (the App's per-turn
    /// `fileRewindPreview`): the actor picks the machine groups over the turn's own checkpoints;
    /// reads and the hash check happen in the caller's task.
    TurnRewindPreview {
        turn_input: MessageId,
        reply: oneshot::Sender<Result<crate::rewind::Preview, String>>,
    },
    Goal {
        reply: oneshot::Sender<rust_cli_kernel_api::goal::GoalView>,
    },
    /// 关闭会话（`SessionHandle::close`）：中止前台工作，等它收尾后回复并退出（spec §3.3）。`reason` 是中止在跑的
    /// 回合用的原因：退出是 `Shutdown`，`/clear`、`/resume` 是 `User`（修复线 F38）。
    Close {
        reply: oneshot::Sender<()>,
        reason: AbortReason,
    },
    /// 会话级的询问（`Interactions::lasting`，agents.md §4.1.1）：不属于哪个回合，回合结束与中断都不取消它。
    Ask {
        request: InteractionRequest,
        reply: oneshot::Sender<Result<InteractionAnswer, OrchestrationError>>,
    },
    /// 撤回会话级的询问（工具被取消；与 `Ask` 走同一个通道，所以总排在它的 `Ask` 之后）。
    CancelAsk {
        tool_use: ToolUseId,
    },
}

/// 待回答的交互属于谁：回合里的询问随回合结束取消；会话级的询问只随会话关闭取消。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AskScope {
    Turn,
    Session,
}

/// 不属于回合的后台工作（SessionStart、代码回退）的结果，回到 actor 后才提交（spec §2）。
pub(crate) enum JobDone {
    Startup(Box<rust_cli_kernel_api::hooks::HookOutcome>),
    Rewind(Box<crate::rewind::Finished>),
    /// Fork: the per-turn summary rewind (`Command::RewindTurnFiles`).
    TurnFilesRewound(Box<crate::rewind::TurnRewound>),
    /// Fork (desktop App): a goal completion verification (goal_verify.rs).
    GoalVerified(Box<crate::goal_verify::Outcome>),
}

pub(crate) struct Job {
    pub(crate) task: Task<JobDone>,
    /// SessionStart 可以被中断；回退事务不能中途放弃，不取消。
    pub(crate) cancel: Option<CancellationToken>,
}

/// 等待用户回答的交互（只在内存：进程退出后无法再回答，不落库，D4）。
pub(crate) struct Pending {
    pub(crate) id: InteractionId,
    pub(crate) request: InteractionRequest,
    pub(crate) reply: oneshot::Sender<Result<InteractionAnswer, OrchestrationError>>,
    /// 权限询问的 Notification 计时；交互被回答或取消（丢弃）时取消。
    pub(crate) _notify: Option<tokio_util::sync::DropGuard>,
    pub(crate) scope: AskScope,
}

pub(crate) struct Running {
    pub(crate) turn: TurnId,
    /// 这次运行（主循环的回合）；压缩没有（它的子循环自己取）。会话标题的请求用它（工作线 F64）。
    pub(crate) run: Option<RunId>,
    pub(crate) abort: Abort,
    pub(crate) requests: mpsc::Receiver<SinkRequest>,
    pub(crate) task: Task<Result<QueryStop, QueryError>>,
    /// 提交失败的原因；有值时本回合以失败收尾，之后的提交一律拒绝。
    pub(crate) failure: Option<StoreError>,
    /// 开启本回合的 user 消息：checkpoint 的 `messageId`（spec §4.2）。
    pub(crate) prompt: Option<MessageId>,
    /// 开启本回合的命令；提交 `prompt` 时写进批次（Node `anchor.sourceCommandId`）。
    pub(crate) command: Option<CommandId>,
    /// 回合结束那一行的计时（修复线 F118，duration.rs）。
    pub(crate) timing: crate::duration::TurnTiming,
    /// Fork: the limits the input that opened this turn set (automation id, hidden tools); they end with the turn.
    pub(crate) limits: rust_cli_kernel_api::turn_limits::TurnLimits,
}

enum Next {
    Request(Request),
    Sink(Option<SinkRequest>),
    Notice(rust_cli_kernel_api::machine_notices::MachineNotice),
    Agent(AgentSignal),
    /// Fork: a mirrored child-run event; `None` when its live stream ended.
    ChildLive(Option<rust_cli_kernel_api::agents::ChildLive>),
    Cron,
    Job(Result<JobDone, rust_cli_base::TaskError>),
    Title(crate::title::TitleDone),
    Name(Result<Option<String>, rust_cli_base::TaskError>),
    /// 跨会话的入站（消息或回执，cross-session.md §2.4）。
    Peer(rust_cli_kernel_api::peers::PeerSignal),
    /// 扣住的消息里最早的到期时刻到了（醒来后按时钟判断）。
    PeerDeadline,
    /// Monitor 的输出事件与截止时刻（工作线 F83，monitors.rs）。
    Monitor(
        rust_cli_kernel_api::ids::ShellTaskId,
        Result<rust_cli_kernel_api::env::CommandEvent, rust_cli_kernel_api::env::EnvError>,
    ),
    MonitorDue,
}

/// 正在运行的回合的提交请求；没有回合时一直等。
async fn sink_request(running: &mut Option<Running>) -> Option<SinkRequest> {
    match running {
        Some(running) => running.requests.recv().await,
        None => std::future::pending().await,
    }
}

/// 后台工作的结果；没有时一直等。
async fn job_done(job: &mut Option<Job>) -> Result<JobDone, rust_cli_base::TaskError> {
    match job {
        Some(job) => (&mut job.task).await,
        None => std::future::pending().await,
    }
}

pub(crate) struct Actor {
    pub(crate) deps: SessionDeps,
    pub(crate) log: Arc<EventLog>,
    pub(crate) meta: SessionMeta,
    /// Fork: where `meta.title` came from; changed only with it ([`Actor::set_title`]).
    pub(crate) title_source: rust_cli_kernel_api::title::Source,
    /// Fork (B3): the interaction of the last permission mode grant (the stored receipt, then each grant), in the view
    /// as the composer's adoption key (Node `lastPermissionGrantId`).
    pub(crate) permission_grant: Option<String>,
    pub(crate) messages: Vec<Message>,
    /// 冷读取时只供显示的、最后一个压缩点之前的消息（工作线 F102，compact.md §5.1）：打开后不变，只进 `view()`。
    /// 模型侧的一切（主循环、压缩、token、标题、rewind、fork、goal 与任务的恢复）只看 `messages`。另一个只读的读者：
    /// 打开时旧会话的跨会话 entry 在这里按文字找一次是否并入过（peer_restore.rs，F139）。
    pub(crate) earlier: Vec<Message>,
    /// Fork: the command that submitted each typed user message, loaded with the session and extended by
    /// [`Self::commit`]; only [`Self::view`] reads it (cold rows' `sourceCommandId`).
    pub(crate) commands: std::collections::BTreeMap<MessageId, CommandId>,
    /// Fork: the model of each assistant message, loaded with the session and extended by [`Self::commit`]; only
    /// [`Self::view`] reads it (the cold model switch divider).
    pub(crate) message_models: std::collections::BTreeMap<MessageId, ModelSelection>,
    pub(crate) selection: ModelSelection,
    /// 执行状态：权限模式 × plan 开关（修复线 F20，shell-permissions.md §4.6）。判决用的模式是 [`Self::mode`]。
    pub(crate) execution: rust_cli_kernel_api::permission::ExecutionState,
    /// 计划模式的两个会话标志（已退出计划模式、待发退出提示）：与 `mode` 同一个
    /// owner，改模式时更新，提交 reentry / exit 时清掉；不持久化（context.md §13.4）。
    pub(crate) plan_flags: rust_cli_kernel_api::plan::PlanModeFlags,
    /// 输入调度：排队的输入与 next 通道（插话输入与后台通知的到达顺序，优先级 `next`），一条输入只存一份（inbox.rs，
    /// 工作线 F130）。
    pub(crate) inbox: crate::inbox::Inbox,
    /// 已从任务表取走、还没开回合的定时任务（排在通道与 `Queue` 输入之后）。
    pub(crate) cron_fires: VecDeque<rust_cli_kernel_api::cron::CronFire>,
    pub(crate) pending: Vec<Pending>,
    pub(crate) running: Option<Running>,
    /// Fork: the limits of the turn about to launch, set from the starting input's execution and taken by
    /// [`Self::launch`]; cleared after every start attempt so no other turn inherits them.
    pub(crate) next_limits: rust_cli_kernel_api::turn_limits::TurnLimits,
    pub(crate) job: Option<Job>,
    /// 没有被代码回退撤销的 checkpoint，按写入顺序（spec §4）。
    pub(crate) checkpoints: Vec<WorkspaceCheckpoint>,
    /// Fork: per-turn file summaries keyed by the typed user message that opened the turn
    /// (the App's turn header `fileChanges`): updated as checkpoints settle and are restored,
    /// rebuilt from the stored artifacts on a cold open ([`crate::turn_files`]). Only `view`
    /// reads it.
    pub(crate) turn_files: std::collections::HashMap<MessageId, crate::turn_files::TurnFileSummary>,
    /// 提交核心（kernel-api `RunLedger`，与子代理的 sink 同一份，工作线 F130）：当前轮（随每个批次交给存储，node-store.md
    /// §4，修复线 F6；冷加载时取 `LoadedSession.turn`）、工具已结束而结果还没提交的 checkpoint 与子代理关联。只在
    /// [`Self::commit`] 与提交消息时改。
    pub(crate) ledger: RunLedger,
    /// 历史被改写的次数（`HistoryRewritten.generation`）。
    pub(crate) generation: u64,
    /// 会话标题的生成（title.rs）与不带参数的 `/rename` 的起名任务（rename.rs）。
    pub(crate) titles: TitleState,
    /// `/loop` 哨兵展开的状态（loop_tick.rs）：不持久化，主线程压缩后清空。
    pub(crate) loop_ticks: crate::loop_tick::LoopTicks,
    pub(crate) naming: Option<crate::rename::NameJob>,
    /// `/goal` 的目标（goal.rs）：提交 `goal_status` 后才改，冷加载从活动历史恢复。
    pub(crate) goal: crate::goal::Goals,
    /// Fork (desktop App): the goal row last written to the store (`crate::goal::stored_form`).
    pub(crate) goal_written: Option<rust_cli_kernel_api::goal::GoalState>,
    /// Fork (desktop App): a turn ended; the next sync writes the row again (its last-seen time).
    pub(crate) goal_touched: bool,
    /// Fork: the session was opened from the store and its `session_input` ledger is not swept yet (input_ledger.rs).
    pub(crate) ledger_resume: bool,
    /// Fork (desktop App): the running goal completion verification (its job is `job`).
    pub(crate) goal_verify: Option<crate::goal_verify::Pending>,
    /// 回合或压缩在跑时到达的本地命令记录（修复线 L-A，local_record.rs）：收尾后按到达顺序提交。
    pub(crate) held_records: Vec<rust_cli_kernel_api::user_command::LocalCommandRecord>,
    seen: HashSet<CommandId>,
    /// 续写时补在内存里、还没落库的消息，按历史里的顺序：末尾未结调用的中断结果（session-lifecycle.md §6.3，工作线
    /// F81）与 `No response requested.`（§6.3.1，工作线 F77）。第一批带消息的提交把它们排在最前面，成功后清掉；
    /// `StoreResumeSentinel` 把它们单独提交（F79）。只在 `commit` 与 `store_resume_sentinel` 里改。
    pub(crate) resume_pending: Vec<MessageId>,
    /// 正在关闭：前台工作收尾后回复它并退出循环；期间不开新回合、不接新命令（spec §3.3）。
    pub(crate) closing: Option<oneshot::Sender<()>>,
    /// 收到了 `Shutdown`（进程要退出，修复线 F38，spec §3.5）：之后不再开回合。
    pub(crate) shutting_down: bool,
    stream: Notices,
    agent_stream: AgentStream,
    /// Fork (node_desktop): the mirrored live run of this child session's subagent (crate::child_live).
    pub(crate) mirror: crate::child_live::Mirror,
    cron_stream: CronStream,
    /// 跨会话的入站流与状态（peers.rs）。
    peer_stream: crate::watched::Watched<rust_cli_kernel_api::peers::PeerSignal>,
    pub(crate) peers: crate::peers::PeerState,
    /// Monitor 的切行、批、限流与终态的合成（工作线 F83，monitors.rs）：只在 actor 里。
    pub(crate) monitors: crate::monitors::Monitors,
    /// 最近一个完成的主回合请求的输出速度（footer 的 TPS，修复线 F105）：只在内存，冷打开时为空。
    pub(crate) output_speed: Option<rust_cli_kernel_api::metering::OutputSpeed>,
    /// 等后台子代理的起点（回合结束那一行，修复线 F118，duration.rs）：只在内存。
    pub(crate) wait_started: Option<u64>,
    /// 自己的请求通道（弱引用）：交给回合的输出端，给出会话级的询问入口；不让 actor 因此不退出。
    asks: mpsc::WeakSender<Request>,
    /// Fork: SessionStart held for a prepared execution worktree (`SessionState::start_held`) until
    /// `Command::SetExecutionRoot` moves the session (workspace.rs).
    pub(crate) deferred_start: Option<rust_cli_kernel_api::session_api::StartSource>,
    /// Fork: `SessionState::execution_worktree`; set by a successful `Command::SetExecutionRoot` (workspace.rs).
    pub(crate) execution_worktree: bool,
    /// The SessionStart result waiting for the first turn to write it (Node `pendingSessionStartContexts`, hooks.rs).
    /// Empty when there is none. Kept in memory only: a reopen runs SessionStart again.
    pub(crate) pending_session_start: Vec<Message>,
}

/// 拒绝的回执：原因是给前端的文字（存储的错误按它的原文）。
pub(crate) fn rejected(reason: impl std::fmt::Display) -> Ack {
    Ack::Rejected {
        reason: reason.to_string(),
    }
}

pub(crate) fn accepted() -> Ack {
    Ack::Accepted {
        result: CommandResult::Done,
    }
}

impl Actor {
    /// `resume_pending`：续写时补在内存里的消息（`resume::settle` 的中断结果与 `resume_sentinel::insert` 的占位，按
    /// 历史里的顺序），随第一批带消息的提交落库。
    pub(crate) fn new(
        deps: SessionDeps,
        log: Arc<EventLog>,
        state: crate::SessionState,
        asks: mpsc::WeakSender<Request>,
        resume_pending: Vec<MessageId>,
    ) -> Self {
        // 本机与连上的远端机器的通知（R3，remote-exec.md §20.7.2）。
        // Fork: a subagent's child session does not subscribe: the agents crate forwarder is the only consumer of its
        // notices (agents.md §5.2), and only the agents crate runs turns there. A second subscriber raced the forwarder
        // for the ack and, when it won, started its own turn next to the agent's run (specs/fork-rust-agent-parity.md,
        // "Subagent child sessions: one owner for background-command notices").
        let stream = if state.meta.kind == rust_cli_kernel_api::store::SessionKind::Subagent {
            Notices::idle()
        } else {
            Notices::new(rust_cli_kernel_api::machine_notices::all_shell_notices(
                deps.machines.clone(),
                state.meta.id.clone(),
            ))
        };
        let agent_stream = AgentStream::new(deps.agents.signals(&state.meta.id));
        let cron_stream = CronStream::new(deps.cron.wakeups(&state.meta.id));
        let peer_stream = crate::watched::Watched::new(deps.peers.port.signals(&state.meta.id));
        let (start, defer_start, execution_worktree) =
            (state.start, state.start_held, state.execution_worktree);
        let child_live = state.child_live;
        let goal = crate::goal::Goals::restore(
            &state.messages,
            deps.clock.now_ms(),
            state.goal_target.as_ref(),
            &state.goal_verifications,
        );
        let goal_written = goal.state().map(crate::goal::stored_form);
        let mut actor = Self {
            deps,
            log,
            permission_grant: state.permission_grant,
            title_source: state
                .title_source
                .unwrap_or_else(|| rust_cli_kernel_api::title::Source::derived(&state.meta.title)),
            meta: state.meta,
            messages: state.messages,
            earlier: state.earlier,
            commands: state.commands,
            message_models: state.message_models,
            selection: state.selection,
            execution: state.mode,
            plan_flags: Default::default(),
            inbox: crate::inbox::Inbox::default(),
            cron_fires: VecDeque::new(),
            pending: Vec::new(),
            running: None,
            next_limits: Default::default(),
            job: None,
            checkpoints: state.checkpoints,
            turn_files: std::collections::HashMap::new(),
            ledger: RunLedger::new(state.turn),
            generation: 0,
            titles: TitleState::new(state.title_pending),
            loop_ticks: Default::default(),
            naming: None,
            goal,
            goal_written,
            goal_touched: false,
            ledger_resume: start == rust_cli_kernel_api::session_api::StartSource::Resume,
            goal_verify: None,
            held_records: Vec::new(),
            seen: HashSet::new(),
            resume_pending,
            closing: None,
            shutting_down: false,
            stream,
            agent_stream,
            mirror: crate::child_live::Mirror::new(child_live),
            cron_stream,
            peer_stream,
            peers: crate::peers::PeerState::default(),
            monitors: crate::monitors::Monitors::default(),
            output_speed: None,
            wait_started: None,
            asks,
            deferred_start: None,
            pending_session_start: Vec::new(),
            execution_worktree,
        };
        if defer_start {
            actor.deferred_start = Some(start);
        } else {
            actor.start_session(start);
        }
        actor
    }

    /// 回合（或命令、压缩）的输出端：请求经 `sender` 交给 actor；会话级的询问入口经自己的请求通道。
    pub(crate) fn sink(&self, sender: mpsc::Sender<SinkRequest>) -> crate::sink::ActorSink {
        crate::sink::ActorSink {
            sender,
            asks: self.asks.clone(),
            session: self.meta.id.clone(),
            detached: self.deps.detached.clone(),
        }
    }

    /// 有回合或后台工作在跑：新输入排队，回退 / fork 拒绝。
    /// The user's model choice (`Command::SetModel`, or a submitted input's frozen selection).
    pub(crate) async fn select_model(
        &mut self,
        command: Option<CommandId>,
        selection: rust_cli_kernel_api::model::ModelSelection,
    ) -> Result<(), StoreError> {
        let fact = Fact::ModelSelected {
            selection: selection.clone(),
        };
        self.commit(command, vec![fact]).await?;
        self.selection = selection.clone();
        self.log.append(KernelEvent::ModelChanged { selection });
        // F27：有效窗口随模型变，上下文提示与 footer 的 ctx 按新模型重算（按当前模型算）；修前要等下一条回复。
        self.context_changed();
        Ok(())
    }

    /// Fork: `Command::SubmitWith` (the desktop App's inputs). A compaction is refused while one runs
    /// (a run-less turn) or is queued; busy, the input is queued with its execution state frozen on it
    /// (a compaction or goal never steers); idle, the state is applied first and the turn or compaction
    /// starts. `behind_held` (idle behind a held queue with inputs) queues the input like busy does.
    #[allow(
        clippy::too_many_arguments,
        reason = "the fields of Command::SubmitWith"
    )]
    async fn submit_with(
        &mut self,
        id: CommandId,
        kind: rust_cli_kernel_api::session_api::QueuedKind,
        (text, intent): crate::steering::Typed,
        content: Vec<rust_cli_kernel_api::message::ContentBlock>,
        delivery: rust_cli_kernel_api::session_api::Delivery,
        execution: Option<rust_cli_kernel_api::session_api::InputExecution>,
        behind_held: bool,
    ) -> Ack {
        use rust_cli_kernel_api::session_api::{COMPACT_LOCKED, Delivery, QueuedKind};
        let compact = kind == QueuedKind::Compact;
        if compact {
            let compacting = self
                .running
                .as_ref()
                .is_some_and(|running| running.run.is_none());
            if compacting || self.inbox.has_compact() {
                return rejected(COMPACT_LOCKED);
            }
        }
        if self.busy() || behind_held {
            let (input_kind, delivery) = match kind {
                QueuedKind::Compact => (crate::inbox::InputKind::Compact, Delivery::Queue),
                QueuedKind::Goal => (crate::inbox::InputKind::Text, Delivery::Queue),
                QueuedKind::Text if !content.is_empty() => {
                    (crate::inbox::InputKind::Content(content), Delivery::Queue)
                }
                QueuedKind::Text => (crate::inbox::InputKind::Text, delivery),
            };
            self.inbox.push_input(
                QueuedInput {
                    edit_lock: None,
                    intent,
                    command: id,
                    text,
                    delivery,
                    kind,
                    execution,
                },
                input_kind,
            );
            self.emit_queue();
            // The admission's real outcome (Node `started.admission.kind === "queued"`): the App's ACK says `queue`.
            return Ack::Accepted {
                result: CommandResult::Queued,
            };
        }
        self.next_limits = execution
            .as_ref()
            .map(|execution| execution.limits.clone())
            .unwrap_or_default();
        if let Some(execution) = execution
            && let Err(reason) = self.submitted_execution(execution).await
        {
            self.next_limits = Default::default();
            return rejected(reason);
        }
        if compact {
            // A compaction runs no turn: drop the limits so no later turn start takes them.
            self.next_limits = Default::default();
            return match self.start_compaction(id, None) {
                Ok(()) => accepted(),
                Err(reason) => rejected(reason),
            };
        }
        let input = if content.is_empty() {
            TurnInput::Human {
                command: id,
                text,
                screened: None,
                more: Vec::new(),
                intent,
            }
        } else {
            TurnInput::Content {
                command: id,
                content,
                intent,
            }
        };
        let started = self.start_turn(input).await;
        self.next_limits = Default::default();
        match started {
            Ok(()) => accepted(),
            Err(reason) => rejected(reason),
        }
    }

    pub(crate) fn busy(&self) -> bool {
        self.running.is_some() || self.job.is_some()
    }

    /// 登记里的状态：有待处理的交互时是等你，否则看在不在跑（tui-cockpit.md §4）。
    pub(crate) fn status_now(&self) -> rust_cli_kernel_api::peers::PeerStatus {
        use rust_cli_kernel_api::peers::PeerStatus;
        if !self.pending.is_empty() {
            PeerStatus::Waiting
        } else if self.busy() || self.mirror.running() {
            PeerStatus::Busy
        } else {
            PeerStatus::Idle
        }
    }

    pub(crate) async fn run(mut self, mut requests: mpsc::Receiver<Request>) {
        // 跨会话：绑定为主会话并从库里恢复（cross-session.md §2.2）；在处理第一条命令之前。
        self.peers_open().await;
        // Fork: on a cold open, rebuild the per-turn file summaries from the stored checkpoints
        // (the previous process's `FileChanges` events are gone).
        self.restore_turn_files().await;
        self.resume_input_ledger().await;
        loop {
            // 修复（R1-1）：以前这里在“所有句柄都已释放”（`recv` 返回 None）时退出，但内核的会话表一直持有
            // 句柄，这个分支永远到不了——关闭后 actor 还活着，收到后台通知就自己开回合。现在由 `Request::Close`
            // 显式关闭：前台工作收尾后在这里退出。句柄只在会话表释放作用域之后才会全部释放，那时 actor 已被中止，
            // 所以 `recv` 的 None 不需要分支（`Some` 模式不匹配时 select! 只是停用这一支）。
            if !self.busy()
                && let Some(reply) = self.closing.take()
            {
                self.peers_close().await;
                let _ = reply.send(());
                return;
            }
            let now_ms = self.deps.clock.now_ms();
            let monitor_due = self.monitors.next_deadline();
            let next = tokio::select! {
                Some(request) = requests.recv() => Next::Request(request),
                request = sink_request(&mut self.running) => Next::Sink(request),
                notice = next_notice(&mut self.stream) => Next::Notice(notice),
                signal = self.agent_stream.next() => Next::Agent(signal),
                event = crate::child_live::next(&mut self.mirror) => Next::ChildLive(event),
                () = self.cron_stream.next() => Next::Cron,
                done = job_done(&mut self.job) => Next::Job(done),
                done = title_done(&mut self.titles) => Next::Title(done),
                done = crate::rename::name_done(&mut self.naming) => Next::Name(done),
                signal = self.peer_stream.next() => Next::Peer(signal),
                () = crate::peers::deadline(&self.peers, now_ms) => Next::PeerDeadline,
                (task, event) = crate::monitors::next_event(&mut self.monitors) => Next::Monitor(task, event),
                () = crate::monitors::deadline(monitor_due, now_ms) => Next::MonitorDue,
            };
            match next {
                Next::Request(request) => self.handle(request).await,
                Next::Sink(Some(request)) => self.on_sink(request).await,
                Next::Notice(notice) => self.on_notice(notice).await,
                Next::Agent(signal) => self.on_agent_signal(signal).await,
                Next::ChildLive(event) => self.on_child_live_next(event).await,
                Next::Cron => self.on_cron_wakeup().await,
                Next::Job(done) => self.on_job(done).await,
                Next::Title(done) => self.on_title(done).await,
                Next::Name(result) => self.on_name(result).await,
                Next::Peer(signal) => self.on_peer_signal(signal).await,
                Next::PeerDeadline => self.peers_expire(true).await,
                Next::Monitor(task, event) => self.on_monitor_event(task, event).await,
                Next::MonitorDue => self.on_monitor_due().await,
                // 主循环的输出端已全部释放：它已经返回，收尾本回合。
                Next::Sink(None) => self.finish_turn().await,
            }
            // 登记里的状态只看 actor 自己的状态，变化时才写（cross-session.md §2.1）。
            self.peer_status(self.status_now()).await;
            self.goal_target_sync().await;
            self.input_ledger_sync().await;
        }
    }

    async fn handle(&mut self, request: Request) {
        match request {
            Request::View { reply } => {
                let _ = reply.send(self.view().await);
                self.attach_child_live();
            }
            Request::Meta { reply } => {
                let _ = reply.send(self.meta.clone());
            }
            Request::EndMeta { reply } => {
                let _ = reply.send(self.deferred_start.is_none().then(|| self.meta.clone()));
            }
            Request::RewindOptions { reply } => {
                let _ = reply.send(self.rewind_snapshot());
            }
            Request::RewindPreview { target, reply } => {
                let _ = reply.send(self.rewind_preview(&target));
            }
            Request::TurnFileChanges { turn_input, reply } => {
                let _ = reply.send(Ok(self.turn_files_snapshot(&turn_input)));
            }
            Request::TurnRewindPreview { turn_input, reply } => {
                let _ = reply.send(self.turn_rewind_preview(&turn_input));
            }
            Request::Goal { reply } => {
                let _ = reply.send(self.goal_view());
            }
            Request::Close { reply, reason } => self.close(reply, reason).await,
            // 关闭中、要退出时不再登记询问：丢下回复，询问方按会话已关闭处理。
            Request::Ask { reply, .. } if self.closing.is_some() || self.shutting_down => {
                drop(reply);
            }
            Request::Ask { request, reply } => self.ask(request, reply, AskScope::Session),
            Request::CancelAsk { tool_use } => self.cancel_ask(&tool_use),
            // 关闭中不接新命令：会话即将退出。
            Request::Command { reply, .. } if self.closing.is_some() => {
                let _ = reply.send(rejected("the session is closed"));
            }
            Request::Command { envelope, reply } => {
                if !self.seen.insert(envelope.id.clone()) {
                    let _ = reply.send(Ack::Duplicate);
                    return;
                }
                // Fork: the release lease is held (`Command::ReserveRelease`): the session is about to close.
                if self.inbox.releasing()
                    && !matches!(envelope.command, Command::ReserveRelease { .. })
                {
                    let _ = reply.send(rejected(
                        rust_cli_kernel_api::session_api::SESSION_RELEASING,
                    ));
                    return;
                }
                if self.mirror.running() && crate::child_live::starts_turn(&envelope.command) {
                    let _ =
                        reply.send(rejected(rust_cli_kernel_api::session_api::GOAL_ACTIVE_TURN));
                    return;
                }
                // 代码回退的回执要等事务结束（spec §5.1），起名的回执要等名字（titles.md §8.2）。
                match envelope.command {
                    Command::Rewind { target, scope } => {
                        return self.rewind(envelope.id, target, scope, reply).await;
                    }
                    Command::RewindTurnFiles { target } => {
                        return self.rewind_turn_files(envelope.id, target, reply).await;
                    }
                    Command::GenerateName => return self.generate_name(envelope.id, reply),
                    _ => {}
                }
                let ack = self.command(envelope).await;
                let _ = reply.send(ack);
            }
        }
    }

    async fn command(&mut self, envelope: CommandEnvelope) -> Ack {
        let CommandEnvelope { id, command } = envelope;
        match command {
            Command::Submit { text, delivery, .. } => {
                if self.busy() {
                    // 插话（Steer）进 next 通道，由主循环在下一个工具边界领取（steering.rs），其余等回合结束。
                    self.inbox.push_input(
                        QueuedInput {
                            edit_lock: None,
                            intent: None,
                            command: id,
                            text,
                            delivery,
                            kind: Default::default(),
                            execution: None,
                        },
                        crate::inbox::InputKind::Text,
                    );
                    self.emit_queue();
                    return accepted();
                }
                match self
                    .start_turn(TurnInput::Human {
                        command: id,
                        text,
                        screened: None,
                        more: Vec::new(),
                        intent: None,
                    })
                    .await
                {
                    Ok(()) => accepted(),
                    Err(reason) => rejected(reason),
                }
            }
            Command::Interrupt => self.interrupt().await,
            Command::Shutdown => self.shutdown().await,
            Command::RestoreCancelled => self.restore_cancelled(id).await,
            Command::ResolveInteraction {
                interaction,
                answer,
            } => self.resolve(id, interaction, answer).await,
            Command::SetModel { selection } => match self.select_model(Some(id), selection).await {
                Ok(()) => accepted(),
                Err(reason) => rejected(reason),
            },
            Command::SubmitWith {
                intent,
                kind,
                text,
                content,
                delivery,
                execution,
                behind_held,
                lease,
            } => {
                // Fork: while a promotion owns the foreground only its own input starts; any other is queued like
                // busy (Node's admission sees `hasActiveOrQueuedTurnWork` while a promotion lease exists).
                let foreign = self
                    .inbox
                    .foreground_owner()
                    .is_some_and(|owner| lease.as_deref() != Some(owner));
                let queue =
                    foreign || (behind_held && self.inbox.held() && self.inbox.has_inputs());
                self.submit_with(
                    id,
                    kind,
                    (text, intent),
                    content,
                    delivery,
                    execution,
                    queue,
                )
                .await
            }
            Command::PauseGoal => self.pause_goal().await,
            Command::ResumeGoal => self.resume_goal().await,
            Command::GrantPermissionMode { interaction, mode } => {
                self.grant_permission_mode(id, InteractionId::new(interaction), mode)
                    .await
            }
            Command::SetMode { mode } => match self.user_mode(id, mode).await {
                Ok(()) => accepted(),
                Err(reason) => rejected(reason),
            },
            Command::SetPlan { enabled } => match self.user_plan(id, enabled).await {
                Ok(()) => accepted(),
                Err(reason) => rejected(reason),
            },
            Command::Compact { instructions } => match self.start_compaction(id, instructions) {
                Ok(()) => accepted(),
                Err(reason) => rejected(reason),
            },
            Command::Fork { at } => self.fork(id, at).await,
            Command::ForkFromInput { input } => self.fork_from_input(input).await,
            Command::ForkFromAssistant { assistant } => self.fork_from_assistant(assistant).await,
            Command::AdoptTitle { title } => {
                self.adopt_title(title);
                accepted()
            }
            Command::DisableTitleGeneration => {
                self.titles.disable();
                accepted()
            }
            Command::Rename { title } => self.rename(id, title, None).await,
            Command::RenameRecorded { title, record } => self.rename(id, title, Some(record)).await,
            Command::StopTask { task } => self.stop_task(task).await,
            Command::StopSubagent { agent, execution } => {
                self.stop_subagent(agent, execution).await
            }
            Command::ResolvePeerMessage { message, approve } => {
                match self.resolve_peer(&message, approve).await {
                    Ok(()) => accepted(),
                    Err(reason) => rejected(reason),
                }
            }
            Command::ChangeDirectory { root } => self.change_directory(id, root, None).await,
            Command::SetExecutionRoot { root } => self.set_execution_root(root).await,
            Command::SetIncognito { profile } => self.set_incognito(profile),
            Command::ChangeDirectoryRecorded { root, record } => {
                self.change_directory(id, root, Some(record)).await
            }
            Command::RecordLocalCommand { record } => self.record_local_command(id, record).await,
            Command::BackgroundForeground { reason } => self.background_foreground(reason).await,
            Command::StoreResumeSentinel => self.store_resume_sentinel(id).await,
            Command::Dequeue { command } => self.dequeue(&command),
            Command::ClearQueued { command } => self.clear_queued(&command),
            // Fork: in-place queue editing (Node queue.ts handlers, specs/fork-rust-agent-parity.md).
            Command::EditQueued { command, edit } => self.edit_queued(&command, edit).await,
            Command::LockQueuedEdit { command, lock } => self.lock_queued_edit(&command, lock),
            Command::ReleaseQueuedEdit { command } => self.release_queued_edit(&command).await,
            Command::ApplyQueuedConfig { commands, edit } => {
                self.apply_queued_config(&commands, &edit)
            }
            Command::ReorderQueued { command, before } => {
                self.reorder_queued(&command, before.as_ref())
            }
            Command::HoldQueue { held } => self.hold_queue(held).await,
            Command::ReserveForeground { reserved, lease } => {
                self.reserve_foreground(reserved, lease).await
            }
            Command::ReserveRelease { reserved, lease } => {
                self.reserve_release(reserved, lease).await
            }
            // 在 `handle` 里处理（回执要等事务结束或名字）。
            Command::Rewind { .. } | Command::RewindTurnFiles { .. } | Command::GenerateName => {
                rejected("this command is handled by the actor loop")
            }
            Command::Bash {
                command: line,
                delivery: _,
            } => {
                self.bash_command(id, line);
                accepted()
            }
            Command::SubmitContent {
                content,
                delivery: _,
            } => match self.content_command(id, content).await {
                Ok(()) => accepted(),
                Err(reason) => rejected(reason),
            },
        }
    }

    async fn on_job(&mut self, done: Result<JobDone, rust_cli_base::TaskError>) {
        self.job = None;
        match done {
            Ok(JobDone::Startup(outcome)) => self.finish_startup(*outcome).await,
            Ok(JobDone::Rewind(finished)) => self.finish_rewind(*finished).await,
            Ok(JobDone::TurnFilesRewound(finished)) => self.finish_turn_rewind(*finished).await,
            Ok(JobDone::GoalVerified(outcome)) => {
                self.finish_goal_verification(Some(*outcome)).await
            }
            Err(error) if self.goal_verify.is_some() => {
                tracing::warn!(%error, "the goal verification job ended without a result");
                self.finish_goal_verification(None).await;
            }
            Err(error) => {
                tracing::warn!(%error, "a session job ended without a result");
                self.start_next().await;
            }
        }
    }

    pub(crate) fn emit_queue(&self) {
        self.log.append(KernelEvent::QueueChanged {
            items: self.inbox.queued(),
        });
    }

    async fn view(&self) -> SessionView {
        SessionView {
            plan: self.execution.plan,
            pending: self
                .pending
                .iter()
                .map(|pending| (pending.id.clone(), pending.request.clone()))
                .collect(),
            queue: self.inbox.queued(),
            last_seq: self.log.last_seq(),
            revision: self.log.revision(),
            running: self.running.is_some() || self.mirror.running(),
            running_turn: self
                .running
                .as_ref()
                .map(|running| running.turn.clone())
                .or_else(|| self.mirror.turn().cloned()),
            background: [self.background().await, self.background_agents().await].concat(),
            peer_held: self.peers.views(),
            // 冷加载后不用等下一条回复（F27）：与 `context_changed` 同样两个函数。
            context_usage: self.context_occupancy(),
            context_notice: self.context_notice().unwrap_or_default(),
            output_speed: self.output_speed,
            commands: self.commands.clone(),
            message_models: self.message_models.clone(),
            // Fork: only turns still in the conversation carry a summary (a cut removes its rows).
            turn_files: self
                .turn_files
                .iter()
                .filter(|(prompt, _)| self.messages.iter().any(|m| m.id() == *prompt))
                .map(|(prompt, summary)| (prompt.clone(), summary.facts()))
                .collect(),
            goal: self.goal_state(),
            title_source: Some(self.title_source),
            permission_grant: self.permission_grant.clone(),
            ..SessionView::new(
                self.meta.clone(),
                [self.earlier.as_slice(), self.messages.as_slice()].concat(),
                self.selection.clone(),
                self.execution.mode,
            )
        }
    }
}

#[cfg(test)]
#[path = "turn_anchor_tests.rs"]
mod turn_anchor_tests;
