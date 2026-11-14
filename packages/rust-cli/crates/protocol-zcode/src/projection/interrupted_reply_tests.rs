//! Fork: a reply cut off by Stop closes `interrupted` (Node `closeStreamingRows("interrupted")`), so the UI shows no
//! action row under it; live and cold agree (specs/fork-rust-agent-parity.md).

use rust_cli_kernel_api::ids::{MessageId, TurnId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, StopReason, SystemMessage,
};
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};

use super::{Feed, Followup, Projection, user, view};

fn reply(stop_reason: Option<StopReason>) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new("msg_a1"),
        content: vec![ContentBlock::Text {
            text: "Half a sent".into(),
        }],
        model: "m".into(),
        stop_reason,
        usage: None,
    })
}

fn live_state(stop_reason: Option<StopReason>, outcome: TurnOutcome) -> String {
    let mut feed = Feed::new();
    let turn = TurnId::new("turn_1");
    feed.apply(KernelEvent::TurnStarted {
        turn: turn.clone(),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: reply(stop_reason),
    });
    feed.apply(KernelEvent::TurnFinished {
        turn,
        outcome,
        usage: None,
    });
    text_state(&feed.projection)
}

fn text_state(projection: &Projection) -> String {
    projection
        .rows
        .iter()
        .find(|row| row.get("kind").is_some_and(|kind| kind == "assistantText"))
        .and_then(|row| row["state"].as_str())
        .expect("the reply row")
        .to_owned()
}

#[test]
fn a_reply_cut_off_by_stop_closes_interrupted() {
    assert_eq!(live_state(None, TurnOutcome::Interrupted), "interrupted");
    // A finished reply keeps `complete` even when the turn is stopped later (a Stop hook, a tool).
    assert_eq!(
        live_state(Some(StopReason::EndTurn), TurnOutcome::Interrupted),
        "complete"
    );
    // A reply stored without a stop reason in a turn that completed is `complete`.
    assert_eq!(live_state(None, TurnOutcome::Success), "complete");

    let cold = Projection::from_view(
        &view(vec![
            user("msg_u1", "write it"),
            reply(None),
            Message::System(SystemMessage::Interrupted {
                id: MessageId::new("msg_i1"),
            }),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    assert_eq!(text_state(&cold), "interrupted");
}

fn stopped_tool(outcome: TurnOutcome) -> serde_json::Map<String, serde_json::Value> {
    use rust_cli_kernel_api::ids::ToolUseId;
    use rust_cli_kernel_api::message::ToolResultContent;
    use rust_cli_kernel_api::tool::{REJECT_MESSAGE, ToolOutput};

    let mut feed = Feed::new();
    let turn = TurnId::new("turn_1");
    feed.apply(KernelEvent::TurnStarted {
        turn: turn.clone(),
        command: None,
    });
    let tool = ToolUseId::new("toolu_sleep");
    feed.apply(KernelEvent::ToolStarted {
        tool_use: tool.clone(),
        name: "Bash".into(),
        input: serde_json::json!({"command": "sleep 60"}),
    });
    feed.apply(KernelEvent::ToolDone {
        tool_use: tool,
        output: ToolOutput {
            content: vec![ToolResultContent::Text {
                text: REJECT_MESSAGE.into(),
            }],
            is_error: true,
            display: serde_json::Value::Null,
        },
    });
    feed.apply(KernelEvent::TurnFinished {
        turn,
        outcome,
        usage: None,
    });
    feed.projection
        .rows
        .iter()
        .find(|row| row.get("toolCallId").is_some_and(|id| id == "toolu_sleep"))
        .cloned()
        .expect("the Bash row")
}

/// Fork: a call cut off by Stop reads `cancelled` with no output (Node `ToolCancelled`), not `Failed`.
#[test]
fn a_tool_stopped_by_stop_settles_cancelled() {
    let stopped = stopped_tool(TurnOutcome::Interrupted);
    assert_eq!(stopped["status"], "cancelled");
    assert!(stopped.get("output").is_none(), "{stopped:?}");
    // A rejection in a turn that went on keeps its result.
    let declined = stopped_tool(TurnOutcome::Success);
    assert_eq!(declined["status"], "error");
}

/// Fork: a cold read keys each unstreamed reply by its message, so the replies of one turn (text, tool, text) are
/// rows of their own; they used to share `(turn, u32::MAX, index)` and the last text overwrote the first.
#[test]
fn a_cold_turn_keeps_every_reply_text() {
    use rust_cli_kernel_api::ids::ToolUseId;
    use rust_cli_kernel_api::message::{ToolResultContent, UserMessage, UserOrigin};

    let reply = |id: &str, content: Vec<ContentBlock>| {
        Message::Assistant(AssistantMessage {
            id: MessageId::new(id),
            content,
            model: "m".into(),
            stop_reason: Some(StopReason::EndTurn),
            usage: None,
        })
    };
    let text = |text: &str| ContentBlock::Text { text: text.into() };
    let cold = Projection::from_view(
        &view(vec![
            user("msg_u1", "go"),
            reply(
                "msg_a1",
                vec![
                    text("first"),
                    ContentBlock::ToolUse {
                        id: ToolUseId::new("toolu_1"),
                        name: "Read".into(),
                        input: serde_json::json!({}),
                    },
                ],
            ),
            Message::User(UserMessage {
                stall_execution: None,
                intent: None,
                id: MessageId::new("msg_r1"),
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: ToolUseId::new("toolu_1"),
                    content: vec![ToolResultContent::Text { text: "r".into() }],
                    is_error: false,
                }],
                origin: UserOrigin::ToolResult {
                    assistant: MessageId::new("msg_a1"),
                },
            }),
            reply("msg_a2", vec![text("second")]),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    let rows: Vec<(String, String)> = cold
        .rows
        .iter()
        .filter(|row| row["kind"] == "assistantText" || row["kind"] == "toolCall")
        .map(|row| {
            let label = row
                .get("text")
                .or_else(|| row.get("toolName"))
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            (row["kind"].as_str().unwrap().to_owned(), label.to_owned())
        })
        .collect();
    let pair = |kind: &str, label: &str| (kind.to_owned(), label.to_owned());
    assert_eq!(
        rows,
        vec![
            pair("assistantText", "first"),
            pair("toolCall", "Read"),
            pair("assistantText", "second"),
        ]
    );
}
