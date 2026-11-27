//! Fork (W8a, 9.48): TaskStop and the user's stop of a workflow run go through the run port, the same path as a
//! background command or subagent (Node `stopDynamicWorkflowBackgroundTask`, reached from `stopBackgroundTask`).

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::{OperationContext, Origin};
use rust_cli_kernel_api::ids::{EnvironmentId, Generation, OperationId, SessionId, WorkflowRunId};
use rust_cli_kernel_api::workflow_run::{
    CancelInitiator, DynamicWorkflowRunError, DynamicWorkflowRunPort, DynamicWorkflowRunSessions,
};
use serde_json::{Value, json};
use tokio::sync::Notify;

use crate::test_support::{harness, text};

/// The session's workflow runs as the run port answers them. `cancel` records the initiator and answers for the live ids
/// only. `settled` is the journal row of a run that already ended.
#[derive(Default)]
struct Runs {
    live: Vec<String>,
    settled: Option<(String, String)>,
    /// Journal rows of other sessions: readable, but `ownedByThisSession` is false.
    foreign: Vec<String>,
    /// Every read and cancel fails with a real error (not the unsupported fallback).
    fail: bool,
    cancels: Mutex<Vec<(String, CancelInitiator)>>,
}

impl Runs {
    fn live(ids: &[&str]) -> Arc<Self> {
        Arc::new(Self {
            live: ids.iter().map(|id| (*id).to_owned()).collect(),
            ..Self::default()
        })
    }

    fn recorded(&self) -> Vec<(String, CancelInitiator)> {
        self.cancels.lock_unpoisoned().clone()
    }
}

#[async_trait]
impl DynamicWorkflowRunPort for Runs {
    async fn cancel(
        &self,
        run_id: &WorkflowRunId,
        initiator: CancelInitiator,
    ) -> Result<bool, DynamicWorkflowRunError> {
        if self.fail {
            return Err(DynamicWorkflowRunError::new("the run read did not finish"));
        }
        // Only a live run of the session is stopped (the service answers false for anything else, with no stop).
        if !self.live.iter().any(|id| id == run_id.as_str()) {
            return Ok(false);
        }
        self.cancels
            .lock_unpoisoned()
            .push((run_id.as_str().to_owned(), initiator));
        Ok(true)
    }

    async fn get_run_detail(
        &self,
        run_id: &WorkflowRunId,
    ) -> Result<Option<Value>, DynamicWorkflowRunError> {
        if self.fail {
            return Err(DynamicWorkflowRunError::new("the run read did not finish"));
        }
        if self.foreign.iter().any(|id| id == run_id.as_str()) {
            return Ok(Some(json!({
                "runId": run_id.as_str(),
                "status": "running",
                "ownedByThisSession": false,
            })));
        }
        // A live run reads as running (its gap form, 9.42); a settled one reads as its journal status.
        let status = if self.live.iter().any(|id| id == run_id.as_str()) {
            Some("running".to_owned())
        } else {
            self.settled
                .as_ref()
                .filter(|(id, _)| id == run_id.as_str())
                .map(|(_, status)| status.clone())
        };
        Ok(status.map(
            |status| json!({"runId": run_id.as_str(), "status": status, "ownedByThisSession": true}),
        ))
    }
}

/// The same runs for every session; the tests use one parent.
struct OneSession(Arc<Runs>);

impl DynamicWorkflowRunSessions for OneSession {
    fn for_session(&self, _session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        self.0.clone()
    }
}

fn user_operation() -> OperationContext {
    OperationContext::new(
        EnvironmentId::new("local"),
        Generation::new("g1"),
        OperationId::new("op_user"),
        Origin::User {
            session: Some(SessionId::new("sess_parent")),
        },
    )
}

