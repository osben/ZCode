//! Fork: background shell commands in `backgroundWorks` (projection/background_shells.rs).

use rust_cli_kernel_api::env_shell::BackgroundStatus;
use rust_cli_kernel_api::ids::{ToolUseId, TurnId};
use rust_cli_kernel_api::manage::{BackgroundEntry, BackgroundKind};
use rust_cli_kernel_api::session_api::KernelEvent;
use rust_cli_kernel_api::tool::ToolOutput;
use serde_json::json;

use super::Feed;

fn shell(id: &str, status: BackgroundStatus) -> BackgroundEntry {
    BackgroundEntry::new(id, BackgroundKind::Shell, "sleep 120", status)
}

/// A backgrounded Bash call is a running `bash` work titled by its description until the ledger drops it.
#[test]
fn a_background_command_is_a_running_work_until_it_ends() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let tool = ToolUseId::new("toolu_bash");
    feed.apply(KernelEvent::ToolStarted {
        tool_use: tool.clone(),
        name: "Bash".into(),
        input: json!({"command": "sleep 120", "description": "Sleep a while", "run_in_background": true}),
    });
    feed.apply(KernelEvent::ToolDone {
        tool_use: tool,
        output: ToolOutput {
            content: vec![rust_cli_kernel_api::message::ToolResultContent::Text {
                text: "Command running in background with ID: b1. Output is being written to: /t/b1.output. You will be notified when it completes. To check interim output, use Read on that file path.".into(),
            }],
            is_error: false,
            display: serde_json::Value::Null,
        },
    });
    let started = feed
        .projection
        .shell_table(&[shell("b1", BackgroundStatus::Running)], 5000);
    let expected = json!([{
        "workId": "b1",
        "kind": "bash",
        "title": "Sleep a while",
        "status": "running",
        "startedAt": 5000,
        "cancellable": true,
        "anchorRowId": null,
    }]);
    assert_eq!(started[0]["patch"]["backgroundWorks"], expected);
    assert_eq!(
        feed.projection.snapshot(feed.seq, "e")["backgroundWorks"],
        expected
    );
    // Unchanged: no patch, and the start time is kept.
    assert!(
        feed.projection
            .shell_table(&[shell("b1", BackgroundStatus::Running)], 6000)
            .is_empty()
    );
    let ended = feed
        .projection
        .shell_table(&[shell("b1", BackgroundStatus::Killed)], 7000);
    assert_eq!(ended[0]["patch"]["backgroundWorks"], json!([]));
}

/// A command without a known Bash description is titled by its command line; subagents are not shells.
#[test]
fn an_unknown_command_is_titled_by_its_command_line() {
    let mut feed = Feed::new();
    let agent = BackgroundEntry::new(
        "agent_1",
        BackgroundKind::Agent,
        "child",
        BackgroundStatus::Running,
    );
    let deltas = feed
        .projection
        .shell_table(&[shell("b2", BackgroundStatus::Running), agent], 10);
    let works = &deltas[0]["patch"]["backgroundWorks"];
    assert_eq!(works.as_array().unwrap().len(), 1);
    assert_eq!(works[0]["title"], "sleep 120");
}

/// A foreground command moved to the background on its timeout keeps its Bash description as title.
#[test]
fn a_command_moved_to_the_background_is_titled_by_its_description() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let tool = ToolUseId::new("toolu_auto");
    feed.apply(KernelEvent::ToolStarted {
        tool_use: tool.clone(),
        name: "Bash".into(),
        input: json!({"command": "sleep 120", "description": "auto timeout bash sleep"}),
    });
    feed.apply(KernelEvent::ToolDone {
        tool_use: tool,
        output: ToolOutput {
            content: vec![rust_cli_kernel_api::message::ToolResultContent::Text {
                text: "Command did not complete within its 2s timeout and was moved to the background (ID: b7). Output is being written to: /t/b7.output. You will be notified when it completes.".into(),
            }],
            is_error: false,
            display: serde_json::Value::Null,
        },
    });
    let started = feed
        .projection
        .shell_table(&[shell("b7", BackgroundStatus::Running)], 5000);
    assert_eq!(
        started[0]["patch"]["backgroundWorks"][0]["title"],
        "auto timeout bash sleep"
    );
}
