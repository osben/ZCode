//! Fork: the cold open's Activity boundary (specs/fork-rust-activity-summary.md, rule 5) and the success total after a
//! rewind (specs/fork-rust-completed-activity-count.md, rule 4), through the `Live` wiring of a session opened from
//! storage.

use rust_cli_kernel_api::ids::{AgentId, MachineName, MessageId};
use rust_cli_kernel_api::input_intent::InputIntent;
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::panels::{SubagentEntry, SubagentStatus};
use rust_cli_kernel_api::session_api::KernelEvent;
use rust_cli_protocol_core::sessions::SessionSink;

use super::*;
use crate::fork::workspace_trust::tests::settled;

fn agent_part(child: &str, ended_at: u64) -> Value {
    json!({
        "callId": format!("toolu_{child}"),
        "tool": "Agent",
        "status": "completed",
        "input": {},
        "metadata": {"childSessionId": child, "agentId": format!("agent_{child}")},
        "endedAt": ended_at,
    })
}

fn docs(children: &[(&str, u64)]) -> (Value, Value) {
    let rows = json!({
        "parent": {"timeUpdated": 1},
        "parts": children.iter().map(|(child, at)| agent_part(child, *at)).collect::<Vec<_>>(),
    });
    let child_rows = json!({
        "children": children
            .iter()
            .map(|(child, _)| json!({"id": child, "taskType": "subagent_child", "timeUpdated": 2}))
            .collect::<Vec<_>>(),
    });
    (rows, child_rows)
}

fn human(id: &str, admitted_at: Option<u64>) -> Message {
    let intent = admitted_at.map(|at| {
        let mut fields = serde_json::Map::new();
        fields.insert("admittedAt".into(), json!(at));
        Box::new(InputIntent::from_fields(fields))
    });
    Message::User(UserMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: "go on".into(),
        }],
        origin: UserOrigin::Human,
        intent,
        stall_execution: None,
        workflow_meta: None,
        epilogue_start: None,
    })
}

/// An open `s1` over a stored history: its messages and the store's Agent parts.
async fn open_cold(
    messages: Vec<Message>,
    children: &[(&str, u64)],
) -> (
    TaskScope,
    Arc<Server>,
    Arc<TestHandle>,
    Arc<DraftQueries>,
    Arc<Bridged<Live>>,
) {
    let view = SessionView::new(meta(), messages, selection(), PermissionMode::Default);
    let (scope, server, handle, queries) = open_view(false, view).await;
    *queries.subagent_docs.lock_unpoisoned() = Some(docs(children));
    *handle.table.lock_unpoisoned() = Some(Vec::new());
    let live = server.live(&SessionId::new("s1")).await.unwrap();
    settled(&live).await;
    (scope, server, handle, queries, live)
}

fn boundary(live: &Arc<Bridged<Live>>) -> Value {
    live.sink.snapshot()["activitySummaryDismissed"].clone()
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

/// Rule 5: a reopened session folds the children that ended by its last input, as the live boundary did.
#[tokio::test]
async fn a_cold_open_restores_the_boundary_of_the_last_input() {
    let (_scope, _server, _handle, _queries, live) = open_cold(
        vec![human("u1", Some(500)), human("u2", Some(2000))],
        &[("c_before", 1500), ("c_after", 2500)],
    )
    .await;
    let value = boundary(&live);
    assert_eq!(value["at"], json!(2000), "{value}");
    assert_eq!(value["subagentIds"], json!(["c_before"]), "{value}");
    assert_eq!(value["workIds"], json!([]));
    assert_eq!(value["workflowRunIds"], json!([]));
}

/// Rule 5: an input without an intent (typed in the TUI) has no time; the session's creation time stands in.
#[tokio::test]
async fn a_cold_input_without_an_intent_uses_the_creation_time() {
    let (_scope, _server, _handle, _queries, live) =
        open_cold(vec![human("u1", None)], &[("c_late", 5000)]).await;
    let value = boundary(&live);
    assert_eq!(value["at"], json!(1000), "{value}");
    assert_eq!(value["subagentIds"], json!([]), "{value}");
}

/// Rule 5: a history with no real input has no boundary.
#[tokio::test]
async fn a_cold_open_without_a_real_input_has_no_boundary() {
    let (_scope, _server, _handle, _queries, live) = open_cold(Vec::new(), &[("c1", 100)]).await;
    assert!(
        live.sink
            .snapshot()
            .get("activitySummaryDismissed")
            .is_none()
    );
}

/// Rule 5: a seed never replaces a boundary a live real input set after the open.
#[tokio::test]
async fn a_later_seed_keeps_the_live_boundary() {
    let (_scope, _server, _handle, _queries, live) =
        open_cold(vec![human("u1", Some(2000))], &[("c1", 1000)]).await;
    assert_eq!(boundary(&live)["subagentIds"], json!(["c1"]));
    user_turn(&live.sink, 1, UserOrigin::Human).await;
    let live_value = boundary(&live);
    assert_eq!(live_value["at"], json!(5), "{live_value}");
    live.sink.seed_completed_activity(true).await;
    assert_eq!(boundary(&live), live_value);
}

/// Rule 4 of the count spec: a child that succeeded in this process and whose launch a rewind cut is not counted, and
/// the kernel table does not bring it back.
#[tokio::test]
async fn a_rewound_child_that_ended_in_this_process_leaves_the_count() {
    let (_scope, _server, handle, queries, live) =
        open_cold(vec![human("u1", Some(10))], &[("c1", 1), ("c2", 2)]).await;
    assert_eq!(live.sink.snapshot()["completedActivityCount"], json!(2));
    *handle.table.lock_unpoisoned() = Some(vec![
        entry("c1", SubagentStatus::Completed),
        entry("c2", SubagentStatus::Completed),
    ]);
    live.sink.subagents_changed().await;
    assert_eq!(live.sink.snapshot()["completedActivityCount"], json!(2));

    // The rewind removed the launch of c2: the active branch links c1 only, the table still holds both.
    *queries.subagent_docs.lock_unpoisoned() = Some(docs(&[("c1", 1)]));
    live.sink
        .event(SequencedEvent {
            seq: 20,
            revision: 20,
            event: KernelEvent::HistoryRewritten { generation: 1 },
        })
        .await;
    assert_eq!(live.sink.snapshot()["completedActivityCount"], json!(1));
    live.sink.subagents_changed().await;
    assert_eq!(
        live.sink.snapshot()["completedActivityCount"],
        json!(1),
        "a repeated table read keeps the cut child out"
    );
}