/// The model's TaskStop of a live run reaches the run port as the model's stop, and reports the run's type.
#[tokio::test]
async fn taskstop_stops_a_live_workflow_run_through_the_run_port() {
    let harness = harness(None);
    let runs = Runs::live(&["wf_run_1"]);
    assert!(
        harness
            .agents
            .set_run_sessions(Arc::new(OneSession(runs.clone())))
    );
    let output = harness
        .call("sess_parent", "TaskStop", json!({"task_id": "wf_run_1"}))
        .await;
    assert!(!output.is_error, "{}", text(&output));
    assert!(text(&output).contains("local_dynamic_workflow"));
    assert_eq!(
        runs.recorded(),
        vec![("wf_run_1".to_owned(), CancelInitiator::Model)]
    );
}

/// The user's stop (the GUI cancel and `/tasks`, which both reach `stop_task`) reaches the same port as the user.
#[tokio::test]
async fn the_user_stops_a_workflow_run_through_the_same_path() {
    let harness = harness(None);
    let runs = Runs::live(&["wf_run_1"]);
    assert!(
        harness
            .agents
            .set_run_sessions(Arc::new(OneSession(runs.clone())))
    );
    let parent = SessionId::new("sess_parent");
    let stopped = harness
        .agents
        .signals()
        .stop_task(&parent, "wf_run_1", user_operation())
        .await;
    assert!(stopped.is_ok(), "{stopped:?}");
    assert_eq!(
        runs.recorded(),
        vec![("wf_run_1".to_owned(), CancelInitiator::User)]
    );
}

/// A run that already ended is not running for TaskStop, as Node's strict `background_task_not_running`.
#[tokio::test]
async fn taskstop_of_a_settled_workflow_run_says_it_is_not_running() {
    let harness = harness(None);
    let runs = Arc::new(Runs {
        settled: Some(("wf_run_2".to_owned(), "stopped".to_owned())),
        ..Runs::default()
    });
    assert!(harness.agents.set_run_sessions(Arc::new(OneSession(runs))));
    let output = harness
        .call("sess_parent", "TaskStop", json!({"task_id": "wf_run_2"}))
        .await;
    assert!(output.is_error);
    assert_eq!(
        text(&output),
        "Task wf_run_2 is not running (status: stopped)"
    );
}

/// An id that is no run of the session keeps the existing answer.
#[tokio::test]
async fn an_unknown_id_is_still_no_task_found_with_a_run_port_wired() {
    let harness = harness(None);
    assert!(
        harness
            .agents
            .set_run_sessions(Arc::new(OneSession(Runs::live(&["wf_run_1"]))))
    );
    let output = harness
        .call("sess_parent", "TaskStop", json!({"task_id": "nope"}))
        .await;
    assert_eq!(
        text(&output),
        "<tool_use_error>No task found with ID: nope</tool_use_error>"
    );
}

/// Another session's run is readable but not this session's: TaskStop and the user's stop both say no task, and nothing is
/// cancelled (the ownership flag is the guard, 9.48).
#[tokio::test]
async fn a_run_of_another_session_is_no_task_for_this_one() {
    let harness = harness(None);
    let runs = Arc::new(Runs {
        foreign: vec!["wf_run_3".to_owned()],
        ..Runs::default()
    });
    assert!(
        harness
            .agents
            .set_run_sessions(Arc::new(OneSession(runs.clone())))
    );
    let output = harness
        .call("sess_parent", "TaskStop", json!({"task_id": "wf_run_3"}))
        .await;
    assert_eq!(
        text(&output),
        "<tool_use_error>No task found with ID: wf_run_3</tool_use_error>"
    );
    let stopped = harness
        .agents
        .signals()
        .stop_task(&SessionId::new("sess_parent"), "wf_run_3", user_operation())
        .await;
    assert_eq!(stopped, Err("No task found with ID: wf_run_3".to_owned()));
    assert!(runs.recorded().is_empty(), "nothing was cancelled");
}

