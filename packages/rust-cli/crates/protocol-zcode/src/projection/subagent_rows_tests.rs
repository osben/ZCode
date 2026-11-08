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
