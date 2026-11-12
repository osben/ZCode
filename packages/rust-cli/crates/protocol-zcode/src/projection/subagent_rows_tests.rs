//! Fork: subagent rows and the snapshot `subagents` manifest (projection/subagent_rows.rs).

use rust_cli_kernel_api::ids::{AgentId, SessionId, ToolUseId, TurnId};
use rust_cli_kernel_api::panels::{SubagentEntry, SubagentStatus};
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};
use rust_cli_kernel_api::tool::{ToolOutput, ToolProgress};
use serde_json::{Value, json};

use super::Feed;

fn agent_call(feed: &mut Feed, n: u32) -> ToolUseId {
    let tool = ToolUseId::new(format!("toolu_{n}"));
    feed.apply(KernelEvent::ToolStarted {
        tool_use: tool.clone(),
        name: "Agent".into(),
        input: json!({"description": format!("child {n}"), "prompt": "do it"}),
    });
    tool
}

fn progress(feed: &mut Feed, tool: &ToolUseId, n: u32) -> Vec<Value> {
    feed.apply(KernelEvent::ToolProgress {
        tool_use: tool.clone(),
        progress: ToolProgress {
            data: json!({"agentId": format!("agent_{n}"), "event": {}}),
        },
    })
}

fn done(feed: &mut Feed, tool: &ToolUseId, n: u32, status: &str) -> Vec<Value> {
    feed.apply(KernelEvent::ToolDone {
        tool_use: tool.clone(),
        output: ToolOutput {
            content: Vec::new(),
            is_error: false,
            display: json!({"agent": {
                "agentId": format!("agent_{n}"),
                "childSessionId": format!("sess_subagent_agent_{n}"),
                "agentType": "general-purpose",
                "status": status,
            }}),
        },
    })
}

fn manifest(deltas: &[Value]) -> Option<&Value> {
    deltas
        .iter()
        .rev()
        .find_map(|delta| delta["patch"].get("subagents"))
}

fn entry(n: u32, status: SubagentStatus, waiting: bool) -> SubagentEntry {
    SubagentEntry {
        execution: 0,
        agent: AgentId::new(format!("agent_{n}")),
        child: SessionId::new(format!("sess_subagent_agent_{n}")),
        agent_type: "general-purpose".into(),
        description: format!("child {n}"),
        status,
        background: true,
        waiting,
        elapsed_ms: 0,
        ended_ago_ms: None,
        version: 0,
        owner: None,
        activity: None,
        parked: false,
        machine: Default::default(),
    }
}

fn start(feed: &mut Feed) {
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
}

/// SAT24: parallel foreground children are all counted while they run, and leave the running list
/// when their Agent call returns.
#[test]
fn parallel_foreground_children_are_rows_and_the_manifest() {
    let mut feed = Feed::new();
    start(&mut feed);
    let tools: Vec<ToolUseId> = (1..=7).map(|n| agent_call(&mut feed, n)).collect();
    let mut last = None;
    for (n, tool) in (1..=7).zip(&tools) {
        let deltas = progress(&mut feed, tool, n);
        let row = deltas
            .iter()
            .find(|delta| delta["op"] == "row.appended")
            .map(|delta| delta["row"].clone())
            .expect("the first progress spawns the row");
        assert_eq!(row["kind"], "subagent");
        assert_eq!(row["parentToolCallId"], tool.as_str());
        assert_eq!(row["subagentType"], "general-purpose");
        assert_eq!(row["status"], "running");
        assert_eq!(row["summaryText"], format!("child {n}"));
        assert_eq!(row["childSessionId"], format!("sess_subagent_agent_{n}"));
        last = manifest(&deltas).cloned();
    }
    let running = last.expect("each spawn publishes the manifest");
    assert_eq!(running["revision"], 7);
    assert_eq!(running["running"].as_array().unwrap().len(), 7);
    assert_eq!(running["running"][0]["title"], "child 7");
    assert_eq!(running["running"][0]["toolCallId"], "toolu_7");
    // A repeated progress changes nothing.
    assert!(manifest(&progress(&mut feed, &tools[0], 1)).is_none());
    let snapshot = feed.projection.snapshot(feed.seq, "epoch");
    assert_eq!(snapshot["subagents"], running);
    let mut settled = None;
    for (n, tool) in (1..=7).zip(&tools) {
        let deltas = done(&mut feed, tool, n, "completed");
        settled = manifest(&deltas).cloned();
    }
    let settled = settled.unwrap();
    assert_eq!(settled["running"], json!([]));
    assert_eq!(settled["endedTotal"], 7);
    assert_eq!(settled["childSessionIds"].as_array().unwrap().len(), 7);
}

