//! Fork: ACP rows and the plan panel, live and cold (specs/fork-rust-agent-parity.md "ACP external agents", rules
//! 5–7).
use rust_cli_kernel_api::ids::{ToolUseId, TurnId};
use rust_cli_kernel_api::message::{ContentBlock, ExternalTool, Message, ToolResultContent};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};
use rust_cli_kernel_api::tool::ToolOutput;
use serde_json::{Value, json};

use super::super::external_tools::is_todo_plan_tool_name;
use super::{Feed, Followup, Projection, assistant, user, view};

fn block(
    id: &str,
    name: &str,
    title: &str,
    input: Value,
    output: &str,
    is_error: bool,
) -> ContentBlock {
    ContentBlock::ExternalTool(Box::new(ExternalTool {
        id: ToolUseId::new(id),
        name: name.into(),
        title: title.into(),
        input,
        output: output.into(),
        is_error,
    }))
}

fn row_event(id: &str, name: &str, title: &str, input: Value, running: bool) -> KernelEvent {
    KernelEvent::ExternalToolRow {
        tool_use: ToolUseId::new(id),
        name: name.into(),
        title: title.into(),
        input,
        running,
    }
}

fn done(id: &str, text: &str, is_error: bool) -> KernelEvent {
    KernelEvent::ToolDone {
        tool_use: ToolUseId::new(id),
        output: ToolOutput {
            content: vec![ToolResultContent::Text { text: text.into() }],
            is_error,
            display: Value::Null,
        },
    }
}

/// What the App reads off the rows, without ids and times.
fn shape(projection: &Projection) -> Vec<Value> {
    projection
        .rows
        .iter()
        .filter(|row| row["kind"] != "turnHeader" && row["kind"] != "userInput")
        .map(|row| {
            let keep = [
                "kind",
                "text",
                "toolCallId",
                "toolName",
                "title",
                "status",
                "input",
                "output",
                "assistantResponseId",
            ];
            let mut out = serde_json::Map::new();
            for key in keep {
                if let Some(value) = row.get(key) {
                    out.insert(key.into(), value.clone());
                }
            }
            Value::Object(out)
        })
        .collect()
}

fn messages() -> Vec<Message> {
    vec![
        user("msg_u1", "read a"),
        assistant(
            "msg_a1",
            vec![ContentBlock::Text {
                text: "Reading.".into(),
            }],
        ),
        assistant(
            "msg_a2",
            vec![block(
                "acp_1",
                "acp:read",
                "Read a",
                json!({"path": "a"}),
                "body",
                false,
            )],
        ),
        assistant(
            "msg_a3",
            vec![block(
                "acp_2",
                "acp:execute",
                "",
                json!({}),
                "Cancelled",
                true,
            )],
        ),
        assistant(
            "msg_a4",
            vec![ContentBlock::Text {
                text: "Done.".into(),
            }],
        ),
    ]
}

/// The live events of an ACP turn and the cold read of what it committed give the same rows: one text row per
/// segment, one tool row per ACP tool call, settled with its output and its reply message.
#[test]
fn live_and_cold_acp_rows_agree() {
    let mut feed = Feed::new();
    let turn = TurnId::new("turn_1");
    feed.apply(KernelEvent::TurnStarted {
        turn: turn.clone(),
        command: None,
    });
    let committed = messages();
    feed.apply(KernelEvent::MessageDone {
        message: committed[0].clone(),
    });
    // Each segment streams under its own response number, as the ACP turn emits it.
    let stream = |feed: &mut Feed, response: u32, text: &str| {
        feed.apply(KernelEvent::StreamDelta {
            turn: TurnId::new("turn_1"),
            response,
            index: 0,
            delta: BlockDelta::Text(text.into()),
        });
    };
    stream(&mut feed, 0, "Reading.");
    feed.apply(KernelEvent::MessageDone {
        message: committed[1].clone(),
    });
    let opened = feed.apply(row_event("acp_1", "acp:read", "Read a", json!({}), false));
    assert_eq!(opened[0]["op"], "row.appended");
    let row = &feed.projection.rows[feed.projection.index["tool:acp_1"]];
    assert_eq!(row["status"], "inputStreaming");
    assert_eq!(row["title"], "Read a");
    // A blank title keeps the previous one; the started row runs with the new input.
    feed.apply(row_event(
        "acp_1",
        "acp:read",
        "",
        json!({"path": "a"}),
        true,
    ));
    let row = &feed.projection.rows[feed.projection.index["tool:acp_1"]];
    assert_eq!(
        (
            row["status"].clone(),
            row["title"].clone(),
            row["input"].clone()
        ),
        (json!("running"), json!("Read a"), json!({"path": "a"}))
    );
    assert!(row["startedAt"].is_u64());
    feed.apply(done("acp_1", "body", false));
    // An update after the row settled is ignored.
    feed.apply(row_event(
        "acp_1",
        "acp:read",
        "Late",
        json!({"path": "b"}),
        true,
    ));
    feed.apply(KernelEvent::MessageDone {
        message: committed[2].clone(),
    });
    feed.apply(row_event("acp_2", "acp:execute", "", json!({}), true));
    feed.apply(done("acp_2", "Cancelled", true));
    feed.apply(KernelEvent::MessageDone {
        message: committed[3].clone(),
    });
    stream(&mut feed, 1, "Done.");
    feed.apply(KernelEvent::MessageDone {
        message: committed[4].clone(),
    });
    feed.apply(KernelEvent::TurnFinished {
        turn,
        outcome: TurnOutcome::Success,
        usage: None,
    });

    let live = shape(&feed.projection);
    let cold = shape(&Projection::from_view(
        &view(committed),
        Followup::Queue,
        Vec::new(),
    ));
    let expected = vec![
        json!({"kind": "assistantText", "text": "Reading."}),
        json!({"kind": "toolCall", "toolCallId": "acp_1", "toolName": "acp:read", "title": "Read a",
            "status": "success", "input": {"path": "a"}, "output": {"text": "body"}, "assistantResponseId": "msg_a2"}),
        json!({"kind": "toolCall", "toolCallId": "acp_2", "toolName": "acp:execute", "status": "error",
            "input": {}, "output": {"text": "Cancelled"}, "assistantResponseId": "msg_a3"}),
        json!({"kind": "assistantText", "text": "Done."}),
    ];
    let strip = |rows: Vec<Value>| -> Vec<Value> {
        rows.into_iter()
            .map(|mut row| {
                // Text rows differ in their own message bookkeeping only.
                if row["kind"] == "assistantText" {
                    row.as_object_mut().unwrap().remove("assistantResponseId");
                }
                row
            })
            .collect()
    };
    assert_eq!(strip(live), expected);
    assert_eq!(strip(cold), expected);
}

