//! 子代理里后台命令的通知（docs/specs/rust-cli/agents.md §5.2，L18）：子代理在跑时进它的邮箱、在它的工具
//! 边界并入；它已结束时送顶层会话；交出之后才 ack 执行环境的通知；`-p` 的后台工作算上这些命令。

use std::sync::Arc;

use futures_util::StreamExt;
use rust_cli_kernel_api::agents::AgentSignal;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::testing::{NoticeEnvironment, machine, shell_notice};
use serde_json::json;

use crate::test_support::{Gates, held_with_env, text};

const ROOT: &str = "sess_parent";

#[tokio::test]
async fn a_subagent_command_notice_goes_to_the_subagent_then_to_the_top_level() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let signals = harness.agents.signals();
    let mut root = signals.signals(&SessionId::new(ROOT));
    let launched = harness
        .call(
            ROOT,
            "Agent",
            json!({"description": "Shell owner", "prompt": "Go."}),
        )
        .await;
    let output = text(&launched);
    let id = output
        .split("agentId: ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .unwrap()
        .to_owned();
    let session = format!("sess_subagent_{id}");
    harness.started(1).await;
    // 子代理在跑：命令通知进它的邮箱，交出之后 ack；它在工具边界取走。
    env.finish(shell_notice(1, "b1"));
    for _ in 0..10_000 {
        if !env.acked().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(env.acked(), [1]);
    gates.release(&session);
    let Some(AgentSignal::Notice(own)) = root.next().await else {
        panic!("expected the agent's own notice");
    };
    assert_eq!(own.agent.as_str(), id);
    let absorbed = harness.absorbed.lock().unwrap().clone();
    assert_eq!(absorbed.len(), 1, "{absorbed:?}");
    assert_eq!(absorbed[0].0.as_str(), session);
    assert!(
        absorbed[0]
            .1
            .starts_with("<system-reminder>\n[SYSTEM NOTIFICATION")
    );
    assert!(absorbed[0].1.contains("<task-id>b1</task-id>"));
    // 子代理已结束：之后的命令通知送顶层会话。
    env.finish(shell_notice(2, "b2"));
    let Some(AgentSignal::Notice(late)) = root.next().await else {
        panic!("expected the command notice at the top level");
    };
    assert_eq!(late.agent.as_str(), "b2");
    assert!(late.text.contains("<task-id>b2</task-id>"));
    for _ in 0..10_000 {
        if env.acked().len() == 2 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(env.acked(), [1, 2]);
}

// 命令保活（agents.md §5.2 第 5 条，用户决定 2026-11-05）：后台子代理跑完时（交互模式与 `-p`），子会话里还有没交给它的后台命令
// 就停放、现在送出自己的通知（keepalive 的 note），命令的通知让它续跑，而不是送顶层会话。修复前它直接结束，命令的
// 通知送了顶层会话，子代理再也不醒（2026-11-04 的长任务里两个子代理就这样停住）。

const KEEPALIVE: &str = "<note>This agent stopped with background work of its own still running.";
const PLAIN: &str = "<note>A task-notification fires each time this agent stops";

/// 后台子代理与它的子会话。
async fn launch(harness: &crate::test_support::Harness) -> (String, String) {
    let launched = harness
        .call(
            ROOT,
            "Agent",
            json!({"description": "Builder", "prompt": "Build.", "run_in_background": true}),
        )
        .await;
    let id = text(&launched)
        .split("agentId: ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .unwrap()
        .to_owned();
    let session = format!("sess_subagent_{id}");
    harness.started(1).await;
    (id, session)
}

async fn next_notice(
    stream: &mut futures_util::stream::BoxStream<'static, AgentSignal>,
) -> rust_cli_kernel_api::agents::AgentNotice {
    loop {
        if let Some(AgentSignal::Notice(notice)) = stream.next().await {
            return notice;
        }
    }
}

/// 顶层会话里还在跑或停放的后台子代理（停放的也在；不含命令）。
async fn live(harness: &crate::test_support::Harness) -> Vec<String> {
    harness
        .agents
        .core
        .live
        .background_in(&SessionId::new(ROOT))
        .into_iter()
        .map(|agent| agent.agent.to_string())
        .collect()
}

/// 续跑的那次运行的最后一条消息（续跑的第一条消息）。
fn resumed_with(harness: &crate::test_support::Harness, run: usize) -> String {
    let request = harness.seen()[run].request.clone();
    let Some(rust_cli_kernel_api::message::Message::User(first)) = request.messages.last() else {
        panic!("expected the notice message");
    };
    let [rust_cli_kernel_api::message::ContentBlock::Text { text }] = first.content.as_slice()
    else {
        panic!("expected one text block");
    };
    text.clone()
}

#[tokio::test]
async fn a_subagent_with_a_running_command_parks_and_the_command_wakes_it() {
    parks_and_wakes(true).await;
}

// `-p` 同样（用户决定 2026-11-05，agents.md §5.2 第 5 条）：以前 `-p` 里它直接结束、命令的通知送顶层会话。停放的子代理算 `-p` 的后台工作（`background_in`），所以 `-p` 等它续跑完才收尾。
#[tokio::test]
async fn in_print_mode_a_subagent_with_a_running_command_parks_too() {
    parks_and_wakes(false).await;
}

async fn parks_and_wakes(keep_alive: bool) {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    env.finish_after_checks(shell_notice(1, "b1"), usize::MAX);
    let harness = held_with_env(&gates, keep_alive, machine(env.clone()));
    let mut root = harness.agents.signals().signals(&SessionId::new(ROOT));
    let (id, session) = launch(&harness).await;
    // 跑完时 b1 还在跑：停放，自己的通知现在送出，note 说它可能还会续跑。
    gates.release(&session);
    let first = next_notice(&mut root).await;
    assert_eq!(first.agent.as_str(), id);
    assert!(first.text.contains(KEEPALIVE), "{}", first.text);
    assert!(first.text.contains("<status>completed</status>"));
    assert_eq!(live(&harness).await, std::slice::from_ref(&id));
    // b1 结束：通知让子代理续跑，是续跑的第一条消息，不送顶层会话。
    env.finish(shell_notice(1, "b1"));
    harness.started(2).await;
    let prompt = resumed_with(&harness, 1);
    assert!(prompt.contains("<task-id>b1</task-id>"), "{prompt}");
    // 续跑结束：命令都交出了，结束并再送一次通知（普通的 note）。
    gates.release(&session);
    let second = next_notice(&mut root).await;
    assert_eq!(second.agent.as_str(), id, "{}", second.text);
    assert!(second.text.contains(PLAIN), "{}", second.text);
    // 续跑不属于派生它的 Agent 调用：只有第一次通知带 `<tool-use-id>`（agents.md §5）。
    assert!(first.text.contains("<tool-use-id>"), "{}", first.text);
    assert!(!second.text.contains("<tool-use-id>"), "{}", second.text);
    assert!(live(&harness).await.is_empty());
    assert_eq!(env.acked(), [1]);
}

#[tokio::test]
async fn a_command_that_ends_while_the_run_settles_still_reaches_the_subagent() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    // 第 1 次查询是建子会话时取工作目录（`inherit_directory`），第 2 次是收尾的判断：问到它还在跑，问完立即结束，通知
    // 与收尾抢同一把锁。先拿到锁的是转发 → 进邮箱，收尾带着它续跑；先拿到的是收尾 → 停放，转发让它续跑。都不丢不重。
    env.finish_after_checks(shell_notice(1, "b1"), 2);
    let harness = held_with_env(&gates, true, machine(env.clone()));
    let mut root = harness.agents.signals().signals(&SessionId::new(ROOT));
    let (id, session) = launch(&harness).await;
    gates.release(&session);
    harness.started(2).await;
    let prompt = resumed_with(&harness, 1);
    assert!(prompt.contains("<task-id>b1</task-id>"), "{prompt}");
    gates.release(&session);
    // 顶层会话只收到子代理自己的通知（停放时的一条可能有，也可能直接续跑没有），没有 b1 的。
    loop {
        let notice = next_notice(&mut root).await;
        assert_eq!(notice.agent.as_str(), id, "{}", notice.text);
        if notice.text.contains(PLAIN) {
            break;
        }
    }
    assert!(live(&harness).await.is_empty());
}

#[tokio::test]
async fn stopping_the_last_command_of_a_parked_subagent_ends_it_quietly() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    let mut harness = held_with_env(&gates, true, machine(env.clone()));
    harness.set_machine(machine(env.clone()));
    let mut root = harness.agents.signals().signals(&SessionId::new(ROOT));
    let (id, session) = launch(&harness).await;
    env.run_in(SessionId::new(&session), shell_notice(1, "b1"));
    gates.release(&session);
    let first = next_notice(&mut root).await;
    assert!(first.text.contains(KEEPALIVE), "{}", first.text);
    // 主线程停掉 b1：停掉的命令没有通知，子代理不会再醒，就此结束；通知已经送过，不再送。
    let stopped = harness
        .call(ROOT, "TaskStop", json!({"task_id": "b1"}))
        .await;
    assert!(
        text(&stopped).contains("Successfully stopped task: b1"),
        "{}",
        text(&stopped)
    );
    assert!(live(&harness).await.is_empty(), "{id} still parked");
    assert_eq!(harness.seen().len(), 1);
    let quiet = tokio::time::timeout(std::time::Duration::from_millis(50), next_notice(&mut root));
    assert!(quiet.await.is_err(), "no second notice");
}

#[tokio::test]
async fn a_command_notice_taken_during_the_run_does_not_hold_the_subagent() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    // 建子会话时的查询之后就结束：通知在运行中进邮箱，在工具边界并入。收尾时它已经交给子代理（ack 前后都一样），不停放。
    env.finish_after_checks(shell_notice(1, "b1"), 1);
    let harness = held_with_env(&gates, true, machine(env.clone()));
    let mut root = harness.agents.signals().signals(&SessionId::new(ROOT));
    let (id, session) = launch(&harness).await;
    gates.release(&session);
    let notice = next_notice(&mut root).await;
    assert_eq!(notice.agent.as_str(), id, "{}", notice.text);
    assert!(notice.text.contains(PLAIN), "{}", notice.text);
    assert_eq!(harness.absorbed.lock().unwrap().len(), 1);
    assert_eq!(harness.seen().len(), 1);
    assert!(live(&harness).await.is_empty());
}