/// A background launch keeps running past its turn; the live table settles it and reports waiting.
#[test]
fn a_background_child_is_settled_by_the_live_table() {
    let mut feed = Feed::new();
    start(&mut feed);
    let tool = agent_call(&mut feed, 1);
    let launched = done(&mut feed, &tool, 1, "async_launched");
    let row = &launched
        .iter()
        .rev()
        .find(|delta| delta["row"]["kind"] == "subagent")
        .unwrap()["row"];
    assert_eq!(row["status"], "running");
    assert_eq!(row["backgrounded"], true);
    assert_eq!(row["workId"], "agent_1");
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    assert_eq!(
        feed.projection.snapshot(feed.seq, "e")["subagents"]["running"][0]["status"],
        "running"
    );
    let waiting = feed
        .projection
        .subagent_table(&[entry(1, SubagentStatus::Running, true)], 9000);
    assert_eq!(
        manifest(&waiting).unwrap()["running"][0]["status"],
        "blocked"
    );
    let ended = feed
        .projection
        .subagent_table(&[entry(1, SubagentStatus::Completed, false)], 9100);
    assert_eq!(ended[0]["row"]["status"], "success");
    assert_eq!(ended[0]["row"]["endedAt"], 9100);
    assert_eq!(manifest(&ended).unwrap()["endedTotal"], 1);
    // An unchanged table publishes nothing.
    assert!(
        feed.projection
            .subagent_table(&[entry(1, SubagentStatus::Completed, false)], 9200)
            .is_empty()
    );
}

/// A background child that ended before its launch result arrived is settled by that result.
#[test]
fn a_launch_result_after_the_child_ended_settles_it() {
    let mut feed = Feed::new();
    start(&mut feed);
    let tool = agent_call(&mut feed, 1);
    feed.projection
        .subagent_table(&[entry(1, SubagentStatus::Failed, false)], 2500);
    let launched = done(&mut feed, &tool, 1, "async_launched");
    let row = &launched
        .iter()
        .rev()
        .find(|delta| delta["row"]["kind"] == "subagent")
        .unwrap()["row"];
    assert_eq!(row["status"], "failed");
}

/// An interrupted turn stops its foreground children with it (Node cancels the open rows).
#[test]
fn an_interrupted_turn_cancels_running_foreground_children() {
    let mut feed = Feed::new();
    start(&mut feed);
    let tool = agent_call(&mut feed, 1);
    progress(&mut feed, &tool, 1);
    let finished = feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Interrupted,
        usage: None,
    });
    let row = &finished
        .iter()
        .rev()
        .find(|delta| delta["row"]["kind"] == "subagent")
        .unwrap()["row"];
    assert_eq!(row["status"], "cancelled");
    assert_eq!(manifest(&finished).unwrap()["running"], json!([]));
}

/// A tool that is not an Agent call never spawns a subagent row.
#[test]
fn progress_on_other_tools_is_no_subagent() {
    let mut feed = Feed::new();
    start(&mut feed);
    let tool = ToolUseId::new("toolu_b");
    feed.apply(KernelEvent::ToolStarted {
        tool_use: tool.clone(),
        name: "Bash".into(),
        input: json!({"command": "ls"}),
    });
    let deltas = feed.apply(KernelEvent::ToolProgress {
        tool_use: tool,
        progress: ToolProgress {
            data: json!({"agentId": "agent_x"}),
        },
    });
    assert!(
        deltas
            .iter()
            .all(|delta| delta["row"]["kind"] != "subagent")
    );
    assert!(manifest(&deltas).is_none());
}

