//! Fork: `outputPreview` on the running Bash row (Node's `projectToolActivity` and
//! `clearSettledOutputPreviews`).

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, ToolUseId, TraceId, TurnId};
use rust_cli_kernel_api::message::ToolResultContent;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{KernelEvent, SequencedEvent, SessionView, TurnOutcome};
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use rust_cli_kernel_api::testing::selection;
use rust_cli_kernel_api::tool::{ToolOutput, ToolProgress};
use serde_json::{Value, json};

use super::super::Projection;
use super::super::state::Followup;

fn projection() -> Projection {
    let view = SessionView::new(
        SessionMeta {
            id: SessionId::new("session_1"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            title: String::new(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
            incognito: None,
        },
        Vec::new(),
        selection(),
        PermissionMode::Default,
    );
    Projection::from_view(&view, Followup::Queue, vec!["high".into()])
}

struct Feed {
    projection: Projection,
    seq: u64,
}

impl Feed {
    fn new() -> Self {
        Self {
            projection: projection(),
            seq: 0,
        }
    }

    fn apply(&mut self, event: KernelEvent) -> Vec<Value> {
        self.seq += 1;
        self.projection.apply(
            &SequencedEvent {
                seq: self.seq,
                event,
                revision: self.seq,
            },
            2000 + self.seq,
        )
    }

    fn start(&mut self, tool: &str, name: &str) {
        self.apply(KernelEvent::ToolStarted {
            tool_use: ToolUseId::new(tool),
            name: name.into(),
            input: json!({"command": "node writer.cjs"}),
        });
    }

    fn progress(&mut self, tool: &str, data: Value) -> Vec<Value> {
        self.apply(KernelEvent::ToolProgress {
            tool_use: ToolUseId::new(tool),
            progress: ToolProgress { data },
        })
    }

    fn stored(&self, tool: &str) -> Value {
        let snapshot = self.projection.snapshot(1, "epoch");
        snapshot["rows"]["window"]
            .as_array()
            .expect("rows")
            .iter()
            .find(|row| row["toolCallId"] == tool)
            .cloned()
            .expect("tool row")
    }
}

fn preview(text: &str) -> Value {
    json!({
        "text": text,
        "fullText": text,
        "totalLines": 1,
        "totalBytes": text.len(),
        "linesEstimated": false,
    })
}

fn turn(feed: &mut Feed) {
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
}

#[test]
fn a_running_bash_row_carries_the_latest_preview() {
    let mut feed = Feed::new();
    turn(&mut feed);
    feed.start("toolu_1", "Bash");
    let deltas = feed.progress(
        "toolu_1",
        json!({"type": "bash_progress", "outputPreview": preview("tick-1")}),
    );
    let row = deltas
        .iter()
        .find(|delta| delta["op"] == "row.upserted")
        .expect("upsert");
    assert_eq!(row["row"]["outputPreview"], preview("tick-1"));
    feed.progress(
        "toolu_1",
        json!({"type": "bash_progress", "outputPreview": preview("tick-2")}),
    );
    assert_eq!(feed.stored("toolu_1")["outputPreview"], preview("tick-2"));
}

#[test]
fn progress_without_a_valid_preview_or_on_another_tool_changes_nothing() {
    let mut feed = Feed::new();
    turn(&mut feed);
    feed.start("toolu_1", "Bash");
    feed.start("toolu_2", "Read");
    let malformed = json!({"text": "x", "fullText": "x", "totalLines": -1});
    assert!(
        feed.progress("toolu_1", json!({"outputPreview": malformed}))
            .iter()
            .all(|delta| delta["op"] != "row.upserted")
    );
    let too_long = preview(&"x".repeat(4097));
    assert!(
        feed.progress("toolu_1", json!({"outputPreview": too_long}))
            .iter()
            .all(|delta| delta["op"] != "row.upserted")
    );
    assert!(
        feed.progress("toolu_2", json!({"outputPreview": preview("read")}))
            .iter()
            .all(|delta| delta["op"] != "row.upserted")
    );
    // No row for an unknown tool call.
    assert!(
        feed.progress("toolu_9", json!({"outputPreview": preview("ghost")}))
            .iter()
            .all(|delta| delta["op"] != "row.upserted" && delta["op"] != "row.appended")
    );
}

#[test]
fn settling_the_row_drops_the_preview_in_the_same_delta() {
    let mut feed = Feed::new();
    turn(&mut feed);
    feed.start("toolu_1", "Bash");
    feed.progress("toolu_1", json!({"outputPreview": preview("tick")}));
    let done = feed.apply(KernelEvent::ToolDone {
        tool_use: ToolUseId::new("toolu_1"),
        output: ToolOutput {
            content: vec![ToolResultContent::Text { text: "ok".into() }],
            is_error: false,
            display: Value::Null,
        },
    });
    let row = done
        .iter()
        .find(|delta| delta["op"] == "row.upserted" && delta["row"]["toolCallId"] == "toolu_1")
        .expect("settled row");
    assert_eq!(row["row"]["status"], "success");
    assert!(row["row"].get("outputPreview").is_none());
    assert!(feed.stored("toolu_1").get("outputPreview").is_none());
    // A late tick never revives a settled row.
    feed.progress("toolu_1", json!({"outputPreview": preview("late")}));
    assert!(feed.stored("toolu_1").get("outputPreview").is_none());
}

#[test]
fn an_interrupted_turn_drops_the_preview_with_the_cancelled_row() {
    let mut feed = Feed::new();
    turn(&mut feed);
    feed.start("toolu_1", "Bash");
    feed.progress("toolu_1", json!({"outputPreview": preview("tick")}));
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Interrupted,
        usage: None,
    });
    let row = feed.stored("toolu_1");
    assert_ne!(row["status"], "running");
    assert!(row.get("outputPreview").is_none());
}

#[test]
fn the_settled_row_output_carries_the_bash_output_display() {
    let mut feed = Feed::new();
    turn(&mut feed);
    feed.start("toolu_1", "Bash");
    let display = json!({"kind": "bash_output", "output": "hi\n", "truncated": false});
    feed.apply(KernelEvent::ToolDone {
        tool_use: ToolUseId::new("toolu_1"),
        output: ToolOutput {
            content: vec![ToolResultContent::Text { text: "hi".into() }],
            is_error: false,
            display: display.clone(),
        },
    });
    assert_eq!(
        feed.stored("toolu_1")["output"],
        json!({"text": "hi", "display": display})
    );
}