/// An ACP plan is a `TodoWrite` row whose input sets the snapshot `plan` (Node `todoPlanDeltas`), live and cold.
#[test]
fn a_todo_write_row_sets_the_plan() {
    let todos = json!({"todos": [
        {"content": "Read", "status": "completed", "priority": "high"},
        {"content": "Edit", "status": "in_progress", "priority": "medium"},
        {"content": "Test", "status": "pending", "priority": "low"},
    ]});
    let items = json!([
        {"id": "Read", "content": "Read", "status": "completed"},
        {"id": "Edit", "content": "Edit", "status": "inProgress"},
        {"id": "Test", "content": "Test", "status": "pending"},
    ]);
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let deltas = feed.apply(row_event("acp_p", "TodoWrite", "Plan", todos.clone(), true));
    let patch = deltas
        .iter()
        .find(|delta| delta["op"] == "state.updated")
        .expect("a plan patch");
    assert_eq!(patch["patch"]["plan"]["items"], items);
    assert!(patch["patch"]["plan"]["updatedAt"].is_u64());
    assert_eq!(feed.projection.snapshot(0, "e")["plan"]["items"], items);

    let cold = Projection::from_view(
        &view(vec![
            user("msg_u1", "plan it"),
            assistant(
                "msg_a1",
                vec![block("acp_p", "TodoWrite", "Plan", todos, "{}", false)],
            ),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    assert_eq!(cold.snapshot(0, "e")["plan"]["items"], items);
}

fn plan_patches(deltas: &[Value]) -> Vec<Value> {
    deltas
        .iter()
        .filter(|delta| delta["op"] == "state.updated" && delta["patch"].get("plan").is_some())
        .map(|delta| delta["patch"]["plan"]["items"].clone())
        .collect()
}

/// A plan row projects its plan when it opens and when its input changes before it settles (Node emits on each
/// row's `ToolCallScheduled`). The same input again, a settled row, an ACP tool row and an empty plan change nothing.
#[test]
fn a_plan_patch_follows_its_row() {
    let first = json!({"todos": [{"content": "Read", "status": "pending"}]});
    let first_items = json!([{"id": "Read", "content": "Read", "status": "pending"}]);
    let second = json!({"todos": [{"content": "Edit", "status": "in_progress"}]});
    let second_items = json!([{"id": "Edit", "content": "Edit", "status": "inProgress"}]);
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    let opened = feed.apply(row_event(
        "acp_p",
        "TodoWrite",
        "Plan",
        first.clone(),
        false,
    ));
    assert_eq!(plan_patches(&opened), vec![first_items.clone()]);
    // The row starting with the same input is no new plan.
    let started = feed.apply(row_event("acp_p", "TodoWrite", "Plan", first.clone(), true));
    assert_eq!(plan_patches(&started), Vec::<Value>::new());
    // An ACP tool row is no plan, and an empty plan keeps the last one.
    let other = feed.apply(row_event("acp_1", "acp:other", "", second.clone(), true));
    assert_eq!(plan_patches(&other), Vec::<Value>::new());
    let empty = feed.apply(row_event(
        "acp_e",
        "TodoWrite",
        "Plan",
        json!({"todos": []}),
        true,
    ));
    assert_eq!(plan_patches(&empty), Vec::<Value>::new());
    assert_eq!(
        feed.projection.snapshot(0, "e")["plan"]["items"],
        first_items
    );
    // Once the row settled, a late update reaches neither the row nor the plan.
    feed.apply(done("acp_p", "{}", false));
    let late = feed.apply(row_event(
        "acp_p",
        "TodoWrite",
        "Plan",
        second.clone(),
        true,
    ));
    assert_eq!(plan_patches(&late), Vec::<Value>::new());
    assert_eq!(
        feed.projection.snapshot(0, "e")["plan"]["items"],
        first_items
    );
    // A new plan row with the same steps is projected again, as Node does per row.
    let again = feed.apply(row_event("acp_q", "TodoWrite", "Plan", first, true));
    assert_eq!(plan_patches(&again), vec![first_items]);
    let next = feed.apply(row_event("acp_r", "TodoWrite", "Plan", second, true));
    assert_eq!(plan_patches(&next), vec![second_items]);
}

#[test]
fn todo_plan_tool_names_follow_node() {
    for name in [
        "TodoWrite",
        "todo_write",
        "Todo Read",
        "update_plan",
        "mcp__x__todo-write",
        "updatePlan",
    ] {
        assert!(is_todo_plan_tool_name(name), "{name}");
    }
    for name in ["acp:other", "mytodowrite", "TodoWriter", "Plan", ""] {
        assert!(!is_todo_plan_tool_name(name), "{name}");
    }
}
