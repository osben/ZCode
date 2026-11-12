//! 本进程里启动过的子代理（ListAgents、SendMessage、TaskStop 与后台列表都查这里）。
//!
//! 子代理的消息只在子会话里（存储是唯一事实源）；这里只记身份、归属、运行状态与邮箱。发给子代理的
//! 通知也记在这里它自己的条目上（docs/specs/rust-cli/agents.md §5.1），不另起状态源。

use rust_cli_base::sync::LockUnpoisoned;
use std::collections::BTreeMap;
use std::ops::{Deref, DerefMut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use rust_cli_kernel_api::abort::{Abort, AbortReason};
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::env_shell::BackgroundStatus;
use rust_cli_kernel_api::ids::{AgentId, MachineName, SessionId, ToolUseId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;

use crate::definitions::AgentDefinition;
use crate::doing::Doing;
use crate::report::{Ending, Report};
use crate::routes::{Routes, Started};

/// 发给某个子代理的一条通知：它派生的后台子代理结束了。
#[derive(Debug, Clone)]
pub(crate) struct Notice {
    pub(crate) from: AgentId,
    pub(crate) status: BackgroundStatus,
    /// `<task-notification>` 信封（不带说明与包装）。
    pub(crate) envelope: String,
}

/// 邮箱里的一项：SendMessage 的消息在工具边界作为插话并入，通知作为 `task-notification` 并入。
#[derive(Debug, Clone)]
pub(crate) enum Mail {
    Message(String),
    Notice(Notice),
}

#[derive(Debug, Clone)]
pub(crate) enum AgentState {
    /// 正在跑；`mailbox` 在下一个工具边界并入。
    Running {
        abort: Abort,
        mailbox: Vec<Mail>,
    },
    /// 跑完了，但还有在跑的后台子代理、monitor 或没交给它的后台命令（keepalive，只在交互模式，agents.md §5.1 第 3 条）。
    /// 记着最后一次运行的报告（被 TaskStop 停止、收尾时的通知用它）与自己的通知送过没有：只为后台子代理与 monitor
    /// 停放时推迟（`false`），只为命令停放时已经送出（`true`，§5.2 第 5 条）。
    Parked {
        report: Report,
        notified: bool,
    },
    Finished(Ending),
}

#[derive(Debug, Clone)]
pub(crate) struct LiveAgent {
    pub(crate) agent: AgentId,
    pub(crate) child: SessionId,
    /// 启动它的会话。
    pub(crate) parent: SessionId,
    /// 顶层会话：任务清单、链路 ID 与“送顶层会话”的通知用它。
    pub(crate) root: SessionId,
    /// 派生它的子代理；主线程派生的没有（通知送 `root`）。
    pub(crate) owner: Option<AgentId>,
    /// 主线程派生的是 1，每往下一层加 1（Agent 工具只给深度小于 3 的子代理）。
    pub(crate) depth: u32,
    /// 启动它的 Agent 调用；SendMessage 留下的消息续跑之后为 None（续跑不属于哪次工具调用，通知里
    /// 没有 `<tool-use-id>`，A8）。
    pub(crate) tool_use: Option<ToolUseId>,
    pub(crate) description: String,
    /// 定义（含 system prompt 正文）共享一份：条目每次被查询、快照都要复制（修复线 F6，审查 R5-11）。
    pub(crate) definition: Arc<AgentDefinition>,
    pub(crate) workspace: WorkspaceRef,
    /// Fork: `workspace` is the spawning session's execution worktree (its `RunView::execution_worktree`).
    pub(crate) execution_worktree: bool,
    /// 子代理的工具缺省在哪台机器上跑（Agent 的 `machine`，R3，remote-exec.md §20.6）。
    pub(crate) machine: MachineName,
    pub(crate) selection: ModelSelection,
    pub(crate) mode: PermissionMode,
    pub(crate) background: bool,
    /// 父会话的会话级询问入口（交互界面里才有，agents.md §4.1.1）：后台运行（含续跑、停放后的唤醒）经它询问。
    pub(crate) asks: Option<crate::child::Asks>,
    pub(crate) state: AgentState,
    /// 列表显示用的记录（tui-panels.md §1.1）；由 `live::Live` 在每次改动后统一维护。
    pub(crate) shown: Shown,
    /// 转发任务已经交给它的命令通知的来源（命令的任务 ID，agents.md §5.2 第 5 条）：在交出的同一把锁里记。命令通知交出
    /// 之后才 ack，这一段里执行环境的 `shell_state` 还列着它；收尾判断“还有没交给它的命令”时去掉这些。
    pub(crate) delivered: Vec<AgentId>,
    /// fork 子代理继承的前缀（修复线 L-A，agents.md §8.1.3）：不落库，续跑时拼在子会话的冷读取之前；别的子代理为 None。
    pub(crate) fork_prefix: Option<Arc<Vec<rust_cli_kernel_api::message::Message>>>,
    /// Fork: the running agent was stopped by the user (desktop `cancelBackgroundWork`), not by TaskStop: its
    /// notification reads Node's `was stopped by user` (core `completion-notification.ts`). Cleared by each restart.
    pub(crate) stopped_by_user: bool,
    /// Fork: its child session was erased while it was live (`routing::end_erased`). Its ending reaches only an owner
    /// that is not erased itself, never a Hub (an erased top-level session's Hub has no reader).
    pub(crate) erased: bool,
    /// Fork: SendMessage messages that arrived after a stop claimed this run (Node: a message to a killed agent resumes
    /// it, core `runner.ts`). The run's own mailbox messages are dropped with the stop, as upstream does; these resume
    /// it once the stopped run has settled (`routing::settle`), each with the SendMessage call that sent it: on the
    /// desktop the resumed run belongs to the first one (Node's notification carries its `<tool-use-id>`). Cleared by
    /// each new run.
    pub(crate) late_messages: Vec<(String, ToolUseId)>,
}

/// 列表显示用的记录：启动顺序、这次运行的开始与结束时刻、等待中的交互、子会话的提交次数、当前活动。
#[derive(Debug, Clone, Default)]
pub(crate) struct Shown {
    pub(crate) order: u64,
    pub(crate) started_ms: u64,
    pub(crate) ended_ms: Option<u64>,
    pub(crate) waiting: u32,
    pub(crate) version: u64,
    /// 当前活动与记下它的时刻（L35，stall-visibility.md §4.3）；离开运行时清掉。
    pub(crate) doing: Option<(Doing, u64)>,
    /// 最近一个完成的子代理请求的输出速度（修复线 F112，tui-panels.md §1.7：查看它时 footer 的 TPS）：只在内存里，
    /// 与主会话的速度同一个口径（tui-display.md §2.6）。续跑与结束都不清掉。
    pub(crate) speed: Option<rust_cli_kernel_api::metering::OutputSpeed>,
    /// Fork: which run this is (`SubagentEntry::execution`): 0 at spawn, plus one on every new run
    /// ([`LiveAgent::begin_run`]).
    pub(crate) execution: u64,
    /// Fork: how the previous run ended (`SubagentEntry::previous`), set by [`LiveAgent::begin_run`].
    pub(crate) previous: Option<rust_cli_kernel_api::panels::SubagentStatus>,
}

impl LiveAgent {
    pub(crate) fn status(&self) -> BackgroundStatus {
        match &self.state {
            // Fork: a claimed stop is the run's end already (Node takes `killed` synchronously, core `runner.ts`).
            AgentState::Running { .. } if self.stop_claimed() => BackgroundStatus::Killed,
            AgentState::Running { .. } => BackgroundStatus::Running,
            // 停放的子代理状态是 completed（带 keepalive）。
            AgentState::Parked { .. } => BackgroundStatus::Completed,
            AgentState::Finished(ending) => ending.status(),
        }
    }

    /// Fork: starts a new run (Node gives every resumed lifecycle a new execution id, core `runner.ts`). Every return
    /// to running goes through here, also the ones that replace a run ending in the same lock section (a stranded
    /// message or a leftover notice in `routing::settle`), which `settle_times` alone would not see as a new run.
    pub(crate) fn begin_run(&mut self, abort: Abort, mailbox: Vec<Mail>) {
        self.shown.previous = Some(crate::views::status(self));
        self.state = AgentState::Running { abort, mailbox };
        self.late_messages.clear();
        self.shown.execution += 1;
        // The previous run ended in this section when none was recorded: `settle_times` restarts the clock.
        self.shown.ended_ms.get_or_insert(0);
        self.shown.doing = None;
    }

    /// Fork (B2): the run is still running, but its abort is armed, so its ending is claimed: it ends as stopped
    /// (`routing::settle`). Every stop path (`Live::stop`, `Live::stop_execution`), SendMessage (`Live::enqueue`), the
    /// status and the subagent table read this one predicate, so a second stop is refused and the run leaves the
    /// running list at the claim, not at the settle.
    pub(crate) fn stop_claimed(&self) -> bool {
        matches!(&self.state, AgentState::Running { abort, .. } if abort.is_aborted())
    }

    /// 还在跑或停放。
    pub(crate) fn is_live(&self) -> bool {
        !matches!(self.state, AgentState::Finished(_))
    }
}

pub(crate) type Agents = BTreeMap<AgentId, LiveAgent>;

/// Fork: what the Live lock guards: the agents, and the registry of child-session notice forwarders that decides by
/// them (`routes`, specs/fork-rust-agent-parity.md, "After a restart, and on a remote executor").
#[derive(Default)]
pub(crate) struct State {
    agents: Agents,
    routes: Routes,
}

impl Deref for State {
    type Target = Agents;

    fn deref(&self) -> &Agents {
        &self.agents
    }
}

impl DerefMut for State {
    fn deref_mut(&mut self) -> &mut Agents {
        &mut self.agents
    }
}

pub(crate) struct Live {
    agents: Mutex<State>,
    clock: Arc<dyn Clock>,
    /// 启动顺序的计数（列表按它排序）。
    order: AtomicU64,
    /// 每次改动后加一（tokio watch：多次改动合并成一次通知，tui-panels.md §0）。
    changes: tokio::sync::watch::Sender<u64>,
}

impl Live {
    pub(crate) fn new(clock: Arc<dyn Clock>) -> Self {
        Self {
            agents: Mutex::default(),
            clock,
            order: AtomicU64::new(0),
            changes: tokio::sync::watch::channel(0).0,
        }
    }

    fn agents(&self) -> MutexGuard<'_, State> {
        self.agents.lock_unpoisoned()
    }

    /// 改动条目：锁里改完、记好时刻，放锁后再通知（订阅方收到通知后去查，一定看得到这次改动）。
    fn change<R>(&self, work: impl FnOnce(&mut Agents) -> R) -> R {
        self.change_routed(|agents, _| work(agents))
    }

    /// Fork: [`Self::change`] that also sees the forwarder registry. Every change ends with `Routes::reconcile` in the
    /// same section, so an agent's finish wakes the forwarder that it alone kept wanted.
    fn change_routed<R>(&self, work: impl FnOnce(&mut Agents, &mut Routes) -> R) -> R {
        let result = {
            let mut state = self.agents();
            let State { agents, routes } = &mut *state;
            let result = work(agents, routes);
            settle_times(agents, self.clock.now_ms());
            routes.reconcile(agents);
            result
        };
        self.changes
            .send_modify(|version| *version = version.wrapping_add(1));
        result
    }

    /// 变化通知的订阅（列表的查询方据此重取）。
    pub(crate) fn subscribe(&self) -> tokio::sync::watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Fork (node_desktop): resolves once run `execution` of `agent` has ended (finished, parked, gone, or a later run
    /// started: a message accepted after the stop resumes the agent in the same settle, Node runner `waitForStop`
    /// waits for this execution only). The run settles and routes its own notification under the same lock that ends
    /// it, so after this the notification is already in the owner's inbox.
    pub(crate) async fn left_running(&self, agent: &AgentId, execution: u64) {
        let mut changes = self.subscribe();
        loop {
            let running = self.agents().get(agent).is_some_and(|entry| {
                entry.shown.execution == execution
                    && matches!(entry.state, AgentState::Running { .. })
            });
            if !running || changes.changed().await.is_err() {
                return;
            }
        }
    }

    /// 顶层会话 `root` 里条目的快照与查询时刻（列表用）。先过滤再复制（修复线 F6，审查 R5-11：以前每次列表查询都复制
    /// 全部会话的全部条目）。
    pub(crate) fn snapshot_in(&self, root: &SessionId) -> (Vec<LiveAgent>, u64) {
        let agents: Vec<LiveAgent> = self
            .agents()
            .values()
            .filter(|agent| &agent.root == root)
            .cloned()
            .collect();
        (agents, self.clock.now_ms())
    }

    /// 在一把锁里读改（通知的路由要一次看清并改动几个条目，agents.md §5.1）。
    pub(crate) fn with<R>(&self, work: impl FnOnce(&mut Agents) -> R) -> R {
        self.change(work)
    }

    /// Fork: a delivery that decides by the forwarder registry ([`Self::with`] plus `routes`).
    pub(crate) fn with_routes<R>(&self, work: impl FnOnce(&mut Agents, &mut Routes) -> R) -> R {
        self.change_routed(work)
    }

    /// Fork: a registry transition (open, close, erase, claim, a forwarder's exit). It changes no agent, so it sends no
    /// change notice; it still reconciles in the same section.
    pub(crate) fn routes<R>(&self, work: impl FnOnce(&mut Routes) -> R) -> R {
        let mut state = self.agents();
        let State { agents, routes } = &mut *state;
        let result = work(routes);
        routes.reconcile(agents);
        result
    }

    pub(crate) fn insert(&self, mut agent: LiveAgent) {
        agent.shown.order = self.order.fetch_add(1, Ordering::Relaxed);
        agent.shown.started_ms = self.clock.now_ms();
        self.change(|agents| agents.insert(agent.agent.clone(), agent));
    }

    /// 子代理经父会话询问时记一次等待（`waiting` 为假时结束一次）。
    pub(crate) fn waiting(&self, agent: &AgentId, waiting: bool) {
        self.change(|agents| {
            if let Some(entry) = agents.get_mut(agent) {
                entry.shown.waiting = if waiting {
                    entry.shown.waiting + 1
                } else {
                    entry.shown.waiting.saturating_sub(1)
                };
            }
        });
    }

    /// 子会话提交了一条消息（只读查看据此重取）；这条消息是一个完成的子代理请求的回复时同时记下它的速度（F112）。
    /// 速度与版本在同一次改动里：看到新版本去取快照时，速度一定已经是这个请求的。
    pub(crate) fn committed(
        &self,
        agent: &AgentId,
        speed: Option<rust_cli_kernel_api::metering::OutputSpeed>,
    ) {
        self.change(|agents| {
            if let Some(entry) = agents.get_mut(agent) {
                entry.shown.version += 1;
                if speed.is_some() {
                    entry.shown.speed = speed;
                }
            }
        });
    }

    /// 子循环的事件改变了当前活动（L35）。活动没变时不通知；变了只发变化通知、不加 `version`
    /// （只读查看不因此重取子会话）。
    pub(crate) fn doing(&self, agent: &AgentId, doing: Option<Doing>) {
        let changed = {
            let mut agents = self.agents();
            let Some(entry) = agents.get_mut(agent) else {
                return;
            };
            if entry.shown.doing.as_ref().map(|(now, _)| now) == doing.as_ref() {
                false
            } else {
                entry.shown.doing = doing.map(|doing| (doing, self.clock.now_ms()));
                true
            }
        };
        if changed {
            self.changes
                .send_modify(|version| *version = version.wrapping_add(1));
        }
    }

    pub(crate) fn get(&self, agent: &AgentId) -> Option<LiveAgent> {
        self.agents().get(agent).cloned()
    }

    /// 顶层会话：`session` 是某个子代理的子会话时取它的顶层会话，否则就是它自己。
    pub(crate) fn root_of(&self, session: &SessionId) -> SessionId {
        self.agents()
            .values()
            .find(|agent| &agent.child == session)
            .map_or_else(|| session.clone(), |agent| agent.root.clone())
    }

    /// 由 `session` 启动的子代理，按 ID 排序。
    pub(crate) fn spawned_by(&self, session: &SessionId) -> Vec<LiveAgent> {
        self.agents()
            .values()
            .filter(|agent| &agent.parent == session)
            .cloned()
            .collect()
    }

    /// 顶层会话 `root` 里还在跑或停放的后台子代理（含子代理里再派生的），按 ID 排序。
    pub(crate) fn background_in(&self, root: &SessionId) -> Vec<LiveAgent> {
        self.agents()
            .values()
            .filter(|agent| &agent.root == root && agent.background && agent.is_live())
            .cloned()
            .collect()
    }

    /// Fork: the sessions among `sessions` that are the child session of a running agent. A parked agent is not
    /// running (erase ends it as stopped), and neither is an erased one.
    pub(crate) fn running_in(&self, sessions: &[SessionId]) -> Vec<SessionId> {
        self.agents()
            .values()
            .filter(|agent| {
                !agent.erased
                    && matches!(agent.state, AgentState::Running { .. })
                    && sessions.contains(&agent.child)
            })
            .map(|agent| agent.child.clone())
            .collect()
    }

    /// 重新开始运行（SendMessage 续跑已结束或停放的子代理）。已在跑时返回 None。
    /// `tool_use`: the call the resumed run belongs to (its notification's `<tool-use-id>`).
    /// Fork: the restart makes the agent live again, so in the same section it claims a notice forwarder for its child
    /// session when none exists (after `/clear` its entry left once the agent finished): `Some(Some(started))` asks the
    /// caller to start it (specs/fork-rust-agent-parity.md, "After a restart, and on a remote executor").
    pub(crate) fn restart(
        &self,
        agent: &AgentId,
        abort: Abort,
        tool_use: Option<ToolUseId>,
    ) -> Option<Option<Started>> {
        self.change_routed(|agents, routes| {
            let entry = agents.get_mut(agent)?;
            if matches!(entry.state, AgentState::Running { .. }) {
                return None;
            }
            entry.background = true;
            entry.tool_use = tool_use;
            entry.stopped_by_user = false;
            entry.begin_run(abort, Vec::new());
            Some(routes.claim(&entry.child, &entry.root))
        })
    }

    pub(crate) fn finish(&self, agent: &AgentId, ending: Ending) {
        self.change(|agents| {
            if let Some(entry) = agents.get_mut(agent) {
                entry.state = AgentState::Finished(ending);
            }
        });
    }

    /// 排进正在跑的子代理的邮箱；不在跑时返回 [`Enqueued::NotRunning`]。
    /// Fork: a run whose stop is claimed keeps the message for the resume after it settles ([`Enqueued::AfterStop`]).
    pub(crate) fn enqueue(&self, agent: &AgentId, message: String, sender: &ToolUseId) -> Enqueued {
        let mut state = self.agents();
        let Some(entry) = state.get_mut(agent) else {
            return Enqueued::NotRunning;
        };
        if entry.stop_claimed() {
            let first = entry.late_messages.is_empty();
            entry.late_messages.push((message, sender.clone()));
            return Enqueued::AfterStop { first };
        }
        match &mut entry.state {
            AgentState::Running { mailbox, .. } => {
                mailbox.push(Mail::Message(message));
                Enqueued::Steered
            }
            _ => Enqueued::NotRunning,
        }
    }

    /// 工具边界取走邮箱里的一类（按到达顺序）；已中止时不取，留到运行结束时处理。
    fn take(&self, agent: &AgentId, notices: bool) -> Vec<Mail> {
        match self.agents().get_mut(agent).map(|entry| &mut entry.state) {
            Some(AgentState::Running { abort, mailbox }) if !abort.is_aborted() => {
                let (taken, kept) = std::mem::take(mailbox)
                    .into_iter()
                    .partition(|mail| matches!(mail, Mail::Notice(_)) == notices);
                *mailbox = kept;
                taken
            }
            _ => Vec::new(),
        }
    }

    /// SendMessage 排进来的消息。
    pub(crate) fn take_mailbox(&self, agent: &AgentId) -> Vec<String> {
        self.take(agent, false)
            .into_iter()
            .filter_map(|mail| match mail {
                Mail::Message(text) => Some(text),
                Mail::Notice(_) => None,
            })
            .collect()
    }

    /// 发给它的通知（信封）。
    pub(crate) fn take_notices(&self, agent: &AgentId) -> Vec<Notice> {
        self.take(agent, true)
            .into_iter()
            .filter_map(|mail| match mail {
                Mail::Notice(notice) => Some(notice),
                Mail::Message(_) => None,
            })
            .collect()
    }

    /// 中止正在跑的子代理；不在跑时返回 false（停放的由 `routing::stop_parked` 处理）。
    /// `by_user`: the user stopped it (desktop), not the model's TaskStop.
    /// Fork (desktop `stopSubagent`): the check and the abort of [`Self::stop`] in one lock section, so a run that
    /// ended or restarted after the check is never aborted. A parked agent is left to `routing::stop_parked`
    /// ([`GuardedStop::Parked`]), which ends it only while it is still parked in the same execution.
    pub(crate) fn stop_execution(
        &self,
        session: &SessionId,
        agent: &AgentId,
        execution: &str,
    ) -> GuardedStop {
        // A change: the claim leaves the running list at once (the change notice re-reads the table).
        self.change(|agents| {
            let Some(entry) = agents
                .get_mut(agent)
                .filter(|entry| entry.parent == *session && entry.owner.is_none())
            else {
                return GuardedStop::NotFound;
            };
            if entry.shown.execution.to_string() != execution {
                return GuardedStop::NotRunning;
            }
            // A claimed run is already ending: a second stop before it settles is refused, as Node claims `killed`
            // synchronously (core `runner.ts`).
            if entry.stop_claimed() {
                return GuardedStop::NotRunning;
            }
            match &entry.state {
                AgentState::Running { abort, .. } => {
                    abort.abort(AbortReason::User);
                    entry.stopped_by_user = true;
                    drop_mailbox_messages(entry);
                    GuardedStop::Aborted
                }
                AgentState::Parked { .. } => GuardedStop::Parked(entry.shown.execution),
                AgentState::Finished(_) => GuardedStop::NotRunning,
            }
        })
    }

    /// Claims the stop of a running agent and returns the claimed execution; None when it is not running or its stop is already claimed (the first
    /// stop keeps its attribution, Node `completion-notification.ts`).
    pub(crate) fn stop(&self, agent: &AgentId, by_user: bool) -> Option<u64> {
        self.change(|agents| {
            let entry = agents.get_mut(agent)?;
            if entry.stop_claimed() {
                return None;
            }
            match &entry.state {
                AgentState::Running { abort, .. } => {
                    abort.abort(AbortReason::User);
                    entry.stopped_by_user = by_user;
                    drop_mailbox_messages(entry);
                    Some(entry.shown.execution)
                }
                _ => None,
            }
        })
    }
}

/// The stop drops the messages queued to the stopped run (upstream: a stop clears the queued commands sent to it);
/// notices stay for `routing::settle`. Messages that arrive later go to `late_messages`.
fn drop_mailbox_messages(entry: &mut LiveAgent) {
    if let AgentState::Running { mailbox, .. } = &mut entry.state {
        mailbox.retain(|mail| matches!(mail, Mail::Notice(_)));
    }
}

/// Fork: where [`Live::enqueue`] put a SendMessage message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Enqueued {
    /// Into the running agent's mailbox (its next tool boundary).
    Steered,
    /// The run's stop is claimed: it resumes after it settles. `first`: this message resumes it; later ones wait in
    /// the resumed run's mailbox (Node: once the resume started, a message is queued to the running agent).
    AfterStop {
        first: bool,
    },
    NotRunning,
}

/// 状态转移之后统一记时刻：进入运行时重新开始计时，离开运行（停放、结束）时记结束时刻。状态改在很多处
/// （routing、TaskStop、SendMessage），时刻只在这里记，不在每个转移点各写一遍。
fn settle_times(agents: &mut Agents, now: u64) {
    for agent in agents.values_mut() {
        // A claimed stop ends the run's time (it no longer shows as running).
        let running = matches!(agent.state, AgentState::Running { .. }) && !agent.stop_claimed();
        match (running, agent.shown.ended_ms) {
            (true, Some(_)) => {
                agent.shown.started_ms = now;
                agent.shown.ended_ms = None;
            }
            (false, None) => {
                agent.shown.ended_ms = Some(now);
                agent.shown.doing = None;
            }
            _ => {}
        }
    }
}

/// Fork: the outcome of [`Live::stop_execution`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GuardedStop {
    Aborted,
    /// Parked in this execution: `routing::stop_parked` ends it only while it is still parked in it.
    Parked(u64),
    NotFound,
    NotRunning,
}
