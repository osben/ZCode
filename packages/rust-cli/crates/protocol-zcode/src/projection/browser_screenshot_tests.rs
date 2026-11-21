//! Fork (D2, specs/fork-rust-node-helper.md "D2 end-of-turn screenshot"): the screenshot row is the same live and cold, keeps
//! its display on the row, and is placed after the turn's output before the turn closes (Node's `browser_turn_end`
//! part is kept by the projection and never reaches model history).
use rust_cli_kernel_api::browser_turn::BrowserScreenshotRecord;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::ids::{MessageId, ToolUseId, TurnId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::{KernelEvent, SequencedEvent, SessionView, TurnOutcome};
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use serde_json::{Value, json};

use super::super::{Followup, Projection};

fn display() -> Value {
    json!({
        "kind": "node_repl_images",
        "images": [{"base64": "AAAA", "mimeType": "image/png"}],
        "source": "browser_turn_end",
    })
}

fn user(id: &str, text: &str) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        workflow_meta: None,
        epilogue_start: None,
        intent: None,
        id: MessageId::new(id),
        content: vec![ContentBlock::Text { text: text.into() }],
        origin: UserOrigin::Human,
    })
}

fn assistant(id: &str, text: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text { text: text.into() }],
        model: "m".into(),
        stop_reason: None,
        usage: None,
    })
}

fn view(messages: Vec<Message>, browser_screenshots: Vec<BrowserScreenshotRecord>) -> SessionView {
    let mut view = SessionView::new(
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
        messages,
        ModelSelection::new("provider", "model"),
        PermissionMode::Default,
    );
    view.browser_screenshots = browser_screenshots;
    view
}

fn record(anchor: &str, tool_use: &str) -> BrowserScreenshotRecord {
    BrowserScreenshotRecord {
        anchor: MessageId::new(anchor),
        tool_use: ToolUseId::new(tool_use),
        display: display(),
    }
}

/// Live: the event appends one completed row with the `node_repl_images` display on the row, and the turn's
/// `TurnFinished` after it keeps the row.
#[test]
fn live_row_keeps_the_display_on_the_row_channel() {
    let mut projection =
        Projection::from_view(&view(vec![], vec![]), Followup::Queue, vec!["high".into()]);
    let turn = TurnId::new("turn_1");
    let event = |seq: u64, event: KernelEvent| SequencedEvent {
        seq,
        event,
        revision: seq,
    };
    projection.apply(
        &event(
            1,
            KernelEvent::TurnStarted {
                turn: turn.clone(),
                command: None,
            },
        ),
        10,
    );
    projection.apply(
        &event(
            2,
            KernelEvent::BrowserTurnScreenshot {
                turn: turn.clone(),
                tool_use: ToolUseId::new("tool_shot"),
                display: display(),
            },
        ),
        11,
    );
    projection.apply(
        &event(
            3,
            KernelEvent::TurnFinished {
                turn,
                outcome: TurnOutcome::Success,
                usage: None,
            },
        ),
        12,
    );
    let row = projection
        .rows
        .iter()
        .find(|row| row.get("toolCallId") == Some(&json!("tool_shot")))
        .expect("the screenshot row is projected live");
    assert_eq!(row["toolName"], "mcp__node_repl__js");
    assert_eq!(row["status"], "success");
    assert_eq!(row["display"], display());
    assert!(row.get("output").is_some());
}

/// Cold: the stored screenshot of a turn is placed after that turn's output and carries the same display, and a
/// second turn's record is not mixed into the first.
#[test]
fn cold_row_is_placed_at_the_end_of_its_turn_with_the_same_display() {
    let messages = vec![
        user("msg_u1", "first"),
        assistant("msg_a1", "one"),
        user("msg_u2", "second"),
        assistant("msg_a2", "two"),
    ];
    let records = vec![
        record("msg_u1", "tool_shot_1"),
        record("msg_u2", "tool_shot_2"),
    ];
    let projection = Projection::from_view(
        &view(messages, records),
        Followup::Queue,
        vec!["high".into()],
    );
    let kinds: Vec<String> = projection
        .rows
        .iter()
        .map(|row| row["kind"].to_string())
        .collect();
    let shot_positions: Vec<usize> = projection
        .rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row.get("toolName") == Some(&json!("mcp__node_repl__js")))
        .map(|(index, _)| index)
        .collect();
    assert_eq!(
        shot_positions.len(),
        2,
        "both stored screenshots are projected: {kinds:?}"
    );
    let first_row = &projection.rows[shot_positions[0]];
    assert_eq!(first_row.get("toolCallId"), Some(&json!("tool_shot_1")));
    assert_eq!(first_row["display"], display());
    let second_row = &projection.rows[shot_positions[1]];
    assert_eq!(second_row.get("toolCallId"), Some(&json!("tool_shot_2")));
    let first_turn_output = projection
        .rows
        .iter()
        .position(|row| row.get("text") == Some(&json!("one")))
        .expect("the first turn's output row");
    assert!(
        first_turn_output < shot_positions[0],
        "the screenshot comes after the turn's output"
    );
    let second_turn_header = projection
        .rows
        .iter()
        .position(|row| row.get("text") == Some(&json!("second")))
        .expect("the second turn's input row");
    assert!(
        shot_positions[0] < second_turn_header,
        "the first screenshot closes before the next turn"
    );
}

/// A screenshot whose anchor is no longer in the history is not projected (a rewind cut its turn).
#[test]
fn a_screenshot_of_a_cut_turn_is_not_projected() {
    let projection = Projection::from_view(
        &view(
            vec![user("msg_u1", "first")],
            vec![record("msg_gone", "tool_gone")],
        ),
        Followup::Queue,
        vec!["high".into()],
    );
    assert!(
        projection
            .rows
            .iter()
            .all(|row| row.get("toolName") != Some(&json!("mcp__node_repl__js")))
    );
}
