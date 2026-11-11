//! 子代理里后台命令的通知（docs/specs/rust-cli/agents.md §5.2，L18）。
//!
//! 执行环境按子会话记它的后台命令与通知（唯一事实源仍是 env-local 的账本）。建子会话时为它起一个转发
//! 任务：收到一条通知，在 `live::Live` 的一把锁里按这个子代理的状态送出（在跑进邮箱、停放就续跑、已结束送顶层
//! 会话，与它派生的后台子代理的通知同一条路，`routing::deliver`），交出之后才 ack 执行环境的通知。
//!
//! 修正（L18）：以前子会话的命令通知没有接收方——会话 actor 只订阅顶层会话，子代理里 `run_in_background`
//! 的命令结束后通知一直挂在执行环境里，子代理与主线程都收不到，`-p` 也不等这些命令。

use std::sync::Arc;

use futures_util::StreamExt;
use rust_cli_kernel_api::env_shell::ShellNotice;
use rust_cli_kernel_api::ids::{AgentId, SessionId};
use rust_cli_kernel_api::machine_notices::{self, all_shell_notices};
use rust_cli_kernel_api::store::{SessionKind, SessionMeta, StoreError};
use rust_cli_prompts::notification;

use crate::Core;
use crate::live::{LiveAgent, Notice};
use crate::routes::{Adopted, Started};
use crate::routing;

// Fork: whether a child session's notices have a forwarder, and whether a notice can be taken now, is decided in one
// place: the `routes` registry inside the Live lock (routes.rs; specs/fork-rust-agent-parity.md, "After a restart, and
// on a remote executor"). The env ledger hands a notice to whichever subscriber acknowledges it first, so a child gets
// at most one forwarder: its entry exists until its own task removes it.

/// 为子会话 `child` 起转发任务（`AgentTool::call`：顶层会话 `root` 正在跑这一轮，它的子代理已经登记为在跑）。已有转发
/// 任务时什么也不做。Fork: this does not mark `root` open; the running agent keeps the forwarder wanted.
pub(crate) fn watch(core: &Arc<Core>, child: &SessionId, root: &SessionId) {
    if let Some(started) = core.live.routes(|routes| routes.claim(child, root)) {
        start(core, child, root, started);
    }
}

/// Runs the forwarder of a claimed entry. It leaves at a safe point (between notices, never between delivering a
/// notice and acknowledging it) once its entry is no longer wanted, removing the entry in the same section; it also
/// leaves when it refuses a notice (removed in the section that refused) or when the merged stream ends.
fn start(core: &Arc<Core>, child: &SessionId, root: &SessionId, started: Started) {
    let Started { id, mut wake } = started;
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
                if core.live.routes(|routes| routes.leave_if_unwanted(&child, id)) {
                    tracing::info!(
                        event = "agents.subagent_notice.forwarder_stopped",
                        "a subagent notice forwarder stopped: its top-level session closed and no live agent owns it"
                    );
                    return;
                }
                let tagged = tokio::select! {
                    biased;
                    // A wake only means "check again" (a reopen may have made the entry wanted again).
                    _ = wake.changed() => continue,
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
                let Some(woken) = forward(&core, &child, &root, id, tagged.notice.clone()) else {
                    // Fork: nobody can take it now, and the entry is already gone: it stays pending in the executor's
                    // ledger, and the next open of the top-level session adopts the child again and delivers it.
                    tracing::info!(
                        event = "agents.subagent_notice.left_pending",
                        seq = tagged.notice.seq,
                        "a subagent command notice was left pending: its top-level session is closed"
                    );
                    return;
                };
                routing::wake(&core, woken).await;
                if let Err(error) =
                    machine_notices::ack(core.ports.machines.as_ref(), &tagged, &child).await
                {
                    tracing::warn!(%error, seq = tagged.notice.seq, "a subagent command notice was not acknowledged");
                }
            }
            core.live.routes(|routes| routes.remove(&child, id));
        });
}

