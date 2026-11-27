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

/// A backgrounded Bash call is a running `bash` work titled by its description until it ends.
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
    // Fork: an ended command stays (Node's tracker entry), killed reads as `cancelled`.
    assert_eq!(
        ended[0]["patch"]["backgroundWorks"][0]["status"],
        "cancelled"
    );
    assert_eq!(ended[0]["patch"]["backgroundWorks"][0]["endedAt"], 7000);
}

/// Fork (9.52, divergence 609): a live dynamic workflow run is a running `workflow` work, listed after the shell commands
/// (Node's tracker entry for a run: `kind` `workflow`, the subject as its title, cancellable). It leaves the list when it
/// is no longer live, and an unchanged list is no patch.
#[test]
fn a_live_workflow_run_is_a_running_work_until_it_settles() {
    use rust_cli_kernel_api::ids::WorkflowRunId;
    use rust_cli_kernel_api::workflow_run::BackgroundRunWork;

    let mut feed = Feed::new();
    let run = BackgroundRunWork {
        run_id: WorkflowRunId::new("wf_1"),
        title: "Audit the tests".into(),
        started_at_ms: 4000,
        status: rust_cli_kernel_api::workflow_run::BackgroundRunStatus::Running,
        ended_at_ms: None,
    };
    let started = feed.projection.background_table(
        &[shell("b1", BackgroundStatus::Running)],
        std::slice::from_ref(&run),
        &Default::default(),
        5000,
    );
    let expected = json!([
        {
            "workId": "b1",
            "kind": "bash",
            "title": "sleep 120",
            "status": "running",
            "startedAt": 5000,
            "cancellable": true,
            "anchorRowId": null,
        },
        {
            "workId": "wf_1",
            "kind": "workflow",
            "title": "Audit the tests",
            "status": "running",
            "startedAt": 4000,
            "cancellable": true,
            "anchorRowId": null,
        },
    ]);
    assert_eq!(started[0]["patch"]["backgroundWorks"], expected);
    assert_eq!(
        feed.projection.snapshot(feed.seq, "e")["backgroundWorks"],
        expected
    );
    assert!(
        feed.projection
            .background_table(
                &[shell("b1", BackgroundStatus::Running)],
                std::slice::from_ref(&run),
                &Default::default(),
                6000,
            )
            .is_empty(),
        "an unchanged list is no patch, and the start times are kept"
    );
    let settled = feed.projection.background_table(
        &[shell("b1", BackgroundStatus::Running)],
        &[],
        &Default::default(),
        7000,
    );
    assert_eq!(
        settled[0]["patch"]["backgroundWorks"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(settled[0]["patch"]["backgroundWorks"][0]["workId"], "b1");
}

/// 9.65 (closes 911): an ended run is Node's ended tracker entry: its summary status, `endedAt`, not cancellable, and the
/// start time it was first listed with.
#[test]
fn an_ended_run_is_an_ended_work_with_its_end_and_no_cancel() {
    use rust_cli_kernel_api::ids::WorkflowRunId;
    use rust_cli_kernel_api::workflow_run::{BackgroundRunStatus, BackgroundRunWork};

    let mut feed = Feed::new();
    let live = BackgroundRunWork {
        run_id: WorkflowRunId::new("wf_1"),
        title: "Audit the tests".into(),
        started_at_ms: 4000,
        status: BackgroundRunStatus::Running,
        ended_at_ms: None,
    };
    feed.projection
        .background_table(&[], std::slice::from_ref(&live), &Default::default(), 5000);
    let ended = BackgroundRunWork {
        started_at_ms: 4500,
        status: BackgroundRunStatus::ResultPending,
        ended_at_ms: Some(9000),
        ..live
    };
    let patch = feed
        .projection
        .background_table(&[], &[ended], &Default::default(), 9000);
    assert_eq!(
        patch[0]["patch"]["backgroundWorks"],
        json!([{
            "workId": "wf_1",
            "kind": "workflow",
            "title": "Audit the tests",
            "status": "resultPending",
            "startedAt": 4000,
            "endedAt": 9000,
            "cancellable": false,
            "anchorRowId": null,
        }])
    );
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

/// Fork: the kernel's `BackgroundWork` event (the notice reached the session, before its message is committed and
/// the ledger acks it) records the terminal status for the detail pane; a running status records nothing.
#[test]
fn a_background_work_event_records_its_terminal_status() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::BackgroundWork {
        work: "b1".into(),
        status: BackgroundStatus::Running,
    });
    assert_eq!(feed.projection.notified_status("b1"), None);
    feed.apply(KernelEvent::BackgroundWork {
        work: "b1".into(),
        status: BackgroundStatus::Killed,
    });
    assert_eq!(feed.projection.notified_status("b1"), Some("killed"));
}

/// Fork: a notification absorbed at a tool boundary records its status and output file, live and cold, and leaves
/// the Bash row as the launch acknowledgement settled it (Node settles rows only for a turn a notification opens).
#[test]
fn an_absorbed_notification_records_status_and_output_without_settling_rows() {
    use rust_cli_kernel_api::hooks::queued_command;
    use rust_cli_kernel_api::ids::MessageId;
    use rust_cli_kernel_api::message::{
        AttachmentMessage, ContentBlock, Message, ToolResultContent, UserMessage, UserOrigin,
    };

    let ack =
        "Command running in background with ID: b1. Output is being written to: /t/b1.output.";
    let text = "<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_bash</tool-use-id>\n<output-file>/logs/s1/toolu_bash-stdout.log</output-file>\n<status>completed</status>\n<summary>Background command \"Sleep a while\" completed (exit code 0)</summary>\n</task-notification>";
    let absorbed = Message::Attachment(AttachmentMessage {
        id: MessageId::new("msg_n1"),
        source: queued_command::SOURCE.to_owned(),
        text: text.to_owned(),
        data: json!({
            queued_command::PROMPT_KEY: text,
            queued_command::MODE_KEY: queued_command::TASK_NOTIFICATION,
        }),
    });
    let messages = vec![
        super::user("msg_u1", "run it"),
        super::assistant(
            "msg_a1",
            vec![ContentBlock::ToolUse {
                id: ToolUseId::new("toolu_bash"),
                name: "Bash".into(),
                input: json!({"command": "sleep 1", "description": "Sleep a while", "run_in_background": true}),
            }],
        ),
        Message::User(UserMessage {
            stall_execution: None,
            workflow_meta: None,
            epilogue_start: None,
            intent: None,
            id: MessageId::new("msg_r1"),
            content: vec![ContentBlock::ToolResult {
                tool_use_id: ToolUseId::new("toolu_bash"),
                content: vec![ToolResultContent::Text { text: ack.into() }],
                is_error: false,
            }],
            origin: UserOrigin::ToolResult {
                assistant: MessageId::new("msg_a1"),
            },
        }),
        absorbed.clone(),
    ];

    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let tool = ToolUseId::new("toolu_bash");
    feed.apply(KernelEvent::ToolStarted {
        tool_use: tool.clone(),
        name: "Bash".into(),
        input: json!({"command": "sleep 1", "description": "Sleep a while", "run_in_background": true}),
    });
    feed.apply(KernelEvent::ToolDone {
        tool_use: tool,
        output: ToolOutput {
            content: vec![ToolResultContent::Text { text: ack.into() }],
            is_error: false,
            display: serde_json::Value::Null,
        },
    });
    let bash_row = |projection: &super::Projection| {
        projection
            .rows
            .iter()
            .find(|row| row.get("toolCallId").is_some_and(|id| id == "toolu_bash"))
            .cloned()
            .expect("the Bash row")
    };
    let before = bash_row(&feed.projection);
    let deltas = feed.apply(KernelEvent::MessageDone { message: absorbed });
    assert!(
        deltas.iter().all(|delta| delta["op"] == "state.updated"),
        "{deltas:?}"
    );
    assert_eq!(bash_row(&feed.projection), before);
    assert_eq!(feed.projection.notified_status("b1"), Some("completed"));
    assert_eq!(
        feed.projection.notified_output("b1"),
        Some("/logs/s1/toolu_bash-stdout.log")
    );

    let cold =
        super::Projection::from_view(&super::view(messages), super::Followup::Queue, Vec::new());
    assert_eq!(cold.notified_status("b1"), Some("completed"));
    assert_eq!(
        cold.notified_output("b1"),
        Some("/logs/s1/toolu_bash-stdout.log")
    );
    assert_eq!(bash_row(&cold)["status"], before["status"]);
}

fn started(feed: &mut Feed, id: &str) {
    feed.projection
        .shell_table(&[shell(id, BackgroundStatus::Running)], 5000);
}

fn ends(
    id: &str,
    status: Option<BackgroundStatus>,
    tail: &str,
) -> std::collections::HashMap<String, super::ShellEnd> {
    std::collections::HashMap::from([(
        id.to_owned(),
        super::ShellEnd {
            status,
            tail: Some(tail.to_owned()),
        },
    )])
}

/// Specs/fork-rust-background-and-context-usage.md rules 2 and 3: a command the ledger stops listing stays, in its
/// slot, with Node's status (`completed` is `resultPending`, `failed`, killed is `cancelled`), `endedAt`, not
/// cancellable and the output tail as `resultSummary`. The status comes from the notice.
#[test]
fn an_ended_command_stays_with_its_end_state_and_output_tail() {
    for (notice, expected) in [
        (BackgroundStatus::Completed, "resultPending"),
        (BackgroundStatus::Failed, "failed"),
        (BackgroundStatus::Killed, "cancelled"),
    ] {
        let mut feed = Feed::new();
        started(&mut feed, "b1");
        feed.apply(KernelEvent::BackgroundWork {
            work: "b1".into(),
            status: notice,
        });
        assert_eq!(feed.projection.vanished_shells(&[]), ["b1"]);
        let patch = feed.projection.background_table(
            &[],
            &[],
            &ends("b1", None, "line 1\nbuild done\n"),
            9000,
        );
        let expected_work = json!([{
            "workId": "b1",
            "kind": "bash",
            "title": "sleep 120",
            "status": expected,
            "startedAt": 5000,
            "endedAt": 9000,
            "cancellable": false,
            "anchorRowId": null,
            "resultSummary": "line 1\nbuild done\n",
        }]);
        assert_eq!(patch[0]["patch"]["backgroundWorks"], expected_work);
        assert_eq!(
            feed.projection.snapshot(feed.seq, "e")["backgroundWorks"],
            expected_work
        );
        // Written once: later reads change nothing, and the end is not listed as vanished again.
        assert!(feed.projection.vanished_shells(&[]).is_empty());
        assert!(
            feed.projection
                .background_table(&[], &[], &Default::default(), 12_000)
                .is_empty()
        );
    }
}

/// Rule 2: the ended command keeps its slot among the others, and an empty tail leaves `resultSummary` out.
#[test]
fn an_ended_command_keeps_its_slot_and_an_empty_tail_has_no_summary() {
    let mut feed = Feed::new();
    feed.projection.background_table(
        &[
            shell("b1", BackgroundStatus::Running),
            shell("b2", BackgroundStatus::Running),
        ],
        &[],
        &Default::default(),
        5000,
    );
    feed.apply(KernelEvent::BackgroundWork {
        work: "b1".into(),
        status: BackgroundStatus::Completed,
    });
    let patch = feed.projection.background_table(
        &[shell("b2", BackgroundStatus::Running)],
        &[],
        &ends("b1", None, ""),
        6000,
    );
    let works = &patch[0]["patch"]["backgroundWorks"];
    assert_eq!(works[0]["workId"], "b1");
    assert_eq!(works[0]["status"], "resultPending");
    assert!(works[0].get("resultSummary").is_none());
    assert_eq!(works[1]["workId"], "b2");
    assert_eq!(works[1]["status"], "running");
    // A third command starts after the ended one.
    let patch = feed.projection.background_table(
        &[
            shell("b2", BackgroundStatus::Running),
            shell("b3", BackgroundStatus::Running),
        ],
        &[],
        &Default::default(),
        7000,
    );
    let ids: Vec<&str> = patch[0]["patch"]["backgroundWorks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|work| work["workId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["b1", "b2", "b3"]);
}

/// Rule 2: the status order is the notice, then the output read, then the ledger entry, then `failed`; a notice that
/// arrives after the ledger forgot the command corrects the status and nothing else.
#[test]
fn the_end_status_has_an_order_and_a_late_notice_corrects_it() {
    let mut feed = Feed::new();
    started(&mut feed, "b1");
    let patch = feed
        .projection
        .background_table(&[], &[], &ends("b1", None, "x"), 8000);
    assert_eq!(patch[0]["patch"]["backgroundWorks"][0]["status"], "failed");
    feed.apply(KernelEvent::BackgroundWork {
        work: "b1".into(),
        status: BackgroundStatus::Completed,
    });
    let patch = feed
        .projection
        .background_table(&[], &[], &Default::default(), 9000);
    let work = &patch[0]["patch"]["backgroundWorks"][0];
    assert_eq!(work["status"], "resultPending");
    assert_eq!(work["endedAt"], 8000);
    assert_eq!(work["resultSummary"], "x");

    // The output read's status is used when no notice came; a ledger entry's terminal status after it.
    let mut feed = Feed::new();
    started(&mut feed, "b1");
    let patch = feed.projection.background_table(
        &[],
        &[],
        &ends("b1", Some(BackgroundStatus::Killed), "x"),
        8000,
    );
    assert_eq!(
        patch[0]["patch"]["backgroundWorks"][0]["status"],
        "cancelled"
    );
    let mut feed = Feed::new();
    started(&mut feed, "b1");
    let patch = feed
        .projection
        .shell_table(&[shell("b1", BackgroundStatus::Completed)], 8000);
    assert_eq!(
        patch[0]["patch"]["backgroundWorks"][0]["status"],
        "resultPending"
    );
}

/// Rule 4: the summary is the last 4096 UTF-16 units (zod counts JS `.length`), cut on a character boundary, so a
/// tail of non-BMP characters (two units each) stays within the schema cap.
#[test]
fn the_result_summary_is_capped_in_utf16_units_like_node() {
    let mut feed = Feed::new();
    started(&mut feed, "b1");
    let tail = format!("head{}", "\u{1F600}".repeat(3000));
    let patch = feed
        .projection
        .background_table(&[], &[], &ends("b1", None, &tail), 8000);
    let summary = patch[0]["patch"]["backgroundWorks"][0]["resultSummary"]
        .as_str()
        .unwrap();
    assert_eq!(summary.encode_utf16().count(), 4096);
    assert_eq!(summary.chars().count(), 2048);
    assert!(summary.chars().all(|ch| ch == '\u{1F600}'));

    let mut feed = Feed::new();
    started(&mut feed, "b1");
    let ascii = "ab".repeat(4000);
    let patch = feed
        .projection
        .background_table(&[], &[], &ends("b1", None, &ascii), 8000);
    assert_eq!(
        patch[0]["patch"]["backgroundWorks"][0]["resultSummary"],
        ascii[ascii.len() - 4096..]
    );
}

/// Rule 5: a command that runs again replaces its ended item and keeps its start time.
#[test]
fn a_command_that_runs_again_replaces_its_ended_item() {
    let mut feed = Feed::new();
    started(&mut feed, "b1");
    feed.projection
        .background_table(&[], &[], &ends("b1", None, "x"), 8000);
    let patch = feed
        .projection
        .shell_table(&[shell("b1", BackgroundStatus::Running)], 9000);
    let work = &patch[0]["patch"]["backgroundWorks"][0];
    assert_eq!(work["status"], "running");
    assert_eq!(work["startedAt"], 5000);
    assert!(work.get("endedAt").is_none());
    assert!(work.get("resultSummary").is_none());
}

/// Rule 7: an end event that came before the deferred ledger refresh already counts for the activity boundary, so a real
/// user input in the same batch folds the command.
#[test]
fn the_boundary_counts_an_end_the_table_has_not_caught_up_with() {
    let mut feed = Feed::new();
    started(&mut feed, "b1");
    feed.apply(KernelEvent::BackgroundWork {
        work: "b1".into(),
        status: BackgroundStatus::Completed,
    });
    assert_eq!(
        feed.projection.background_works_value()[0]["status"],
        "running"
    );
    assert_eq!(
        feed.projection.boundary_works_value()[0]["status"],
        "resultPending"
    );
}
