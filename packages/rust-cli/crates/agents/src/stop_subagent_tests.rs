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