/// Fork: the kernel opened or created `meta`. A top-level session is open from now on, and its persisted subagent
/// children get a forwarder each (a process restart left them none; the child session actor never subscribes). Their
/// notices go to the agent that owns the child when it is live, else to this session.
pub(crate) fn adopt(core: &Arc<Core>, meta: &SessionMeta) {
    if meta.kind == SessionKind::Subagent {
        return;
    }
    let root = meta.id.clone();
    let (generation, mut epoch) = core.live.routes(|routes| routes.opened(&root));
    let task_core = core.clone();
    let _task = core
        .ports
        .spawner
        .clone()
        .spawn("subagent-shell-notices-adopt", async move {
            loop {
                let children = match task_core.ports.store_queries.subagent_child_ids(&root).await {
                    Ok(children) => children,
                    Err(StoreError::Unsupported { .. }) => return,
                    Err(error) => {
                        tracing::warn!(%error, "the subagent children of a reopened session were not read");
                        return;
                    }
                };
                // The claims and the check that `root` is still open at this generation, with no erase since the
                // read, share one section: neither a close nor an erase can fall between them.
                match task_core
                    .live
                    .routes(|routes| routes.adopt(&root, (generation, epoch), &children))
                {
                    Adopted::Closed => return,
                    // An erase happened after the read: read the tree again, without the erased sessions.
                    Adopted::Retry(now) => epoch = now,
                    Adopted::Claimed(claimed) => {
                        for (child, started) in claimed {
                            start(&task_core, &child, &root, started);
                        }
                        return;
                    }
                }
            }
        });
}

/// Fork: the kernel started closing `session`. The forwarders of its children that no running or parked agent owns
/// stop at their next safe point (a `/clear` leaves background subagents running, and they keep theirs).
pub(crate) fn closing(core: &Core, session: &SessionId) {
    core.live.routes(|routes| routes.closing(session));
}

/// Fork: `sessions` were erased. Every forwarder of theirs stops, and the Hub drops what it held for them, in the
/// section that marks them erased: a delivery decided after it refuses. Lock order: Live, then Hub.
pub(crate) fn erased(core: &Core, sessions: &[SessionId]) {
    let dropped: usize = core.live.routes(|routes| {
        routes.erased(sessions);
        sessions
            .iter()
            .map(|session| core.hub.forget(session))
            .sum()
    });
    tracing::info!(
        event = "agents.subagent_notice.erased",
        dropped = dropped as u64,
        "the notices of erased sessions were dropped"
    );
}

/// 一条命令通知交给拥有子会话 `child` 的子代理（在跑进邮箱、停放就续跑），没有在跑或停放的子代理时交给顶层会话。
/// 子代理按子会话在交出时找（Fork：不是起转发任务时记下的 ID），所以进程重启后接管的子会话也走同一条路。
/// Fork: None when the entry `id` is no longer wanted; it is removed in the same section (the caller leaves without an
/// ack). Otherwise the agents to wake.
fn forward(
    core: &Arc<Core>,
    child: &SessionId,
    root: &SessionId,
    id: u64,
    notice: ShellNotice,
) -> Option<Vec<routing::Wake>> {
    let status = notice.status();
    // 入参由 kernel-api 的 `ShellNotice::task_notice` 换算（工作线 F134：以前这里与 session 各写一份）。
    let envelope = notification::task_envelope(&notice.task_notice());
    let notice = Notice {
        // 通知的来源标识：顶层会话的 `BackgroundWork` 与后台列表用它（命令的任务 ID）。
        from: AgentId::new(notice.task.as_str()),
        status,
        envelope,
    };
    core.live.with_routes(|agents, routes| {
        // Fork: refused unless the top-level session is open or a live agent owns the child, and it is not erased: a
        // notice is never acknowledged into the Hub of a closed or erased session (its Hub is read only by its actor).
        if !routes.want(agents, child) {
            routes.remove(child, id);
            return None;
        }
        let owner = agents
            .values()
            .find(|entry| &entry.child == child)
            .map(|entry| entry.agent.clone());
        // 交出与记账在同一把锁里：收尾判断“还有没交给它的命令”时去掉它（ack 之前账本还列着，agents.md §5.2 第 5 条）。
        if let Some(entry) = owner.as_ref().and_then(|owner| agents.get_mut(owner)) {
            entry.delivered.push(notice.from.clone());
        }
        Some(
            routing::deliver(agents, &core.hub, owner.as_ref(), root, notice)
                .into_iter()
                .collect(),
        )
    })
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