#[tokio::test]
async fn a_foreground_subagent_does_not_wait_for_its_command() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    env.finish_after_checks(shell_notice(1, "b1"), usize::MAX);
    let harness = held_with_env(&gates, true, machine(env.clone()));
    let mut root = harness.agents.signals().signals(&SessionId::new(ROOT));
    let call = harness.call(
        ROOT,
        "Agent",
        json!({"description": "Builder", "prompt": "Build.", "run_in_background": false}),
    );
    let drive = async {
        let first = harness.started(1).await;
        gates.release(first[0].request.session.as_str());
    };
    let (output, ()) = tokio::join!(call, drive);
    // 父调用同步拿到结果；子代理结束，命令的通知照旧送顶层会话。
    assert!(
        text(&output).contains("Hello from the subagent."),
        "{}",
        text(&output)
    );
    assert!(live(&harness).await.is_empty());
    env.finish(shell_notice(1, "b1"));
    let late = next_notice(&mut root).await;
    assert_eq!(late.agent.as_str(), "b1");
}

// Fork: after a process restart (specs/fork-rust-agent-parity.md, "After a restart, and on a remote executor").

fn meta(
    id: &str,
    kind: rust_cli_kernel_api::store::SessionKind,
    parent: Option<&str>,
) -> rust_cli_kernel_api::store::SessionMeta {
    rust_cli_kernel_api::store::SessionMeta {
        id: SessionId::new(id),
        kind,
        parent: parent.map(SessionId::new),
        workspace: crate::test_support::workspace(),
        title: String::new(),
        trace: rust_cli_kernel_api::ids::TraceId::new(id),
        created_at_ms: 0,
        incognito: None,
    }
}

