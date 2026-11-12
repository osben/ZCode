//! 子代理的询问交给谁（agents.md §4.1.1）：前台经父工具调用，后台经父会话的会话级入口，都没有时没人回答；
//! 询问写上子代理的名字，外层转发时不改。

use std::sync::Arc;

use rust_cli_kernel_api::ids::{AgentId, MessageId, SessionId, ToolUseId};
use rust_cli_kernel_api::orchestration::{InteractionRequest, Interactions, PermissionAnswer};
use rust_cli_kernel_api::testing::{MemoryStore, ScriptedInteractions, SequentialIds};
use serde_json::json;
use tokio::sync::mpsc;

use super::{Asks, ChildSink, Parent};
use crate::live::Live;

fn sink(parent: Option<Parent>, asks: Option<Asks>) -> ChildSink {
    ChildSink::new(
        Arc::new(MemoryStore::default()),
        Arc::new(SequentialIds::default()),
        Arc::new(Live::default()),
        AgentId::new("agent_1"),
        SessionId::new("sess_subagent_agent_1"),
        MessageId::new("prompt_1"),
        parent,
    )
    .asking("general-purpose", asks)
}

fn permission(asked_by: Option<&str>) -> InteractionRequest {
    InteractionRequest::Permission {
        origin: None,
        machine: Default::default(),
        tool_use: ToolUseId::new("toolu_1"),
        tool: "Bash".to_owned(),
        input: json!({"command": "touch a"}),
        message: "ask".to_owned(),
        suggestions: Vec::new(),
        rule_seed: None,
        asked_by: asked_by.map(str::to_owned),
        once: false,
        independent: false,
    }
}

fn asked_by(request: &InteractionRequest) -> Option<&str> {
    match request {
        InteractionRequest::Permission { asked_by, .. } => asked_by.as_deref(),
        _ => None,
    }
}

#[tokio::test]
async fn a_background_agent_asks_through_the_session_entry_with_its_name() {
    let entry = Arc::new(ScriptedInteractions::allowing());
    let sink = sink(None, Some(Asks(entry.clone())));
    let answer = sink.ask(permission(None)).await.unwrap();
    assert_eq!(answer.answer.decision(), "allow");
    let asked = entry.asked();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked_by(&asked[0]), Some("general-purpose"));
    // 撤回也经同一个入口；子代理里再派生的后台子代理拿到同一个入口。
    sink.cancel_ask(&ToolUseId::new("toolu_1")).await;
    assert_eq!(entry.withdrawn(), vec![ToolUseId::new("toolu_1")]);
    let lasting = sink.lasting().unwrap();
    lasting.ask(permission(Some("Explore"))).await.unwrap();
    assert_eq!(entry.asked().len(), 2);
}

#[tokio::test]
async fn the_innermost_agent_keeps_its_name_when_forwarded() {
    let parent = Arc::new(ScriptedInteractions::allowing());
    let (progress, _updates) = mpsc::channel(4);
    let sink = sink(
        Some(Parent {
            session: SessionId::new("sess_main"),
            asks: parent.clone(),
            ops: Arc::new(rust_cli_kernel_api::testing::NoSession),
            progress,
        }),
        None,
    );
    sink.ask(permission(Some("Explore"))).await.unwrap();
    let asked = parent.asked();
    assert_eq!(asked_by(&asked[0]), Some("Explore"));
    // 前台子代理没有自己的入口：会话级入口来自父工具调用（这个替身不给）。
    assert!(sink.lasting().is_none());
}

/// 没有入口的后台子代理（`-p`）不询问：权限按“没有询问的入口”回答，管线据此给拒绝的文字（agents.md §4.1.1）。
#[tokio::test]
async fn without_an_entry_a_background_agent_is_not_asked() {
    let sink = sink(None, None);
    let answer = sink.ask(permission(None)).await.unwrap();
    assert_eq!(answer.answer, PermissionAnswer::NoPrompts.into());
    assert!(sink.lasting().is_none());
}

/// Fork (B3 review): the ask's origin is fixed when the run starts (Node's subagent ask always carries
/// `payload.origin`). An agent no longer in `live` still asks with its origin, so the App offers no permission mode
/// switch for it.
#[tokio::test]
async fn the_origin_is_fixed_at_run_start_even_when_the_agent_left_live() {
    use crate::live::{AgentState, LiveAgent};
    let agent = LiveAgent {
        machine: Default::default(),
        agent: AgentId::new("agent_1"),
        child: SessionId::new("sess_subagent_agent_1"),
        parent: SessionId::new("sess_main"),
        root: SessionId::new("sess_main"),
        owner: None,
        depth: 1,
        tool_use: Some(ToolUseId::new("toolu_parent")),
        description: "explore".to_owned(),
        definition: Arc::new(
            crate::definitions::builtins()
                .into_iter()
                .find(|definition| definition.agent_type == "Explore")
                .unwrap(),
        ),
        workspace: crate::test_support::workspace(),
        execution_worktree: false,
        selection: rust_cli_kernel_api::testing::selection(),
        mode: rust_cli_kernel_api::permission::PermissionMode::Default,
        background: true,
        asks: None,
        state: AgentState::Running {
            abort: rust_cli_kernel_api::abort::Abort::new(),
            mailbox: Vec::new(),
        },
        shown: crate::live::Shown::default(),
        delivered: Vec::new(),
        fork_prefix: None,
        stopped_by_user: false,
        erased: false,
        late_messages: Vec::new(),
    };
    let entry = Arc::new(ScriptedInteractions::allowing());
    // `live` is empty: the agent is not (or no longer) registered there.
    let sink = sink(None, Some(Asks(entry.clone()))).with_origin(&agent);
    sink.ask(permission(None)).await.unwrap();
    let asked = entry.asked();
    let InteractionRequest::Permission {
        origin: Some(origin),
        ..
    } = &asked[0]
    else {
        panic!("no origin: {:?}", asked[0]);
    };
    assert_eq!(origin.agent, AgentId::new("agent_1"));
    assert_eq!(origin.agent_type, "Explore");
    assert_eq!(origin.parent_tool_use, Some(ToolUseId::new("toolu_parent")));
}
