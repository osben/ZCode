//! Fork (9.55, divergence 850-852): `/tasks`' Workflows list reads the session's live workflow runs through the run port,
//! the same port the stop reaches (9.48), and a run that settles on its own is a change the list re-reads (9.52, 749).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
use rust_cli_kernel_api::workflow_run::{
    BackgroundRunStatus, BackgroundRunWork, DynamicWorkflowRunError, DynamicWorkflowRunPort,
    DynamicWorkflowRunSessions,
};
use tokio::sync::watch;

use crate::test_support::harness;

/// The session's runs in launch order, as the run port answers them. `settle` ends one and ticks the change channel, as
/// the run service does when a run ends on its own. The ended run stays listed with a terminal status and its end, as
/// the run service keeps it since 9.65 (911), so `/tasks` must filter it out.
struct Board {
    runs: Mutex<Vec<BackgroundRunWork>>,
    changes: watch::Sender<u64>,
}

impl Board {
    fn new(runs: &[(&str, i64)]) -> Arc<Self> {
        let (changes, _) = watch::channel(0);
        Arc::new(Self {
            runs: Mutex::new(
                runs.iter()
                    .map(|(id, at)| BackgroundRunWork {
                        run_id: WorkflowRunId::new(*id),
                        title: (*id).to_owned(),
                        started_at_ms: *at,
                        status: BackgroundRunStatus::Running,
                        ended_at_ms: None,
                    })
                    .collect(),
            ),
            changes,
        })
    }

    fn settle(&self, id: &str) {
        for run in self.runs.lock_unpoisoned().iter_mut() {
            if run.run_id.as_str() == id {
                run.status = BackgroundRunStatus::ResultPending;
                run.ended_at_ms = Some(run.started_at_ms + 1_000);
            }
        }
        self.changes.send_modify(|tick| *tick += 1);
    }
}

#[async_trait]
impl DynamicWorkflowRunPort for Board {
    async fn background_runs(&self) -> Result<Vec<BackgroundRunWork>, DynamicWorkflowRunError> {
        Ok(self.runs.lock_unpoisoned().clone())
    }

    fn background_changes(&self) -> Option<watch::Receiver<u64>> {
        Some(self.changes.subscribe())
    }
}

struct OneSession(Arc<Board>);

impl DynamicWorkflowRunSessions for OneSession {
    fn for_session(&self, _session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        self.0.clone()
    }
}

fn parent() -> SessionId {
    SessionId::new("sess_parent")
}

fn ids(snapshot: &rust_cli_kernel_api::panels::TasksSnapshot) -> Vec<String> {
    snapshot
        .workflows
        .iter()
        .map(|run| run.id.clone())
        .collect()
}

/// The snapshot carries the live runs in launch order with their start times, and a run that settled leaves it.
#[tokio::test]
async fn the_snapshot_lists_the_live_runs_in_launch_order_and_drops_a_settled_one() {
    let harness = harness(None);
    let board = Board::new(&[("wf_first", 10), ("wf_second", 20)]);
    assert!(
        harness
            .agents
            .set_run_sessions(Arc::new(OneSession(board.clone())))
    );
    let signals = harness.agents.signals();
    let snapshot = signals.tasks_snapshot(&parent()).await;
    assert_eq!(ids(&snapshot), ["wf_first", "wf_second"]);
    assert_eq!(snapshot.workflows[1].started_at_ms, 20);
    assert!(
        snapshot.background.is_empty(),
        "a run is not a background command"
    );

    board.settle("wf_first");
    let snapshot = signals.tasks_snapshot(&parent()).await;
    assert_eq!(ids(&snapshot), ["wf_second"]);
}

/// A run that settles on its own is a change of the session's runs, so the task list re-reads without a kernel event.
#[tokio::test]
async fn a_run_that_settles_on_its_own_is_a_change_of_the_session() {
    let harness = harness(None);
    let board = Board::new(&[("wf_only", 10)]);
    assert!(
        harness
            .agents
            .set_run_sessions(Arc::new(OneSession(board.clone())))
    );
    let mut changes = harness
        .agents
        .signals()
        .workflow_changes(&parent())
        .expect("a run port is wired, so the session has a change stream");
    board.settle("wf_only");
    let tick = tokio::time::timeout(Duration::from_secs(2), changes.next()).await;
    assert!(matches!(tick, Ok(Some(()))), "{tick:?}");
}

/// Without a run port the snapshot has no runs and there is no change stream: nothing new shows, as before.
#[tokio::test]
async fn no_run_port_means_no_workflows_and_no_change_stream() {
    let harness = harness(None);
    let signals = harness.agents.signals();
    assert!(signals.tasks_snapshot(&parent()).await.workflows.is_empty());
    assert!(signals.workflow_changes(&parent()).is_none());
}