async fn settle_tasks() {
    for _ in 0..1_000 {
        tokio::task::yield_now().await;
    }
}

async fn until(mut done: impl FnMut() -> bool) {
    for _ in 0..10_000 {
        if done() {
            return;
        }
        tokio::task::yield_now().await;
    }
    assert!(done(), "the condition never held");
}

/// A child session persisted by an earlier process has no forwarder. Opening its top-level session starts one, and
/// the child's notice (no live agent owns it) goes to the top-level session and is acknowledged.
#[tokio::test]
async fn a_reopened_top_level_session_adopts_its_persisted_subagent_children() {
    use rust_cli_kernel_api::store::{SessionKind, SessionStore};
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let root_meta = meta(ROOT, SessionKind::Interactive, None);
    let child = "sess_subagent_agent_old";
    harness.store.create(root_meta.clone()).await.unwrap();
    harness
        .store
        .create(meta(child, SessionKind::Subagent, Some(ROOT)))
        .await
        .unwrap();
    let signals = harness.agents.signals();
    let mut root = signals.signals(&SessionId::new(ROOT));
    signals.session_opened(&root_meta);
    until(|| env.subscribed() == [SessionId::new(child)]).await;
    env.finish(shell_notice(1, "b1"));
    let notice = next_notice(&mut root).await;
    assert_eq!(notice.agent.as_str(), "b1");
    assert!(notice.text.contains("<task-id>b1</task-id>"));
    until(|| env.acked() == [1]).await;
    // Opening it again starts no second forwarder.
    signals.session_opened(&root_meta);
    settle_tasks().await;
    assert_eq!(env.subscribed(), [SessionId::new(child)]);
}

