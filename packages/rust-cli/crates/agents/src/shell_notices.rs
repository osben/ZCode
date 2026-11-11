//! 子代理里后台命令的通知（docs/specs/rust-cli/agents.md §5.2，L18）。
//!
//! 执行环境按子会话记它的后台命令与通知（唯一事实源仍是 env-local 的账本）。建子会话时为它起一个转发
//! 任务：收到一条通知，在 `live::Live` 的一把锁里按这个子代理的状态送出（在跑进邮箱、停放就续跑、已结束送顶层
//! 会话，与它派生的后台子代理的通知同一条路，`routing::deliver`），交出之后才 ack 执行环境的通知。
//!
//! 修正（L18）：以前子会话的命令通知没有接收方——会话 actor 只订阅顶层会话，子代理里 `run_in_background`
//! 的命令结束后通知一直挂在执行环境里，子代理与主线程都收不到，`-p` 也不等这些命令。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env_shell::ShellNotice;
use rust_cli_kernel_api::ids::{AgentId, SessionId};
use rust_cli_kernel_api::machine_notices::{self, all_shell_notices};
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use rust_cli_prompts::notification;
use tokio_util::sync::CancellationToken;

use crate::Core;
use crate::live::{LiveAgent, Notice};
use crate::routing;

/// Fork: the child sessions that have a forwarder, and the top-level sessions that are open. The env ledger hands a
/// notice to whichever subscriber acknowledges it first, so a child session gets exactly one forwarder however often
/// it is started (a new agent, or its top-level session reopened). A forwarder lives while its top-level session is
/// open or a live agent owns its child (specs/fork-rust-agent-parity.md, "After a restart, and on a remote executor").
#[derive(Default)]
pub(crate) struct Forwarders(Mutex<ForwarderState>);

#[derive(Default)]
struct ForwarderState {
    children: HashMap<SessionId, Forwarder>,
    /// Open top-level sessions and the generation of their latest open (guards an adoption that a release overtook).
    open: HashMap<SessionId, u64>,
    next: u64,
}

struct Forwarder {
    root: SessionId,
    stop: CancellationToken,
    /// Tells this forwarder from a later one for the same child.
    id: u64,
}

/// A started forwarder's identity and stop token.
struct Claim {
    id: u64,
    stop: CancellationToken,
}

impl ForwarderState {
    fn next(&mut self) -> u64 {
        self.next += 1;
        self.next
    }
}

impl Forwarders {
    /// The top-level session `root` opened from the store; returns this open's generation.
    fn opened(&self, root: &SessionId) -> u64 {
        let mut state = self.0.lock_unpoisoned();
        let generation = state.next();
        state.open.insert(root.clone(), generation);
        generation
    }

    /// `root` runs a turn that spawns an agent, so it is open (a session created in this process never went through
    /// `opened`).
    fn running_in(&self, root: &SessionId) {
        let mut state = self.0.lock_unpoisoned();
        if !state.open.contains_key(root) {
            let generation = state.next();
            state.open.insert(root.clone(), generation);
        }
    }

    pub(crate) fn is_open(&self, root: &SessionId) -> bool {
        self.0.lock_unpoisoned().open.contains_key(root)
    }

    /// Registers a forwarder for `child` unless it has one. With `at`, only while `root` is still open at that
    /// generation: the check and the claim share one lock, so a release cannot fall between them.
    fn claim(&self, child: &SessionId, root: &SessionId, at: Option<u64>) -> Option<Claim> {
        let mut state = self.0.lock_unpoisoned();
        if at.is_some_and(|generation| state.open.get(root) != Some(&generation))
            || state.children.contains_key(child)
        {
            return None;
        }
        let id = state.next();
        let stop = CancellationToken::new();
        state.children.insert(
            child.clone(),
            Forwarder {
                root: root.clone(),
                stop: stop.clone(),
                id,
            },
        );
        Some(Claim { id, stop })
    }

    /// The forwarder `id` of `child` ended; a later forwarder of the same child stays.
    fn ended(&self, child: &SessionId, id: u64) {
        let mut state = self.0.lock_unpoisoned();
        if state
            .children
            .get(child)
            .is_some_and(|forwarder| forwarder.id == id)
        {
            state.children.remove(child);
        }
    }

