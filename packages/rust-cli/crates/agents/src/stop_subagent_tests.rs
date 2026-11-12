//! Fork: the desktop's guarded subagent stop (`stopSubagent`, specs/fork-rust-agent-parity.md B2).

use std::sync::Arc;

use futures_util::StreamExt;
use rust_cli_kernel_api::agents::{AgentSignal, SubagentStopRefusal};
use rust_cli_kernel_api::env::OperationContext;
use rust_cli_kernel_api::env_shell::BackgroundStatus;
use rust_cli_kernel_api::ids::{AgentId, OperationId, SessionId};
use rust_cli_kernel_api::panels::SubagentStatus;
use serde_json::json;
use tokio::sync::Notify;

use crate::test_support::{harness, text};

fn operation(session: &SessionId) -> OperationContext {
    OperationContext::new(
        rust_cli_kernel_api::ids::EnvironmentId::new("local"),
        rust_cli_kernel_api::ids::Generation::new("g1"),
        OperationId::new("op_user"),
        rust_cli_kernel_api::env::Origin::User {
            session: Some(session.clone()),
        },
    )
}

/// The first run is execution 0; a stop that names it ends the agent as the user's, and a second stop of the
/// ended agent is `not_running`.
#[tokio::test]
async fn a_stop_naming_the_current_run_ends_it() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work."}),
        )
        .await;
    harness.started(1).await;
    let entries = signals.subagents(&parent).await;
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].execution, 0);
    let agent = AgentId::new("agent_1");
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "0", operation(&parent))
            .await,
        Ok(())
    );
    let Some(AgentSignal::Notice(notice)) = stream.next().await else {
        panic!("expected a notice");
    };
    assert_eq!(notice.status, BackgroundStatus::Killed);
    assert_eq!(
        signals.subagents(&parent).await[0].status,
        SubagentStatus::Killed
    );
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "0", operation(&parent))
            .await,
        Err(SubagentStopRefusal::NotRunning)
    );
}

/// A stop that names another run is refused and leaves the agent running.
#[tokio::test]
async fn a_stop_naming_another_run_is_refused() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work."}),
        )
        .await;
    harness.started(1).await;
    let agent = AgentId::new("agent_1");
    for stale in ["1", "x"] {
        assert_eq!(
            signals
                .stop_subagent(&parent, &agent, stale, operation(&parent))
                .await,
            Err(SubagentStopRefusal::NotRunning)
        );
    }
    assert_eq!(
        signals.subagents(&parent).await[0].status,
        SubagentStatus::Running
    );
}

/// Only the session that spawned the agent may stop it; an unknown agent is `not_found`.
#[tokio::test]
async fn another_session_or_an_unknown_agent_is_not_found() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let other = SessionId::new("sess_other");
    let signals = harness.agents.signals();
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work."}),
        )
        .await;
    harness.started(1).await;
    assert_eq!(
        signals
            .stop_subagent(&other, &AgentId::new("agent_1"), "0", operation(&other))
            .await,
        Err(SubagentStopRefusal::NotFound)
    );
    assert_eq!(
        signals
            .stop_subagent(&parent, &AgentId::new("agent_9"), "0", operation(&parent))
            .await,
        Err(SubagentStopRefusal::NotFound)
    );
    assert_eq!(
        signals.subagents(&parent).await[0].status,
        SubagentStatus::Running
    );
}

/// A SendMessage resume is a new run: its execution is 1, and a late stop of run 0 cannot end it.
#[tokio::test]
async fn a_resume_is_a_new_run() {
    let gate = Arc::new(Notify::new());
    let harness = harness(Some(gate.clone()));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Long job", "prompt": "Work."}),
        )
        .await;
    harness.started(1).await;
    let agent = AgentId::new("agent_1");
    signals
        .stop_subagent(&parent, &agent, "0", operation(&parent))
        .await
        .unwrap();
    let Some(AgentSignal::Notice(_)) = stream.next().await else {
        panic!("expected a notice");
    };
    let resumed = text(
        &harness
            .call(
                "sess_parent",
                "SendMessage",
                json!({"to": "agent_1", "message": "Go on."}),
            )
            .await,
    );
    assert!(resumed.contains("resumed"), "{resumed}");
    harness.started(2).await;
    let entries = signals.subagents(&parent).await;
    assert_eq!(entries[0].status, SubagentStatus::Running);
    assert_eq!(entries[0].execution, 1);
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "0", operation(&parent))
            .await,
        Err(SubagentStopRefusal::NotRunning)
    );
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "1", operation(&parent))
            .await,
        Ok(())
    );
}