/// An agent started in this process already has its forwarder: reopening its top-level session adopts the child
/// again, which must not subscribe a second consumer (the first to acknowledge hides the notice from the other).
#[tokio::test]
async fn a_child_keeps_one_forwarder_when_its_top_level_session_reopens() {
    use rust_cli_kernel_api::store::SessionStore;
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let launched = harness
        .call(
            ROOT,
            "Agent",
            json!({"description": "Shell owner", "prompt": "Go."}),
        )
        .await;
    let id = text(&launched)
        .split("agentId: ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .unwrap()
        .to_owned();
    let child = SessionId::new(format!("sess_subagent_{id}"));
    harness.started(1).await;
    until(|| env.subscribed() == std::slice::from_ref(&child)).await;
    let root_meta = harness
        .store
        .load(&SessionId::new(ROOT))
        .await
        .unwrap()
        .meta;
    harness.agents.signals().session_opened(&root_meta);
    settle_tasks().await;
    assert_eq!(env.subscribed(), std::slice::from_ref(&child));
    // The live agent still owns the child's notices: its mailbox, acknowledged once.
    env.finish(shell_notice(1, "b1"));
    until(|| env.acked() == [1]).await;
    gates.release(child.as_str());
    until(|| !harness.absorbed.lock().unwrap().is_empty()).await;
    let absorbed = harness.absorbed.lock().unwrap().clone();
    assert_eq!(absorbed.len(), 1, "{absorbed:?}");
    assert_eq!(absorbed[0].0, child);
    assert!(absorbed[0].1.contains("<task-id>b1</task-id>"));
}

/// Opening a subagent child session (a side tab) adopts nothing: its forwarder belongs to its top-level session.
#[tokio::test]
async fn opening_a_subagent_session_adopts_nothing() {
    use rust_cli_kernel_api::store::{SessionKind, SessionStore};
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let child = meta("sess_subagent_agent_old", SessionKind::Subagent, Some(ROOT));
    harness
        .store
        .create(meta(ROOT, SessionKind::Interactive, None))
        .await
        .unwrap();
    harness.store.create(child.clone()).await.unwrap();
    // A nested subagent under the child: only its top-level session's open adopts it, with that session as its root.
    harness
        .store
        .create(meta(
            "sess_subagent_agent_nested",
            SessionKind::Subagent,
            Some("sess_subagent_agent_old"),
        ))
        .await
        .unwrap();
    harness.agents.signals().session_opened(&child);
    settle_tasks().await;
    assert!(env.subscribed().is_empty());
}

/// A persisted child and its top-level session in the store; returns the top-level meta.
async fn persisted(
    harness: &crate::test_support::Harness,
    child: &str,
) -> rust_cli_kernel_api::store::SessionMeta {
    use rust_cli_kernel_api::store::{SessionKind, SessionStore};
    let root_meta = meta(ROOT, SessionKind::Interactive, None);
    harness.store.create(root_meta.clone()).await.unwrap();
    harness
        .store
        .create(meta(child, SessionKind::Subagent, Some(ROOT)))
        .await
        .unwrap();
    root_meta
}

/// Releasing a top-level session stops the forwarder of a child that no live agent owns: its notice stream is
/// dropped, and a notice that ends meanwhile stays pending. Reopening starts exactly one forwarder again, which
/// delivers it.
#[tokio::test]
async fn releasing_a_top_level_session_stops_an_unowned_childs_forwarder_until_it_reopens() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let child = SessionId::new("sess_subagent_agent_old");
    let root_meta = persisted(&harness, child.as_str()).await;
    let signals = harness.agents.signals();
    signals.session_opened(&root_meta);
    until(|| env.live_subscriptions() == 1).await;
    signals.session_closing(&SessionId::new(ROOT));
    until(|| env.live_subscriptions() == 0).await;
    env.finish(shell_notice(1, "b1"));
    settle_tasks().await;
    assert!(env.acked().is_empty());
    assert!(
        harness
            .agents
            .core
            .hub
            .pending(&SessionId::new(ROOT))
            .is_empty()
    );
    // Reopened: one forwarder again, and the pending notice reaches the top-level session.
    let mut root = signals.signals(&SessionId::new(ROOT));
    signals.session_opened(&root_meta);
    let notice = next_notice(&mut root).await;
    assert_eq!(notice.agent.as_str(), "b1");
    until(|| env.acked() == [1]).await;
    assert_eq!(env.live_subscriptions(), 1);
    assert_eq!(env.subscribed(), [child.clone(), child]);
}

/// `/clear` closes the top-level session while its subagent keeps running: the child's forwarder stays and the
/// notice reaches the agent's mailbox. Once the agent has finished, a later notice finds no owner and the session
/// closed: it is neither put in the Hub nor acknowledged, and the forwarder ends.
#[tokio::test]
async fn a_running_agent_keeps_its_forwarder_after_its_top_level_session_closes() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let launched = harness
        .call(
            ROOT,
            "Agent",
            json!({"description": "Shell owner", "prompt": "Go."}),
        )
        .await;
    let id = text(&launched)
        .split("agentId: ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .unwrap()
        .to_owned();
    let child = SessionId::new(format!("sess_subagent_{id}"));
    harness.started(1).await;
    until(|| env.live_subscriptions() == 1).await;
    let signals = harness.agents.signals();
    signals.session_closing(&SessionId::new(ROOT));
    settle_tasks().await;
    assert_eq!(env.live_subscriptions(), 1);
    env.finish(shell_notice(1, "b1"));
    until(|| env.acked() == [1]).await;
    gates.release(child.as_str());
    until(|| !harness.absorbed.lock().unwrap().is_empty()).await;
    let absorbed = harness.absorbed.lock().unwrap().clone();
    assert_eq!(absorbed[0].0, child);
    assert!(absorbed[0].1.contains("<task-id>b1</task-id>"));
    until(|| {
        !harness
            .agents
            .core
            .hub
            .pending(&SessionId::new(ROOT))
            .is_empty()
    })
    .await;
    // The agent finished (its own notice waits in the Hub); the session is closed.
    env.finish(shell_notice(2, "b2"));
    until(|| env.live_subscriptions() == 0).await;
    assert_eq!(env.acked(), [1]);
    let pending = harness.agents.core.hub.pending(&SessionId::new(ROOT));
    assert!(
        pending.iter().all(|agent| agent.as_str() != "b2"),
        "{pending:?}"
    );
}

/// A release that lands while adoption reads the store starts no forwarder.
#[tokio::test]
async fn a_release_during_adoption_starts_no_forwarder() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let root_meta = persisted(&harness, "sess_subagent_agent_old").await;
    let signals = harness.agents.signals();
    harness.children.hold();
    signals.session_opened(&root_meta);
    until(|| harness.children.reads() == 1).await;
    signals.session_closing(&SessionId::new(ROOT));
    harness.children.release();
    settle_tasks().await;
    assert!(env.subscribed().is_empty());
    assert_eq!(env.live_subscriptions(), 0);
}