/// A real failure of the run port is surfaced, not reported as no task (only the unsupported fallback means "not a run").
#[tokio::test]
async fn a_failed_run_port_is_surfaced_not_reported_as_no_task() {
    let harness = harness(None);
    let runs = Arc::new(Runs {
        live: vec!["wf_run_1".to_owned()],
        fail: true,
        ..Runs::default()
    });
    assert!(harness.agents.set_run_sessions(Arc::new(OneSession(runs))));
    let parent = SessionId::new("sess_parent");
    let stopped = harness
        .agents
        .signals()
        .stop_task(&parent, "wf_run_1", user_operation())
        .await;
    let message = stopped.expect_err("the failure is the stop's answer");
    assert!(message.contains("the run read did not finish"), "{message}");
    assert!(!message.contains("No task found"), "{message}");
    let output = harness
        .call("sess_parent", "TaskStop", json!({"task_id": "wf_run_1"}))
        .await;
    assert!(output.is_error);
    assert!(
        text(&output).contains("the run read did not finish"),
        "{}",
        text(&output)
    );
}

/// One run port per session, as the run service hands them out.
struct PerSession(Vec<(&'static str, Arc<Runs>)>);

impl DynamicWorkflowRunSessions for PerSession {
    fn for_session(&self, session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        self.0
            .iter()
            .find(|(id, _)| *id == session.as_str())
            .map_or_else(|| Runs::live(&[]), |(_, runs)| runs.clone())
    }
}

/// Divergence 610: Node's subagent runtimes share the parent's task registry, so the top-level session stops a run that
/// one of its subagents started. The subagent's own session is the one that owns the run in the run service.
#[tokio::test]
async fn the_main_thread_stops_a_run_started_by_its_subagent() {
    let harness = harness(Some(Arc::new(Notify::new())));
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Run owner", "prompt": "Start a run."}),
        )
        .await;
    harness.started(1).await;
    let parent = Runs::live(&[]);
    let child = Runs::live(&["wf_child_run"]);
    assert!(harness.agents.set_run_sessions(Arc::new(PerSession(vec![
        ("sess_parent", parent.clone()),
        ("sess_subagent_agent_1", child.clone()),
    ]))));
    let output = harness
        .call(
            "sess_parent",
            "TaskStop",
            json!({"task_id": "wf_child_run"}),
        )
        .await;
    assert!(!output.is_error, "{}", text(&output));
    assert!(text(&output).contains("local_dynamic_workflow"));
    assert_eq!(
        child.recorded(),
        vec![("wf_child_run".to_owned(), CancelInitiator::Model)]
    );
    assert!(parent.recorded().is_empty());
}

/// A session outside the top-level session's tree does not see the subagent's run.
#[tokio::test]
async fn another_session_does_not_see_a_subagents_run() {
    let harness = harness(Some(Arc::new(Notify::new())));
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Run owner", "prompt": "Start a run."}),
        )
        .await;
    harness.started(1).await;
    let child = Runs::live(&["wf_child_run"]);
    assert!(harness.agents.set_run_sessions(Arc::new(PerSession(vec![(
        "sess_subagent_agent_1",
        child.clone()
    )]))));
    let output = harness
        .call("sess_other", "TaskStop", json!({"task_id": "wf_child_run"}))
        .await;
    assert!(output.is_error);
    assert!(text(&output).contains("No task found"), "{}", text(&output));
    assert!(child.recorded().is_empty());
}

/// A subagent stops only the runs of its own session, as it does for commands (L18).
#[tokio::test]
async fn a_subagent_does_not_stop_a_run_of_its_parent() {
    let harness = harness(Some(Arc::new(Notify::new())));
    harness
        .call(
            "sess_parent",
            "Agent",
            json!({"description": "Run owner", "prompt": "Start a run."}),
        )
        .await;
    harness.started(1).await;
    let parent = Runs::live(&["wf_parent_run"]);
    assert!(
        harness
            .agents
            .set_run_sessions(Arc::new(PerSession(vec![("sess_parent", parent.clone())])))
    );
    let output = harness
        .call(
            "sess_subagent_agent_1",
            "TaskStop",
            json!({"task_id": "wf_parent_run"}),
        )
        .await;
    assert!(output.is_error);
    assert!(parent.recorded().is_empty());
}