/// A background agent of `sess_parent` that no query drives: the tests settle and park it by hand, so the transitions
/// they check are not raced by a real run.
fn undriven(harness: &crate::test_support::Harness, agent: &str) -> AgentId {
    use rust_cli_kernel_api::abort::Abort;
    let entry = crate::live::LiveAgent {
        machine: Default::default(),
        agent: AgentId::new(agent),
        child: SessionId::new(format!("sess_subagent_{agent}")),
        parent: SessionId::new("sess_parent"),
        root: SessionId::new("sess_parent"),
        owner: None,
        depth: 1,
        tool_use: None,
        description: "Undriven".to_owned(),
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
        state: crate::live::AgentState::Running {
            abort: Abort::new(),
            mailbox: Vec::new(),
        },
        shown: crate::live::Shown::default(),
        delivered: Vec::new(),
        fork_prefix: None,
        stopped_by_user: false,
        erased: false,
    };
    harness.agents.core.live.insert(entry);
    AgentId::new(agent)
}

fn completed() -> crate::spawn::Finished {
    crate::spawn::Finished {
        ending: crate::report::Ending::Completed,
        report: crate::report::Report::default(),
        error: None,
    }
}

fn execution(harness: &crate::test_support::Harness, agent: &AgentId) -> u64 {
    harness.agents.core.live.get(agent).unwrap().shown.execution
}

/// Codex review of #418 (1): a run that ends with a stranded SendMessage message is replaced by a new run in the same
/// lock section. That new run gets a new execution, so a late stop of the ended run cannot end it.
#[tokio::test]
async fn a_run_replaced_in_the_settling_section_is_a_new_execution() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let agent = undriven(&harness, "agent_u");
    assert!(
        harness
            .agents
            .core
            .live
            .enqueue(&agent, "Go on.".to_owned())
    );
    let settled = crate::routing::settle(&harness.agents.core, &agent, &completed()).await;
    assert!(!settled.parked);
    assert_eq!(settled.ending, crate::report::Ending::Completed);
    assert!(matches!(
        harness.agents.core.live.get(&agent).unwrap().state,
        crate::live::AgentState::Running { .. }
    ));
    assert_eq!(execution(&harness, &agent), 1);
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "0", operation(&parent))
            .await,
        Err(SubagentStopRefusal::NotRunning)
    );
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "1", operation(&parent))
            .await,
        Ok(())
    );
}

/// Codex review of #418 (2): a stop accepted after the query returned `Completed`, before the run settled, claims the
/// ending: the run ends as killed and its notice is a stop, never `finished`.
#[tokio::test]
async fn an_accepted_stop_claims_the_ending_of_a_completed_query() {
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let signals = harness.agents.signals();
    let mut stream = signals.signals(&parent);
    let agent = undriven(&harness, "agent_u");
    assert_eq!(
        signals
            .stop_subagent(&parent, &agent, "0", operation(&parent))
            .await,
        Ok(())
    );
    let settled = crate::routing::settle(&harness.agents.core, &agent, &completed()).await;
    assert_eq!(settled.ending, crate::report::Ending::Killed);
    assert!(matches!(
        harness.agents.core.live.get(&agent).unwrap().state,
        crate::live::AgentState::Finished(crate::report::Ending::Killed)
    ));
    let Some(AgentSignal::Notice(notice)) = stream.next().await else {
        panic!("expected a notice");
    };
    assert_eq!(notice.status, BackgroundStatus::Killed);
    assert!(
        notice.text.contains("was stopped by user"),
        "{}",
        notice.text
    );
    assert!(!notice.text.contains("finished"), "{}", notice.text);
}

/// Codex review of #418 (3): a parked agent's stop names the execution it checked. When another notice woke the agent
/// and it parked again in a later execution, the stale stop leaves it parked.
#[tokio::test]
async fn a_stale_stop_leaves_an_agent_parked_again_in_a_later_execution() {
    use crate::live::AgentState;
    use rust_cli_kernel_api::abort::Abort;
    let harness = harness(Some(Arc::new(Notify::new())));
    let parent = SessionId::new("sess_parent");
    let agent = undriven(&harness, "agent_u");
    let live = &harness.agents.core.live;
    let park = || {
        live.with(|agents| {
            agents.get_mut(&agent).unwrap().state = AgentState::Parked {
                report: crate::report::Report::default(),
                notified: true,
            };
        });
    };
    park();
    let checked = match live.stop_execution(&parent, &agent, "0") {
        crate::live::GuardedStop::Parked(execution) => execution,
        other => panic!("expected parked, got {other:?}"),
    };
    assert_eq!(checked, 0);
    // Between the check and the transition a notice wakes it (execution 1) and it parks again.
    live.with(|agents| {
        agents
            .get_mut(&agent)
            .unwrap()
            .begin_run(Abort::new(), Vec::new());
    });
    park();
    assert_eq!(execution(&harness, &agent), 1);
    assert!(crate::routing::stop_parked(&harness.agents.core, &agent, Some(checked)).is_none());
    assert!(matches!(
        live.get(&agent).unwrap().state,
        AgentState::Parked { .. }
    ));
    assert!(crate::routing::stop_parked(&harness.agents.core, &agent, Some(1)).is_some());
    assert!(matches!(
        live.get(&agent).unwrap().state,
        AgentState::Finished(crate::report::Ending::KilledParked)
    ));
}