/// Erasing a tree stops every forwarder of it, even one a running agent owns, and drops the Hub notices the erased
/// top-level session still held.
#[tokio::test]
async fn erasing_a_tree_stops_its_forwarders_and_drops_its_hub_notices() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let old = SessionId::new("sess_subagent_agent_old");
    let root_meta = persisted(&harness, old.as_str()).await;
    let signals = harness.agents.signals();
    signals.session_opened(&root_meta);
    until(|| env.live_subscriptions() == 1).await;
    let launched = harness
        .call(
            ROOT,
            "Agent",
            json!({"description": "Shell owner", "prompt": "Go."}),
        )
        .await;
    let id = text(&launched)
        .split("agentId: ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .unwrap()
        .to_owned();
    let running = SessionId::new(format!("sess_subagent_{id}"));
    harness.started(1).await;
    until(|| env.live_subscriptions() == 2).await;
    // The old child's notice waits in the Hub of the top-level session.
    env.finish_in(old.clone(), shell_notice(1, "b1"));
    until(|| {
        harness
            .agents
            .core
            .hub
            .pending(&SessionId::new(ROOT))
            .iter()
            .any(|agent| agent.as_str() == "b1")
    })
    .await;
    signals.sessions_erased(&[SessionId::new(ROOT), old, running]);
    until(|| env.live_subscriptions() == 0).await;
    assert!(
        harness
            .agents
            .core
            .hub
            .pending(&SessionId::new(ROOT))
            .is_empty()
    );
}

// Review of 40b851df7 (PR #404): one reproduction per lifecycle finding (specs/fork-rust-agent-parity.md, "After a
// restart, and on a remote executor"). Each failed on 40b851df7.

/// Waits up to 5 s of real time (multi-thread tests).
async fn within(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "{what}");
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
}

fn hub_count(harness: &crate::test_support::Harness, task: &str) -> usize {
    harness
        .agents
        .core
        .hub
        .pending(&SessionId::new(ROOT))
        .iter()
        .filter(|agent| agent.as_str() == task)
        .count()
}

/// Launches a background agent from `session` and returns its child session.
async fn launch_from(harness: &crate::test_support::Harness, session: &str) -> SessionId {
    let launched = harness
        .call(
            session,
            "Agent",
            json!({"description": "Builder", "prompt": "Build.", "run_in_background": true}),
        )
        .await;
    let id = text(&launched)
        .split("agentId: ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .unwrap()
        .to_owned();
    SessionId::new(format!("sess_subagent_{id}"))
}

/// #1: a release while the forwarder is between delivering and acknowledging must not let a reopen start a second
/// consumer of the same child (it would deliver the unacknowledged notice again).
#[tokio::test]
async fn a_reopen_while_the_forwarder_acknowledges_starts_no_second_consumer() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let child = SessionId::new("sess_subagent_agent_old");
    let root_meta = persisted(&harness, child.as_str()).await;
    let signals = harness.agents.signals();
    signals.session_opened(&root_meta);
    until(|| env.live_subscriptions() == 1).await;
    env.hold_acks();
    env.finish_in(child.clone(), shell_notice(1, "b1"));
    until(|| env.acks_started() == 1).await;
    signals.session_closing(&SessionId::new(ROOT));
    signals.session_opened(&root_meta);
    settle_tasks().await;
    assert_eq!(
        hub_count(&harness, "b1"),
        1,
        "the notice was delivered twice"
    );
    env.release_acks();
    until(|| env.acked() == [1]).await;
    settle_tasks().await;
    assert_eq!(hub_count(&harness, "b1"), 1);
    assert_eq!(env.live_subscriptions(), 1);
}

/// #2: erase decides under the lock that delivery decides under (Live), so no delivery can fall between its
/// checks and its Hub cleanup. While Live is held, erase waits.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn erase_waits_for_a_delivery_in_progress() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, false, machine(env));
    let core = harness.agents.core.clone();
    let (held_tx, held_rx) = std::sync::mpsc::channel::<()>();
    let (free_tx, free_rx) = std::sync::mpsc::channel::<()>();
    let holder = std::thread::spawn(move || {
        core.live.with(|_| {
            held_tx.send(()).unwrap();
            free_rx.recv().unwrap();
        });
    });
    held_rx.recv().unwrap();
    let signals = harness.agents.signals();
    let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
    let eraser = std::thread::spawn(move || {
        signals.sessions_erased(&[SessionId::new(ROOT)]);
        done_tx.send(()).unwrap();
    });
    let finished_early = done_rx
        .recv_timeout(std::time::Duration::from_millis(200))
        .is_ok();
    free_tx.send(()).unwrap();
    holder.join().unwrap();
    eraser.join().unwrap();
    assert!(
        !finished_early,
        "erase ran while a delivery held the Live lock"
    );
}

