//! Fork: ACP rows ↔ Node `tool` parts with `metadata.externalAgent` (specs/fork-rust-agent-parity.md "ACP external
//! agents", rule 5).
use rust_cli_kernel_api::ids::{MessageId, SessionId, ToolUseId};
use rust_cli_kernel_api::message::{ContentBlock, ExternalTool, Message};
use rust_cli_kernel_api::store::SessionStore;
use serde_json::{Value, json};

use crate::repo::messages;
use crate::tests::{TestStore, assistant, batch, started, text, user};

fn sid() -> SessionId {
    SessionId::new("sess_1")
}

fn row(id: &str, name: &str, title: &str, output: &str, is_error: bool) -> ContentBlock {
    ContentBlock::ExternalTool(Box::new(ExternalTool {
        id: ToolUseId::new(id),
        name: name.into(),
        title: title.into(),
        input: json!({"path": "a.txt"}),
        output: output.into(),
        is_error,
    }))
}

fn tool_parts(t: &TestStore, message: &str) -> Vec<Value> {
    t.rows(&format!(
        "select data from part where message_id = '{message}' and data like '{{\"type\":\"tool\"%'
         order by sequence"
    ))
    .into_iter()
    .map(|row| serde_json::from_str(row[0].as_str().unwrap()).unwrap())
    .collect()
}

/// The time of a stored part, taken out so the rest compares exactly.
fn without_time(mut part: Value) -> Value {
    let time = part["state"]
        .as_object_mut()
        .unwrap()
        .remove("time")
        .unwrap();
    assert!(time["start"].as_u64().unwrap() <= time["end"].as_u64().unwrap());
    part
}

/// A settled row is Node's part (`ExternalAgentToolRows.#persist`/`#finish`), and a cold read gives the row back;
/// no tool result message is written or read.
#[tokio::test]
async fn rows_are_stored_as_node_external_agent_parts_and_read_back() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let facts = vec![
        user("msg_ru_u1", "Read a.txt"),
        assistant("msg_rv_a1", vec![text("Reading.")], None),
        assistant(
            "msg_rw_a2",
            vec![row("acp_1", "acp:read", "Read a.txt", "body", false)],
            None,
        ),
        assistant(
            "msg_rx_a3",
            vec![row("acp_2", "acp:execute", "Run tests", "Cancelled", true)],
            None,
        ),
        assistant(
            "msg_ry_a4",
            vec![row("acp_3", "acp:other", "", "done", false)],
            None,
        ),
    ];
    for fact in &facts {
        t.store
            .commit(&sid(), batch(None, vec![fact.clone()]))
            .await
            .unwrap();
    }

    let completed = json!({"type": "tool", "callID": "acp_1", "tool": "acp:read",
        "metadata": {"externalAgent": true},
        "state": {"status": "completed", "input": {"path": "a.txt"}, "output": "body", "title": "Read a.txt",
            "metadata": {"externalAgent": true}}});
    assert_eq!(
        tool_parts(&t, "msg_rw_a2")
            .into_iter()
            .map(without_time)
            .collect::<Vec<_>>(),
        vec![completed]
    );
    // Node's error state has no title; the row keeps it in the part's `rustCli` marker for a cold read.
    let failed = json!({"type": "tool", "callID": "acp_2", "tool": "acp:execute",
        "metadata": {"externalAgent": true, "rustCli": {"title": "Run tests"}},
        "state": {"status": "error", "input": {"path": "a.txt"}, "error": "Cancelled",
            "metadata": {"externalAgent": true}}});
    assert_eq!(
        tool_parts(&t, "msg_rx_a3")
            .into_iter()
            .map(without_time)
            .collect::<Vec<_>>(),
        vec![failed]
    );
    // A blank title is stored as the tool name, like Node's `row.title || row.toolName`.
    assert_eq!(
        tool_parts(&t, "msg_ry_a4")[0]["state"]["title"],
        "acp:other"
    );

    let loaded = t.store.load(&sid()).await.unwrap();
    let expected: Vec<Message> = facts
        .iter()
        .filter_map(|fact| match fact {
            rust_cli_kernel_api::store::Fact::MessageAppended { message } => Some(message.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(loaded.messages, expected);
}

/// A Node-written ACP turn (one assistant message: text, external tool parts, text) reads back as `ExternalTool`
/// blocks in part order. An unsettled external part (the turn was killed mid-tool) is an error row, never a
/// `tool_use` with a synthetic interrupted result.
#[tokio::test]
async fn a_node_written_acp_turn_reads_back_without_tool_calls() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    for fact in [
        user("msg_ru_u1", "Go"),
        assistant("msg_rv_a1", vec![text("first")], None),
    ] {
        t.store
            .commit(&sid(), batch(None, vec![fact]))
            .await
            .unwrap();
    }
    let owner = |id: &str, data: Value| {
        let mut part = json!({"id": id, "sessionID": "sess_1", "messageID": "msg_rv_a1"});
        for (key, value) in data.as_object().unwrap() {
            part[key] = value.clone();
        }
        part
    };
    let parts = [
        owner(
            "prt_n1",
            json!({"type": "tool", "callID": "call_n1", "tool": "acp:read",
                "metadata": {"externalAgent": true},
                "state": {"status": "completed", "input": {"path": "a"}, "output": "A", "title": "acp:read",
                    "metadata": {"externalAgent": true}, "time": {"start": 1, "end": 2}}}),
        ),
        owner(
            "prt_n2",
            json!({"type": "tool", "callID": "call_n2", "tool": "acp:edit",
                "metadata": {"externalAgent": true},
                "state": {"status": "running", "input": {}, "title": "Edit b", "time": {"start": 3}}}),
        ),
        owner(
            "prt_n3",
            json!({"type": "tool", "callID": "call_n3", "tool": "TodoWrite",
                "metadata": {"externalAgent": true},
                "state": {"status": "error", "input": {"todos": []}, "error": "TodoWrite failed",
                    "metadata": {"externalAgent": true}, "time": {"start": 4, "end": 5}}}),
        ),
        owner(
            "prt_n4",
            json!({"type": "text", "text": "second", "time": {"start": 6, "end": 6}}),
        ),
    ];
    let conn = t.connection();
    for part in &parts {
        messages::save_part(&conn, part, 3000).unwrap();
    }

    let loaded = t.store.load(&sid()).await.unwrap();
    let tool = |id: &str, name: &str, title: &str, input: Value, output: &str, is_error: bool| {
        ContentBlock::ExternalTool(Box::new(ExternalTool {
            id: ToolUseId::new(id),
            name: name.into(),
            title: title.into(),
            input,
            output: output.into(),
            is_error,
        }))
    };
    let Message::Assistant(reply) = &loaded.messages[1] else {
        panic!("{:?}", loaded.messages);
    };
    assert_eq!(reply.id, MessageId::new("msg_rv_a1"));
    assert_eq!(
        reply.content,
        vec![
            text("first"),
            // The stored title is the tool name: the row has no title of its own.
            tool("call_n1", "acp:read", "", json!({"path": "a"}), "A", false),
            tool("call_n2", "acp:edit", "Edit b", json!({}), "", true),
            tool(
                "call_n3",
                "TodoWrite",
                "",
                json!({"todos": []}),
                "TodoWrite failed",
                true
            ),
            text("second"),
        ]
    );
    assert_eq!(loaded.messages.len(), 2, "{:?}", loaded.messages);
}