fn works(deltas: &[Value]) -> Option<&Value> {
    deltas
        .iter()
        .rev()
        .find_map(|delta| delta["patch"].get("backgroundWorks"))
}

/// SAT12: a finished foreground child resumed by SendMessage runs again in the background: its row
/// reopens and it is a cancellable running work until the table reports it stopped.
#[test]
fn a_resumed_child_reopens_its_row_and_is_a_background_work() {
    let mut feed = Feed::new();
    start(&mut feed);
    let tool = agent_call(&mut feed, 1);
    progress(&mut feed, &tool, 1);
    done(&mut feed, &tool, 1, "completed");
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    let resumed = feed
        .projection
        .subagent_table(&[entry(1, SubagentStatus::Running, false)], 9000);
    let row = &resumed
        .iter()
        .find(|delta| delta["op"] == "row.upserted")
        .unwrap()["row"];
    assert_eq!(row["status"], "running");
    assert_eq!(row["backgrounded"], true);
    assert_eq!(row["workId"], "agent_1");
    assert_eq!(row["parentToolCallId"], "toolu_1");
    assert!(row.get("endedAt").is_none());
    assert_eq!(
        manifest(&resumed).unwrap()["running"][0]["status"],
        "running"
    );
    let listed = works(&resumed).unwrap();
    assert_eq!(
        listed,
        &json!([{
            "workId": "agent_1",
            "kind": "subagent",
            "title": "child 1",
            "status": "running",
            "startedAt": 9000,
            "cancellable": true,
            "blocked": false,
            "anchorRowId": null,
            "childSessionId": "sess_subagent_agent_1",
        }])
    );
    assert_eq!(
        &feed.projection.snapshot(feed.seq, "e")["backgroundWorks"],
        listed
    );
    let stopped = feed
        .projection
        .subagent_table(&[entry(1, SubagentStatus::Killed, false)], 9500);
    assert_eq!(stopped[0]["row"]["status"], "cancelled");
    assert_eq!(works(&stopped).unwrap(), &json!([]));
    assert_eq!(manifest(&stopped).unwrap()["running"], json!([]));
}

/// A foreground child that the table lists as running is no background work.
#[test]
fn a_foreground_child_is_no_background_work() {
    let mut feed = Feed::new();
    start(&mut feed);
    let tool = agent_call(&mut feed, 1);
    progress(&mut feed, &tool, 1);
    let mut foreground = entry(1, SubagentStatus::Running, false);
    foreground.background = false;
    let deltas = feed.projection.subagent_table(&[foreground], 9000);
    assert!(works(&deltas).is_none());
    assert_eq!(
        feed.projection.snapshot(feed.seq, "e")["backgroundWorks"],
        json!([])
    );
}

fn control(feed: &Feed, child: &str) -> Option<Value> {
    feed.projection.snapshot(feed.seq, "epoch")["subagents"]["running"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["childSessionId"] == child)
        .and_then(|item| item.get("stopControl").cloned())
}