/// #3: erasing a child's subtree invalidates an adoption of its (still open) top-level session that read the store
/// before the erase.
#[tokio::test]
async fn erasing_a_child_during_adoption_starts_no_forwarder_for_it() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let child = SessionId::new("sess_subagent_agent_old");
    let root_meta = persisted(&harness, child.as_str()).await;
    let signals = harness.agents.signals();
    harness.children.hold();
    signals.session_opened(&root_meta);
    until(|| harness.children.reads() == 1).await;
    // The store no longer has the child once it is erased; the adoption read it before.
    harness.store.erase(&child);
    signals.sessions_erased(std::slice::from_ref(&child));
    harness.children.release();
    settle_tasks().await;
    assert!(!env.subscribed().contains(&child), "{:?}", env.subscribed());
}

/// #4: a forwarder kept at release for a running agent stops once that agent is gone, without waiting for a notice.
#[tokio::test]
async fn a_kept_forwarder_stops_when_its_agent_finishes_after_the_release() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let child = launch_from(&harness, ROOT).await;
    harness.started(1).await;
    until(|| env.live_subscriptions() == 1).await;
    harness
        .agents
        .signals()
        .session_closing(&SessionId::new(ROOT));
    settle_tasks().await;
    assert_eq!(env.live_subscriptions(), 1);
    gates.release(child.as_str());
    until(|| {
        harness
            .agents
            .core
            .live
            .background_in(&SessionId::new(ROOT))
            .is_empty()
    })
    .await;
    settle_tasks().await;
    assert_eq!(
        env.live_subscriptions(),
        0,
        "the kept forwarder outlived its agent"
    );
}

/// #5: after `/clear` a background subagent spawns a nested one. That must not reopen the closed top-level session:
/// a notice the nested child's finished agent cannot take stays pending, not acknowledged into an unread Hub.
#[tokio::test]
async fn a_nested_agent_after_clear_does_not_reopen_the_top_level_session() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let child = launch_from(&harness, ROOT).await;
    harness.started(1).await;
    harness
        .agents
        .signals()
        .session_closing(&SessionId::new(ROOT));
    let nested = launch_from(&harness, child.as_str()).await;
    harness.started(2).await;
    gates.release(nested.as_str());
    until(|| {
        harness.agents.core.live.with(|agents| {
            agents
                .values()
                .all(|agent| agent.child != nested || !agent.is_live())
        })
    })
    .await;
    env.finish_in(nested.clone(), shell_notice(7, "n7"));
    settle_tasks().await;
    assert!(!env.acked().contains(&7), "{:?}", env.acked());
    assert_eq!(hub_count(&harness, "n7"), 0);
}

/// A tracing subscriber that runs `hook` once on the event named `name` (a seam for an interleaving).
struct OnEvent {
    name: &'static str,
    hook: Arc<std::sync::OnceLock<Box<dyn Fn() + Send + Sync>>>,
    fired: Arc<std::sync::atomic::AtomicBool>,
}

struct FindEvent {
    want: &'static str,
    found: bool,
}

impl tracing::field::Visit for FindEvent {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        if field.name() == "event" && value == self.want {
            self.found = true;
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "event" && format!("{value:?}").trim_matches('"') == self.want {
            self.found = true;
        }
    }
}

impl tracing::Subscriber for OnEvent {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }

    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let mut find = FindEvent {
            want: self.name,
            found: false,
        };
        event.record(&mut find);
        if find.found
            && !self.fired.swap(true, std::sync::atomic::Ordering::SeqCst)
            && let Some(hook) = self.hook.get()
        {
            hook();
        }
    }

    fn enter(&self, _: &tracing::span::Id) {}

    fn exit(&self, _: &tracing::span::Id) {}
}

/// #6: a notice a kept forwarder cannot deliver, and a reopen that lands right after that refusal: the child must
/// still get a forwarder, which delivers the notice. On 40b851df7 the refusal and the removal of the registration
/// were two steps; the reopen in between saw the old registration and started nothing.
#[test]
fn a_reopen_right_after_a_refused_notice_still_delivers_it() {
    let hook: Arc<std::sync::OnceLock<Box<dyn Fn() + Send + Sync>>> = Arc::default();
    let fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let subscriber = Arc::new(OnEvent {
        name: "agents.subagent_notice.left_pending",
        hook: hook.clone(),
        fired: fired.clone(),
    });
    let on_start = subscriber;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .on_thread_start(move || {
            std::mem::forget(tracing::subscriber::set_default(on_start.clone()));
        })
        .build()
        .unwrap();
    runtime.block_on(async move {
        let gates = Gates::default();
        let env = Arc::new(NoticeEnvironment::replaying());
        let harness = held_with_env(&gates, false, machine(env.clone()));
        let child = launch_from(&harness, ROOT).await;
        harness.started(1).await;
        within("the child got no forwarder", || {
            env.live_subscriptions() == 1
        })
        .await;
        let signals = harness.agents.signals();
        let root_meta = rust_cli_kernel_api::store::SessionStore::load(
            harness.store.as_ref(),
            &SessionId::new(ROOT),
        )
        .await
        .unwrap()
        .meta;
        signals.session_closing(&SessionId::new(ROOT));
        gates.release(child.as_str());
        within("the agent did not finish", || {
            harness
                .agents
                .core
                .live
                .background_in(&SessionId::new(ROOT))
                .is_empty()
        })
        .await;
        // The reopen lands right after the refusal (on the forwarder's thread, before it unregisters).
        let reopen = signals.clone();
        let reopen_meta = root_meta.clone();
        let _ = hook.set(Box::new(move || {
            reopen.session_opened(&reopen_meta);
            // Hands this worker's queue to another thread, so the adoption runs while the forwarder is held here.
            tokio::task::block_in_place(|| {
                std::thread::sleep(std::time::Duration::from_millis(300))
            });
        }));
        env.finish_in(child.clone(), shell_notice(3, "b3"));
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if !fired.load(std::sync::atomic::Ordering::SeqCst) {
            // No refusal: the forwarder had already stopped, so the notice waits; reopen now.
            fired.store(true, std::sync::atomic::Ordering::SeqCst);
            signals.session_opened(&root_meta);
        }
        within(
            "the pending notice never reached the reopened session",
            || hub_count(&harness, "b3") == 1 && env.acked().contains(&3),
        )
        .await;
    });
}

