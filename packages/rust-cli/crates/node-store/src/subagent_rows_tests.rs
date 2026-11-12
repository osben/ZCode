//! subagent_rows: the parent document (branch cursor, merged metadata, tool filter) and the
//! child rows (per-id lookup, last assistant outcome) that feed the App's subagent directory.

use rust_cli_kernel_api::ids::{AgentId, MessageId, SessionId, ToolUseId};
use rust_cli_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, StopReason, ToolResultContent, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::store::{Fact, SessionKind, SessionStore};

use super::*;
use crate::repo::sessions as repo_sessions;
use crate::tests::{TestStore, batch, meta, started, text, user};

fn tool_call(message: &str, call: &str, name: &str, input: Value) -> Fact {
    Fact::MessageAppended {
        message: Message::Assistant(AssistantMessage {
            id: MessageId::new(message),
            content: vec![ContentBlock::ToolUse {
                id: ToolUseId::new(call),
                name: name.into(),
                input,
            }],
            model: "m".into(),
            stop_reason: Some(StopReason::ToolUse),
            usage: None,
        }),
    }
}

fn tool_result(message: &str, assistant: &str, call: &str) -> Fact {
    Fact::MessageAppended {
        message: Message::User(UserMessage {
            stall_execution: None,
            intent: None,
            id: MessageId::new(message),
            content: vec![ContentBlock::ToolResult {
                tool_use_id: ToolUseId::new(call),
                content: vec![ToolResultContent::Text {
                    text: "report".into(),
                }],
                is_error: false,
            }],
            origin: UserOrigin::ToolResult {
                assistant: MessageId::new(assistant),
            },
        }),
    }
}

/// The whole read-side shape on one seeded database: a linked Agent part in the parent document
/// and the child row with its final assistant answer.
#[tokio::test]
async fn the_parent_document_carries_the_linked_part_and_the_child_its_outcome() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let facts = vec![
        user("msg_u1", "Explore"),
        tool_call(
            "msg_a1",
            "toolu_1",
            "Agent",
            json!({"subagent_type": "Explore", "prompt": "look", "description": "scan"}),
        ),
        tool_result("msg_r1", "msg_a1", "toolu_1"),
        Fact::SubagentLinked {
            tool_use: ToolUseId::new("toolu_1"),
            agent: AgentId::new("agent_1"),
            child: SessionId::new("sess_subagent_agent_1"),
            agent_type: "Explore".into(),
        },
    ];
    t.store
        .commit(&SessionId::new("sess_1"), batch(None, facts))
        .await
        .unwrap();
    let mut child = meta("sess_subagent_agent_1", "/w", "");
    child.kind = SessionKind::Subagent;
    child.parent = Some(SessionId::new("sess_1"));
    t.store.create(child).await.unwrap();
    t.store
        .commit(
            &SessionId::new("sess_subagent_agent_1"),
            batch(
                None,
                vec![
                    user("msg_c1", "go"),
                    Fact::MessageAppended {
                        message: Message::Assistant(AssistantMessage {
                            id: MessageId::new("msg_c2"),
                            content: vec![text("done")],
                            model: "m".into(),
                            stop_reason: Some(StopReason::EndTurn),
                            usage: None,
                        }),
                    },
                ],
            ),
        )
        .await
        .unwrap();

    let conn = t.connection();
    let doc = parent_rows(&conn, "sess_1").unwrap();
    assert_eq!(doc["parent"]["id"], json!("sess_1"));
    assert!(doc["parent"]["timeUpdated"].as_i64().is_some());
    let parts = doc["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["callId"], json!("toolu_1"));
    assert_eq!(parts[0]["tool"], json!("Agent"));
    assert_eq!(parts[0]["status"], json!("completed"));
    assert_eq!(parts[0]["output"], json!("report"));
    assert_eq!(
        parts[0]["metadata"]["childSessionId"],
        json!("sess_subagent_agent_1")
    );
    assert_eq!(parts[0]["metadata"]["agentId"], json!("agent_1"));
    assert_eq!(parts[0]["metadata"]["agentType"], json!("Explore"));
    assert!(parts[0]["startedAt"].as_u64().is_some());
    assert!(parts[0]["endedAt"].as_u64().is_some());

    let children = child_rows(
        &conn,
        &[
            "sess_subagent_agent_1".to_owned(),
            "sess_missing".to_owned(),
        ],
    )
    .unwrap();
    let rows = children["children"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], json!("sess_subagent_agent_1"));
    assert_eq!(rows[0]["taskType"], json!("subagent_child"));
    assert!(rows[0]["timeUpdated"].as_i64().is_some());
    assert_eq!(rows[0]["lastAssistant"]["text"], json!("done"));
    assert_eq!(rows[0]["lastAssistant"]["hasToolPart"], json!(false));
    assert!(rows[0]["lastAssistant"]["finish"].as_str().is_some());
    assert!(rows[0]["lastAssistant"]["completedAt"].as_u64().is_some());
}

/// An unknown parent is an empty document (`parent: null`), not an error — the protocol layer
/// owns Node's session-unavailable error.
#[tokio::test]
async fn an_unknown_parent_is_an_empty_document() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let conn = t.connection();
    let doc = parent_rows(&conn, "sess_none").unwrap();
    assert_eq!(doc, json!({"parent": null, "parts": []}));
    let children = child_rows(&conn, &["sess_none".to_owned()]).unwrap();
    assert_eq!(children, json!({"children": []}));
}

/// Only the three subagent tool names enter the document, and the revert cursor cuts the branch
/// before the parts are collected (Node `activeBranchMessages`).
#[tokio::test]
async fn other_tools_are_skipped_and_the_revert_cursor_cuts_the_branch() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let facts = vec![
        user("msg_u1", "run"),
        tool_call("msg_a1", "toolu_1", "Agent", json!({"prompt": "look"})),
        tool_result("msg_r1", "msg_a1", "toolu_1"),
        tool_call("msg_a2", "toolu_2", "Bash", json!({"command": "ls"})),
        tool_result("msg_r2", "msg_a2", "toolu_2"),
    ];
    t.store
        .commit(&SessionId::new("sess_1"), batch(None, facts))
        .await
        .unwrap();
    let conn = t.connection();
    let doc = parent_rows(&conn, "sess_1").unwrap();
    let parts = doc["parts"].as_array().unwrap();
    assert_eq!(parts.len(), 1);
    assert_eq!(parts[0]["tool"], json!("Agent"));

    // Rewind to the first user message: the branch is empty, so no parts survive.
    repo_sessions::update(
        &conn,
        &repo_sessions::Update {
            id: "sess_1".to_owned(),
            revert: Some(json!({"targetMessageID": "msg_u1"})),
            ..Default::default()
        },
        2000,
    )
    .unwrap();
    let doc = parent_rows(&conn, "sess_1").unwrap();
    assert_eq!(doc["parts"], json!([]));
}
