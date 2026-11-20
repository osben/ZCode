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

use crate::test_support::{harness, text};

/// The session's workflow runs as the run port answers them. `cancel` records the initiator and answers for the live ids
/// only. `settled` is the journal row of a run that already ended.
#[derive(Default)]
struct Runs {
    live: Vec<String>,
    settled: Option<(String, String)>,
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
        self.cancels
            .lock_unpoisoned()
            .push((run_id.as_str().to_owned(), initiator));
        Ok(self.live.iter().any(|id| id == run_id.as_str()))
    }

    async fn get_run_detail(
        &self,
        run_id: &WorkflowRunId,
    ) -> Result<Option<Value>, DynamicWorkflowRunError> {
        // A live run reads as running (its gap form, 9.42); a settled one reads as its journal status.
        let status = if self.live.iter().any(|id| id == run_id.as_str()) {
            Some("running".to_owned())
        } else {
            self.settled
                .as_ref()
                .filter(|(id, _)| id == run_id.as_str())
                .map(|(_, status)| status.clone())
        };
        Ok(status.map(|status| json!({"runId": run_id.as_str(), "status": status, "ownedByThisSession": true})))
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