fn state_of(
    harness: &crate::test_support::Harness,
    child: &SessionId,
) -> Option<crate::live::AgentState> {
    harness.agents.core.live.with(|agents| {
        agents
            .values()
            .find(|agent| &agent.child == child)
            .map(|agent| agent.state.clone())
    })
}

/// Round 3 #1: after `/clear`, a still-running background agent restarts its finished nested child with SendMessage.
/// The restart makes the nested child live again, so it needs a forwarder again: a command that ends in the resumed
/// run reaches it and is acknowledged.
#[tokio::test]
async fn a_nested_agent_restarted_after_clear_gets_a_forwarder_again() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, false, machine(env.clone()));
    let child = launch_from(&harness, ROOT).await;
    harness.started(1).await;
    harness
        .agents
        .signals()
        .session_closing(&SessionId::new(ROOT));
    let nested = launch_from(&harness, child.as_str()).await;
    harness.started(2).await;
    gates.release(nested.as_str());
    until(|| {
        state_of(&harness, &nested)
            .is_some_and(|state| matches!(state, crate::live::AgentState::Finished(_)))
    })
    .await;
    // Only the running child's forwarder is left.
    until(|| env.live_subscriptions() == 1).await;
    let agent = nested
        .as_str()
        .trim_start_matches("sess_subagent_")
        .to_owned();
    let sent = harness
        .call(
            child.as_str(),
            "SendMessage",
            json!({"to": agent, "message": "Again."}),
        )
        .await;
    assert!(text(&sent).contains("resumed"), "{}", text(&sent));
    harness.started(3).await;
    env.finish_in(nested.clone(), shell_notice(8, "n8"));
    until(|| env.acked().contains(&8)).await;
}

/// Round 3 #3: erasing a child's subtree while the child is parked on a command and its owner is parked on the child.
/// The erased child must end (as a user stop of a parked agent does), and its owner must not wait for it forever: the
/// owner gets the child's stop notice and resumes.
#[tokio::test]
async fn erasing_a_parked_child_ends_it_and_releases_its_owner() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    let harness = held_with_env(&gates, true, machine(env.clone()));
    let owner = launch_from(&harness, ROOT).await;
    harness.started(1).await;
    let child = launch_from(&harness, owner.as_str()).await;
    harness.started(2).await;
    env.run_in(child.clone(), shell_notice(1, "b1"));
    gates.release(child.as_str());
    until(|| {
        state_of(&harness, &child)
            .is_some_and(|state| matches!(state, crate::live::AgentState::Parked { .. }))
    })
    .await;
    gates.release(owner.as_str());
    until(|| {
        state_of(&harness, &owner)
            .is_some_and(|state| matches!(state, crate::live::AgentState::Parked { .. }))
    })
    .await;
    harness.store.erase(&child);
    harness
        .agents
        .signals()
        .sessions_erased(std::slice::from_ref(&child));
    settle_tasks().await;
    assert!(
        state_of(&harness, &child)
            .is_some_and(|state| matches!(state, crate::live::AgentState::Finished(_))),
        "the erased child is still live: {:?}",
        state_of(&harness, &child)
    );
    let resumed = harness.started(3).await;
    assert_eq!(
        resumed[2].request.session, owner,
        "the owner did not resume"
    );
    // The erased child is no longer addressable: SendMessage starts no run and no subscription for it.
    let subscribed = env.subscribed().len();
    let agent = child
        .as_str()
        .trim_start_matches("sess_subagent_")
        .to_owned();
    let sent = harness
        .call(
            owner.as_str(),
            "SendMessage",
            json!({"to": agent, "message": "Again."}),
        )
        .await;
    settle_tasks().await;
    assert!(!text(&sent).contains("resumed"), "{}", text(&sent));
    assert_eq!(harness.seen().len(), 3, "the erased child ran again");
    assert_eq!(env.subscribed().len(), subscribed);
}