    /// `root` closed: it is no longer open, and the forwarders of its children stop, except those in `owned`.
    fn released(&self, root: &SessionId, owned: &HashSet<SessionId>) -> usize {
        let mut state = self.0.lock_unpoisoned();
        state.open.remove(root);
        let mut stopped = 0;
        state.children.retain(|child, forwarder| {
            let stop = &forwarder.root == root && !owned.contains(child);
            if stop {
                forwarder.stop.cancel();
                stopped += 1;
            }
            !stop
        });
        stopped
    }

    /// `sessions` were erased: none is open, and every forwarder of an erased child or root stops.
    fn erased(&self, sessions: &HashSet<SessionId>) -> usize {
        let mut state = self.0.lock_unpoisoned();
        state.open.retain(|root, _| !sessions.contains(root));
        let mut stopped = 0;
        state.children.retain(|child, forwarder| {
            let stop = sessions.contains(child) || sessions.contains(&forwarder.root);
            if stop {
                forwarder.stop.cancel();
                stopped += 1;
            }
            !stop
        });
        stopped
    }
}

/// 为子会话 `child` 起转发任务（`AgentTool::call`：顶层会话 `root` 正在跑这一轮）。已有转发任务时什么也不做。
pub(crate) fn watch(core: &Arc<Core>, child: &SessionId, root: &SessionId) {
    core.forwarders.running_in(root);
    start(core, child, root, None);
}

/// Starts the forwarder of `child` when [`Forwarders::claim`] grants it. It stops between notices when its stop token
/// fires (never between delivering a notice and acknowledging it), when its notice cannot be delivered (no live agent
/// owns the child and `root` is closed), or when the merged stream ends.
fn start(core: &Arc<Core>, child: &SessionId, root: &SessionId, at: Option<u64>) {
    let Some(Claim { id, stop }) = core.forwarders.claim(child, root, at) else {
        return;
    };
    let core = core.clone();
    let child = child.clone();
    let root = root.clone();
    let _task = core
        .ports
        .spawner
        .clone()
        .spawn("subagent-shell-notices", async move {
            // 本机与连上的远端机器的通知（R3，remote-exec.md §20.7.2）：ack 发给通知所在的机器。
            let mut notices = all_shell_notices(core.ports.machines.clone(), child.clone());
            loop {
                let tagged = tokio::select! {
                    biased;
                    () = stop.cancelled() => break,
                    next = notices.next() => match next {
                        Some(tagged) => tagged,
                        None => break,
                    },
                };
                // 在看的 monitor 的终态交给它的任务：合成带剩下的行的终态、送出之后由它 ack（agents.md §5.3）。
                if tagged.notice.kind == rust_cli_kernel_api::env_shell::BackgroundKind::Monitor
                    && core.monitors.take(&tagged.notice)
                {
                    continue;
                }
                if !forward(&core, &child, &root, tagged.notice.clone()).await {
                    // Fork: nobody can take it now; it stays pending in the executor's ledger, and the next open of
                    // the top-level session adopts the child again and delivers it.
                    tracing::info!(
                        event = "agents.subagent_notice.left_pending",
                        seq = tagged.notice.seq,
                        "a subagent command notice was left pending: its top-level session is closed"
                    );
                    break;
                }
                if let Err(error) =
                    machine_notices::ack(core.ports.machines.as_ref(), &tagged, &child).await
                {
                    tracing::warn!(%error, seq = tagged.notice.seq, "a subagent command notice was not acknowledged");
                }
            }
            core.forwarders.ended(&child, id);
        });
}

/// Fork: the kernel opened `meta` from the store. A top-level session's persisted subagent children get a forwarder
/// each (a process restart left them none; the child session actor never subscribes). Their notices go to the agent
/// that owns the child when it is live, else to this session.
pub(crate) fn adopt(core: &Arc<Core>, meta: &SessionMeta) {
    if meta.kind == SessionKind::Subagent {
        return;
    }
    let root = meta.id.clone();
    let generation = core.forwarders.opened(&root);
    let task_core = core.clone();
    let _task = core
        .ports
        .spawner
        .clone()
        .spawn("subagent-shell-notices-adopt", async move {
            match task_core.ports.store_queries.subagent_child_ids(&root).await {
                Ok(children) => {
                    for child in &children {
                        start(&task_core, child, &root, Some(generation));
                    }
                }
                Err(rust_cli_kernel_api::store::StoreError::Unsupported { .. }) => {}
                Err(error) => {
                    tracing::warn!(%error, "the subagent children of a reopened session were not read");
                }
            }
        });
}

