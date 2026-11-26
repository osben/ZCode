//! Fork: the `Live` wiring of `completedActivityCount` (specs/fork-rust-completed-activity-count.md): the open seeds
//! the full history in the pump, the subagent table and the run deltas move it, and the snapshot carries it.

use rust_cli_kernel_api::ids::{AgentId, MachineName};
use rust_cli_kernel_api::panels::{SubagentEntry, SubagentStatus};

use super::*;
use crate::fork::workspace_trust::tests::settled;

fn agent_part(child: &str) -> Value {
    json!({
        "callId": format!("toolu_{child}"),
        "tool": "Agent",
        "status": "completed",
        "input": {},
        "metadata": {"childSessionId": child, "agentId": format!("agent_{child}")},
    })
}

fn entry(child: &str, status: SubagentStatus) -> SubagentEntry {
    SubagentEntry {
        execution_id: String::new(),
        execution: 0,
        previous: None,
        agent: AgentId::new(format!("agent_{child}")),
        child: SessionId::new(child),
        agent_type: "Explore".to_owned(),
        description: "scan".to_owned(),
        status,
        background: false,
        waiting: false,
        elapsed_ms: 1,
        ended_ago_ms: (status != SubagentStatus::Running).then_some(1),
        version: 1,
        owner: None,
        activity: None,
        parked: false,
        machine: MachineName::primary(),
    }
}

/// An open `s1` whose store holds settled Agent parts for `children`, with the kernel's subagent table readable.
async fn open_with_children(
    children: &[&str],
) -> (TaskScope, Arc<Server>, Arc<TestHandle>, Arc<Bridged<Live>>) {
    let (scope, server, handle, live, _reader) = open_reading(children).await;
    (scope, server, handle, live)
}

/// [`open_with_children`] that also returns the peer's output.
async fn open_reading(
    children: &[&str],
) -> (
    TaskScope,
    Arc<Server>,
    Arc<TestHandle>,
    Arc<Bridged<Live>>,
    tokio::io::DuplexStream,
) {
    let scope = TaskScope::root("test", |_| {});
    let (out, reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let log = Log::default();
    let handle = Arc::new(TestHandle {
        id: SessionId::new("s1"),
        view: SessionView::new(meta(), Vec::new(), selection(), PermissionMode::Default),
        closes: StdMutex::new(Vec::new()),
        log: log.clone(),
        accepts: std::sync::atomic::AtomicBool::new(false),
        table: StdMutex::new(Some(Vec::new())),
        background: StdMutex::default(),
    });
    let rows = json!({
        "parent": {"timeUpdated": 1},
        "parts": children.iter().map(|child| agent_part(child)).collect::<Vec<_>>(),
    });
    let child_rows = json!({
        "children": children
            .iter()
            .map(|child| json!({"id": child, "taskType": "subagent_child", "timeUpdated": 2}))
            .collect::<Vec<_>>(),
    });
    let queries = Arc::new(DraftQueries {
        log,
        subagent_docs: StdMutex::new(Some((rows, child_rows))),
        ..DraftQueries::default()
    });
    let kernel = Arc::new(CloseKernel {
        handle: handle.clone(),
        queries,
    });
    let server = Arc::new(Server::new(
        context,
        kernel,
        scope.spawner(),
        Defaults {
            selection: selection().into(),
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("local"),
        },
    ));
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    settled(&live).await;
    (scope, server, handle, live, reader)
}

fn count(live: &Arc<Bridged<Live>>) -> Value {
    live.sink.snapshot()["completedActivityCount"].clone()
}

fn run_delta(run_id: &str, status: &str, sequence: i64, revision: u64) -> Value {
    json!({
        "op": "workflowRun.updated",
        "revision": revision,
        "runId": run_id,
        "run": {"runId": run_id, "toolCallId": "call-1", "status": status, "usage": {}, "lastEventSequence": sequence},
        "actors": [],
        "nodes": []
    })
}

#[tokio::test]
async fn an_unreadable_history_is_null_not_a_partial_count() {
    // The default fixture's store cannot read subagent rows.
    let (_scope, server, _handle, _queries) = open(false).await;
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    settled(&live).await;
    assert_eq!(count(&live), Value::Null);
}

#[tokio::test]
async fn the_open_seeds_the_stored_successes() {
    let (_scope, _server, _handle, live) = open_with_children(&["c1", "c2"]).await;
    assert_eq!(count(&live), json!(2));
}

#[tokio::test]
async fn the_subagent_table_moves_a_resumed_child_out_and_back_in() {
    let (_scope, _server, handle, live) = open_with_children(&["c1", "c2"]).await;
    *handle.table.lock_unpoisoned() = Some(vec![entry("c1", SubagentStatus::Running)]);
    live.sink.subagents_changed().await;
    assert_eq!(count(&live), json!(1));
    *handle.table.lock_unpoisoned() = Some(vec![entry("c1", SubagentStatus::Completed)]);
    live.sink.subagents_changed().await;
    live.sink.subagents_changed().await;
    assert_eq!(
        count(&live),
        json!(2),
        "a repeated table read does not add up"
    );
    *handle.table.lock_unpoisoned() = Some(vec![entry("c3", SubagentStatus::Failed)]);
    live.sink.subagents_changed().await;
    assert_eq!(count(&live), json!(2), "a failed child is not a success");
}

#[tokio::test]
async fn run_deltas_count_a_completed_run_once_and_a_resume_takes_it_out() {
    let (_scope, _server, _handle, live) = open_with_children(&[]).await;
    assert_eq!(count(&live), json!(0));
    live.sink
        .workflow_runs_changed(vec![run_delta("run-1", "completed", 4, 1)])
        .await;
    live.sink
        .workflow_runs_changed(vec![run_delta("run-1", "completed", 4, 2)])
        .await;
    assert_eq!(count(&live), json!(1));
    live.sink
        .workflow_runs_changed(vec![run_delta("run-1", "running", 5, 3)])
        .await;
    assert_eq!(count(&live), json!(0));
}

#[tokio::test]
async fn a_change_goes_out_as_a_state_update_frame() {
    use tokio::io::AsyncBufReadExt;

    let (_scope, _server, _handle, live, reader) = open_reading(&["c1"]).await;
    let mut lines = tokio::io::BufReader::new(reader).lines();
    live.sink.subscribe("sub-1", "conn-1");
    live.sink.start("sub-1", crate::wire::Purpose::Online).await;
    live.sink
        .workflow_runs_changed(vec![run_delta("run-1", "completed", 1, 1)])
        .await;
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let line = lines.next_line().await.unwrap().expect("a line");
            if line.contains("\"completedActivityCount\":2") {
                return line;
            }
        }
    })
    .await
    .expect("the update frame");
    assert!(frame.contains("state.updated"), "{frame}");
}