/// Round 4 (Node parity): a running background agent blocks the erase of its tree. The kernel reports its child session
/// as running (Node `getDetachedChildSessionFacts().running`), a parked agent's child is not running (the erase ends it
/// as stopped), and since the refused erase never reaches the agents, the running agent goes on: a command notice
/// that ends meanwhile reaches it, and its own notice reaches the top-level session.
#[tokio::test]
async fn a_running_background_agent_blocks_the_erase_and_keeps_its_notices() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, true, machine(env.clone()));
    let mut root = harness.agents.signals().signals(&SessionId::new(ROOT));
    let parked = launch_from(&harness, ROOT).await;
    harness.started(1).await;
    env.run_in(parked.clone(), shell_notice(1, "b1"));
    gates.release(parked.as_str());
    until(|| {
        state_of(&harness, &parked)
            .is_some_and(|state| matches!(state, crate::live::AgentState::Parked { .. }))
    })
    .await;
    let parked_notice = next_notice(&mut root).await;
    let running = launch_from(&harness, ROOT).await;
    harness.started(2).await;
    let other = SessionId::new("sess_subagent_agent_other");
    let tree = [SessionId::new(ROOT), parked.clone(), running.clone(), other];
    assert_eq!(
        harness.agents.signals().running_agent_sessions(&tree),
        std::slice::from_ref(&running),
        "only the running agent's child blocks the erase"
    );
    // The erase was refused, so nothing reaches the agents: the agent keeps running and its notices are not lost.
    env.finish_in(running.clone(), shell_notice(2, "b2"));
    until(|| env.acked().contains(&2)).await;
    assert!(
        state_of(&harness, &running)
            .is_some_and(|state| matches!(state, crate::live::AgentState::Running { .. }))
    );
    gates.release(running.as_str());
    let own = next_notice(&mut root).await;
    assert_ne!(own.agent, parked_notice.agent);
    assert!(
        own.text.contains("<status>completed</status>"),
        "{}",
        own.text
    );
    let absorbed = harness.absorbed.lock().unwrap().clone();
    assert!(
        absorbed
            .iter()
            .any(|(session, text)| session == &running && text.contains("<task-id>b2</task-id>")),
        "{absorbed:?}"
    );
    assert_eq!(harness.seen().len(), 2, "the parked agent woke");
    assert!(
        harness
            .agents
            .signals()
            .running_agent_sessions(&tree)
            .is_empty()
    );
}

/// Round 4: an erase that slips past the guard (the agent started between the guard and the row erase) does not abort a
/// running agent. It is marked erased: no longer addressable and no longer reported as running.
#[tokio::test]
async fn an_erase_racing_a_running_agent_does_not_abort_it() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::default());
    let harness = held_with_env(&gates, true, machine(env.clone()));
    let running = launch_from(&harness, ROOT).await;
    harness.started(1).await;
    harness.store.erase(&running);
    harness
        .agents
        .signals()
        .sessions_erased(std::slice::from_ref(&running));
    settle_tasks().await;
    assert!(
        state_of(&harness, &running).is_some_and(|state| matches!(
            state,
            crate::live::AgentState::Running { abort, .. } if !abort.is_aborted()
        )),
        "{:?}",
        state_of(&harness, &running)
    );
    assert!(
        harness
            .agents
            .signals()
            .running_agent_sessions(std::slice::from_ref(&running))
            .is_empty()
    );
    gates.release(running.as_str());
    until(|| {
        state_of(&harness, &running)
            .is_some_and(|state| matches!(state, crate::live::AgentState::Finished(_)))
    })
    .await;
}

/// Review of df5d9c772: an agent that already finished when its subtree is erased is not addressable either. Before the
/// fix only live agents were marked erased, so SendMessage restarted the finished one: it claimed a new forwarder for
/// the erased child and its resume failed on the deleted row.
#[tokio::test]
async fn a_finished_agent_of_an_erased_subtree_is_not_restarted() {
    let gates = Gates::default();
    let env = Arc::new(NoticeEnvironment::replaying());
    let harness = held_with_env(&gates, true, machine(env.clone()));
    let mut root = harness.agents.signals().signals(&SessionId::new(ROOT));
    let child = launch_from(&harness, ROOT).await;
    harness.started(1).await;
    gates.release(child.as_str());
    let _own = next_notice(&mut root).await;
    until(|| {
        state_of(&harness, &child)
            .is_some_and(|state| matches!(state, crate::live::AgentState::Finished(_)))
    })
    .await;
    settle_tasks().await;
    let subscribed = env.subscribed().len();
    harness.store.erase(&child);
    harness
        .agents
        .signals()
        .sessions_erased(std::slice::from_ref(&child));
    settle_tasks().await;
    let agent = child
        .as_str()
        .trim_start_matches("sess_subagent_")
        .to_owned();
    let sent = harness
        .call(
            ROOT,
            "SendMessage",
            json!({"to": agent, "message": "Again."}),
        )
        .await;
    settle_tasks().await;
    assert!(!text(&sent).contains("resumed"), "{}", text(&sent));
    assert_eq!(harness.seen().len(), 1, "the erased agent ran again");
    assert_eq!(
        env.subscribed().len(),
        subscribed,
        "a forwarder was claimed for the erased child"
    );
}
