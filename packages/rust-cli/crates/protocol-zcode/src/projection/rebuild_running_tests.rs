//! Fork: a projection rebuilt from a view while a turn runs keys that turn by the view's `running_turn`, so the
//! events that follow land on it (specs/fork-rust-agent-parity.md, side-pane tab of a running subagent).

use super::*;

fn call(id: &str, tool: &str) -> Message {
    assistant(
        id,
        vec![ContentBlock::ToolUse {
            id: ToolUseId::new(tool),
            name: "Read".into(),
            input: json!({"file_path": "/w/a.txt"}),
        }],
    )
}

fn result(id: &str, tool: &str, reply: &str) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new(id),
        content: vec![ContentBlock::ToolResult {
            tool_use_id: ToolUseId::new(tool),
            content: vec![ToolResultContent::Text { text: "a".into() }],
            is_error: false,
        }],
        origin: UserOrigin::ToolResult {
            assistant: MessageId::new(reply),
        },
    })
}

fn rows(projection: &Projection) -> Vec<String> {
    projection.snapshot(0, "epoch")["rows"]["window"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            format!(
                "{}:{}:{}",
                row["kind"].as_str().unwrap(),
                row["turnId"].as_str().unwrap_or(""),
                row["text"].as_str().or(row["state"].as_str()).unwrap_or("")
            )
        })
        .collect()
}

#[test]
fn a_turn_running_through_a_rebuild_keeps_one_reply_and_finishes_its_header() {
    let mut feed = Feed::new();
    let mut running = view(vec![
        user("msg_u1", "first"),
        assistant("msg_a1", vec![ContentBlock::Text { text: "one".into() }]),
        user("msg_u2", "second"),
        call("msg_a2", "tool_1"),
        result("msg_r1", "tool_1", "msg_a2"),
    ]);
    running.running = true;
    running.running_turn = Some(TurnId::new("turn_live"));
    feed.projection = feed.projection.rebuilt(&running);

    feed.apply(KernelEvent::StreamDelta {
        turn: TurnId::new("turn_live"),
        response: 1,
        index: 0,
        delta: BlockDelta::Text("DONE".into()),
    });
    feed.apply(KernelEvent::MessageDone {
        message: assistant(
            "msg_a3",
            vec![ContentBlock::Text {
                text: "DONE".into(),
            }],
        ),
    });
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_live"),
        outcome: TurnOutcome::Success,
        usage: None,
    });

    assert_eq!(
        rows(&feed.projection),
        [
            "turnHeader:msg_u1:turn:1:completedSuccess",
            "userInput:msg_u1:turn:1:first",
            "assistantText:msg_u1:turn:1:one",
            "turnHeader:turn_live:completedSuccess",
            "userInput:turn_live:second",
            "toolCall:turn_live:",
            "assistantText:turn_live:DONE",
        ]
    );
    assert_eq!(
        feed.projection.snapshot(0, "epoch")["control"]["phase"],
        "completedSuccess"
    );
}

/// An idle view keeps the cold turn ids even when it names a turn.
#[test]
fn an_idle_view_keeps_the_cold_turn_ids() {
    let mut idle = view(vec![
        user("msg_u1", "first"),
        assistant("msg_a1", vec![ContentBlock::Text { text: "one".into() }]),
    ]);
    idle.running_turn = Some(TurnId::new("turn_live"));
    let projection = Projection::from_view(&idle, Followup::Guide, Vec::new());
    assert_eq!(
        rows(&projection),
        [
            "turnHeader:msg_u1:turn:1:completedSuccess",
            "userInput:msg_u1:turn:1:first",
            "assistantText:msg_u1:turn:1:one",
        ]
    );
}