/// B2 (Node `liveSubagentStopControlByChildId`): the running summary names the live run the Stop button ends. It
/// comes from the kernel's live table only: none before the table lists the child (a cold open), none for a child a
/// subagent spawned, a new run replaces it, and an ended child has none.
#[test]
fn the_stop_control_comes_from_the_live_table() {
    let mut feed = Feed::new();
    start(&mut feed);
    let first = agent_call(&mut feed, 1);
    progress(&mut feed, &first, 1);
    let nested = agent_call(&mut feed, 2);
    progress(&mut feed, &nested, 2);
    assert_eq!(control(&feed, "sess_subagent_agent_1"), None);

    let mut own = entry(1, SubagentStatus::Running, false);
    own.background = false;
    let mut inner = entry(2, SubagentStatus::Running, false);
    inner.background = false;
    inner.owner = Some(AgentId::new("agent_1"));
    let deltas = feed
        .projection
        .subagent_table(&[own.clone(), inner.clone()], 10);
    assert_eq!(
        manifest(&deltas).unwrap()["running"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["childSessionId"] == "sess_subagent_agent_1")
            .unwrap()["stopControl"],
        json!({"taskId": "agent_1", "executionId": "0"})
    );
    assert_eq!(control(&feed, "sess_subagent_agent_2"), None);

    own.execution = 1;
    feed.projection
        .subagent_table(&[own.clone(), inner.clone()], 20);
    assert_eq!(
        control(&feed, "sess_subagent_agent_1"),
        Some(json!({"taskId": "agent_1", "executionId": "1"}))
    );

    own.status = SubagentStatus::Killed;
    feed.projection.subagent_table(&[own, inner], 30);
    assert_eq!(control(&feed, "sess_subagent_agent_1"), None);
}

/// A foreground child stopped on its own (Node `ToolCancelled`, `onToolCallError`): the Agent row and the child's row
/// are cancelled, not an error, while the parent turn goes on. The typed display marker decides it, not the result
/// text (a failure hook may rewrite that text).
#[test]
fn a_stopped_foreground_child_settles_its_rows_as_cancelled() {
    let mut feed = Feed::new();
    start(&mut feed);
    let tool = agent_call(&mut feed, 1);
    progress(&mut feed, &tool, 1);
    let deltas = feed.apply(KernelEvent::ToolDone {
        tool_use: tool.clone(),
        output: ToolOutput {
            content: vec![rust_cli_kernel_api::message::ToolResultContent::Text {
                text: "rewritten by a failure hook".to_owned(),
            }],
            is_error: true,
            display: json!({"agent": {
                "agentId": "agent_1",
                "childSessionId": "sess_subagent_agent_1",
                "agentType": "general-purpose",
                "status": "killed",
            }}),
        },
    });
    let status_of = |kind: &str| {
        deltas
            .iter()
            .rev()
            .find(|delta| delta["row"]["kind"] == kind)
            .map(|delta| delta["row"]["status"].clone())
    };
    assert_eq!(
        status_of("subagent"),
        Some(json!("cancelled")),
        "{deltas:?}"
    );
    assert_eq!(
        status_of("toolCall"),
        Some(json!("cancelled")),
        "{deltas:?}"
    );
    let call = deltas
        .iter()
        .rev()
        .find(|delta| delta["row"]["kind"] == "toolCall")
        .unwrap();
    assert!(call["row"].get("output").is_none(), "{call}");
    assert!(call["row"].get("endedAt").is_some(), "{call}");
}

/// B2 (Node `product-projection.ts` hydration: "cold recovery must not re-grant stop capability"): after a rewind
/// rebuilt the projection, a background child that was already running gets no Stop; its next run (a resume, Node's
/// `SubagentSpawned`) does.
#[test]
fn a_rebuilt_projection_grants_no_stop_to_a_run_already_going() {
    let mut feed = Feed::new();
    start(&mut feed);
    let call = agent_call(&mut feed, 1);
    progress(&mut feed, &call, 1);
    let mut running = entry(1, SubagentStatus::Running, false);
    feed.projection.subagent_table(&[running.clone()], 10);
    assert!(control(&feed, "sess_subagent_agent_1").is_some());

    feed.projection = feed.projection.rebuilt(&super::view(Vec::new()));
    let call = agent_call(&mut feed, 1);
    progress(&mut feed, &call, 1);
    feed.projection.subagent_table(&[running.clone()], 20);
    assert_eq!(control(&feed, "sess_subagent_agent_1"), None);
    feed.projection.subagent_table(&[running.clone()], 30);
    assert_eq!(control(&feed, "sess_subagent_agent_1"), None);

    running.execution = 1;
    feed.projection.subagent_table(&[running], 40);
    assert_eq!(
        control(&feed, "sess_subagent_agent_1"),
        Some(json!({"taskId": "agent_1", "executionId": "1"}))
    );
}
