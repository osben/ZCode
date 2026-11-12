//! Fork: a tool row opens while the tool input streams (Node `tool_input_start`, specs/fork-rust-agent-parity.md).

use rust_cli_kernel_api::ids::{CommandId, ToolUseId, TurnId};
use rust_cli_kernel_api::message::ContentBlock;
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};
use serde_json::{Map, Value, json};

use super::{Feed, Projection, assistant, user};

const CALL: &str = "toolu_exit";

fn started(feed: &mut Feed) {
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    feed.apply(KernelEvent::MessageDone {
        message: user("msg_u1", "plan it"),
    });
}

fn input_started() -> KernelEvent {
    KernelEvent::ToolInputStarted {
        turn: TurnId::new("turn_1"),
        response: 0,
        index: 1,
        tool_use: ToolUseId::new(CALL),
        name: "ExitPlanMode".into(),
    }
}

fn input_delta(text: &str) -> KernelEvent {
    KernelEvent::StreamDelta {
        turn: TurnId::new("turn_1"),
        response: 0,
        index: 1,
        delta: BlockDelta::InputJson(text.into()),
    }
}

fn tool_rows(projection: &Projection) -> Vec<&Map<String, Value>> {
    projection
        .rows
        .iter()
        .filter(|row| row["kind"] == "toolCall")
        .collect()
}

fn streamed(feed: &mut Feed) -> Vec<Value> {
    started(feed);
    let mut out = feed.apply(input_started());
    out.extend(feed.apply(input_delta("{\"plan\":")));
    out.extend(feed.apply(input_delta("\"p\"}")));
    out
}

#[test]
fn the_row_opens_when_the_tool_input_starts_and_grows_with_it() {
    let mut feed = Feed::new();
    let out = streamed(&mut feed);
    assert_eq!(out[0]["op"], "row.appended");
    let deltas: Vec<&Value> = out.iter().filter(|op| op["op"] == "row.delta").collect();
    assert_eq!(
        deltas,
        [
            &json!({"op": "row.delta", "rowId": out[0]["row"]["rowId"], "path": "inputText", "append": "{\"plan\":"}),
            &json!({"op": "row.delta", "rowId": out[0]["row"]["rowId"], "path": "inputText", "append": "\"p\"}"}),
        ]
    );
    let rows = tool_rows(&feed.projection);
    let [row] = rows.as_slice() else {
        panic!("one tool row: {rows:?}");
    };
    assert_eq!(row["toolCallId"], CALL);
    assert_eq!(row["toolName"], "ExitPlanMode");
    assert_eq!(row["status"], "inputStreaming");
    assert_eq!(row["inputText"], "{\"plan\":\"p\"}");
    assert!(row.get("input").is_none());
    // A repeated start adds nothing.
    let again = feed.apply(input_started());
    assert!(
        again.iter().all(|op| op["op"] == "state.updated"),
        "{again:?}"
    );
    assert_eq!(tool_rows(&feed.projection).len(), 1);
}

#[test]
fn the_committed_call_finalizes_the_streaming_row() {
    let mut feed = Feed::new();
    streamed(&mut feed);
    feed.apply(KernelEvent::MessageDone {
        message: assistant(
            "msg_a1",
            vec![ContentBlock::ToolUse {
                id: ToolUseId::new(CALL),
                name: "ExitPlanMode".into(),
                input: json!({"plan": "p"}),
            }],
        ),
    });
    // Late input deltas do not change the finalized row.
    feed.apply(input_delta("junk"));
    let rows = tool_rows(&feed.projection);
    let [row] = rows.as_slice() else {
        panic!("one tool row: {rows:?}");
    };
    assert_eq!(row["status"], "running");
    assert_eq!(row["input"], json!({"plan": "p"}));
    assert_eq!(row["inputText"], json!({"plan": "p"}).to_string());
    assert_eq!(row["assistantResponseId"], "msg_a1");
}

#[test]
fn a_turn_that_ends_while_the_input_streams_cancels_the_row() {
    let mut feed = Feed::new();
    streamed(&mut feed);
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Interrupted,
        usage: None,
    });
    assert_eq!(tool_rows(&feed.projection)[0]["status"], "cancelled");
}

#[test]
fn write_and_edit_publish_their_streaming_input_at_most_once_a_second() {
    let mut feed = Feed::new();
    started(&mut feed);
    feed.apply(KernelEvent::ToolInputStarted {
        turn: TurnId::new("turn_1"),
        response: 0,
        index: 1,
        tool_use: ToolUseId::new(CALL),
        name: "Write".into(),
    });
    let first = feed.apply(input_delta("{\"content\":\"a"));
    let second = feed.apply(input_delta("b"));
    let is_delta = |ops: &[Value]| ops.iter().any(|op| op["op"] == "row.delta");
    assert!(is_delta(&first));
    assert!(!is_delta(&second), "{second:?}");
    assert_eq!(
        tool_rows(&feed.projection)[0]["inputText"],
        "{\"content\":\"a"
    );
}