/// Fork: the kernel released `session`. Children that a running or parked agent owns keep their forwarder (a
/// `/clear` leaves background subagents running); the others stop, so their notices stay pending until it reopens.
pub(crate) fn released(core: &Core, session: &SessionId) {
    let owned: HashSet<SessionId> = core.live.with(|agents| {
        agents
            .values()
            .filter(|agent| agent.is_live())
            .map(|agent| agent.child.clone())
            .collect()
    });
    let stopped = core.forwarders.released(session, &owned);
    if stopped > 0 {
        tracing::info!(
            event = "agents.subagent_notice.forwarders_stopped",
            stopped = stopped as u64,
            "the subagent notice forwarders of a closed session stopped"
        );
    }
}

/// Fork: `sessions` were erased. Every forwarder of theirs stops, and the Hub drops what it held for them.
pub(crate) fn erased(core: &Core, sessions: &[SessionId]) {
    let set: HashSet<SessionId> = sessions.iter().cloned().collect();
    let stopped = core.forwarders.erased(&set);
    let dropped: usize = sessions
        .iter()
        .map(|session| core.hub.forget(session))
        .sum();
    tracing::info!(
        event = "agents.subagent_notice.erased",
        stopped = stopped as u64,
        dropped = dropped as u64,
        "the notices of erased sessions were dropped"
    );
}

/// 一条命令通知交给拥有子会话 `child` 的子代理（在跑进邮箱、停放就续跑），没有在跑或停放的子代理时交给顶层会话。
/// 子代理按子会话在交出时找（Fork：不是起转发任务时记下的 ID），所以进程重启后接管的子会话也走同一条路。
async fn forward(
    core: &Arc<Core>,
    child: &SessionId,
    root: &SessionId,
    notice: ShellNotice,
) -> bool {
    let status = notice.status();
    // 入参由 kernel-api 的 `ShellNotice::task_notice` 换算（工作线 F134：以前这里与 session 各写一份）。
    let envelope = notification::task_envelope(&notice.task_notice());
    let notice = Notice {
        // 通知的来源标识：顶层会话的 `BackgroundWork` 与后台列表用它（命令的任务 ID）。
        from: AgentId::new(notice.task.as_str()),
        status,
        envelope,
    };
    let delivered = core.live.with(|agents| {
        let owner = agents
            .values()
            .find(|entry| &entry.child == child)
            .map(|entry| entry.agent.clone());
        // Fork: without a running or parked owner the notice goes to the top-level session, and only while it is open
        // (its Hub is read only by its actor). Lock order: Live, then Forwarders.
        let owned = owner
            .as_ref()
            .and_then(|owner| agents.get(owner))
            .is_some_and(LiveAgent::is_live);
        if !owned && !core.forwarders.is_open(root) {
            return None;
        }
        // 交出与记账在同一把锁里：收尾判断“还有没交给它的命令”时去掉它（ack 之前账本还列着，agents.md §5.2 第 5 条）。
        if let Some(entry) = owner.as_ref().and_then(|owner| agents.get_mut(owner)) {
            entry.delivered.push(notice.from.clone());
        }
        Some(routing::deliver(
            agents,
            &core.hub,
            owner.as_ref(),
            root,
            notice,
        ))
    });
    let Some(wake) = delivered else {
        return false;
    };
    routing::wake(core, wake.into_iter().collect()).await;
    true
}

/// 顶层会话 `root` 里各子代理子会话还在跑、或通知还没 ack 的后台命令（`-p` 等它们，agents.md §5.2 第 4 条）。
pub(crate) async fn background_commands(core: &Core, root: &SessionId) -> Vec<AgentId> {
    let children: Vec<LiveAgent> = core.live.with(|agents| {
        agents
            .values()
            .filter(|agent| &agent.root == root)
            .cloned()
            .collect()
    });
    let mut commands = Vec::new();
    for agent in children {
        commands.extend(commands_of(core, &agent).await);
    }
    commands
}

/// 一个子代理的子会话里还在跑、或通知还没 ack 的后台命令（执行环境的 `shell_state`，唯一事实源；问不到时为空）。只问
/// 本机，同 TaskStop（agents.md §5.2 第 4、5 条）。
pub(crate) async fn commands_of(core: &Core, agent: &LiveAgent) -> Vec<AgentId> {
    let machine = core.ports.machines.primary_machine();
    match machine
        .shell()
        .shell_state(&agent.workspace, &agent.child)
        .await
    {
        Ok(state) => state
            .background
            .into_iter()
            .map(|task| AgentId::new(task.as_str()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[cfg(test)]
#[path = "shell_notices_tests.rs"]
mod tests;
