//! Fork: the background result turn header (projection/background_result.rs).

use rust_cli_kernel_api::ids::{MessageId, ToolUseId, TurnId};
use rust_cli_kernel_api::message::{
    ContentBlock, Message, ToolResultContent, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::session_api::KernelEvent;
use serde_json::json;

use super::{Feed, Followup, Projection, assistant, row_of, user, view};
use rust_cli_kernel_api::background_origin::origin_meta;

fn notification(id: &str, task: &str, summary: &str) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: format!(
                "<system-reminder>\n<task-notification>\n<task-id>{task}</task-id>\n<status>completed</status>\n<summary>{summary}</summary>\n</task-notification>\n</system-reminder>"
            ),
        }],
        origin: UserOrigin::Meta {
            source: "task-notification".into(),
        },
    })
}

#[test]
fn the_meta_comes_from_the_notification_summary() {
    let agent = origin_meta(
        "<task-notification><task-id>agent_1</task-id><summary>Agent \"Check \"x\" background\" failed: boom \"y\"</summary></task-notification>",
    );
    assert_eq!(
        agent,
        Some(
            json!({"backgroundSource": "subagent", "workId": "agent_1", "title": "Check \"x\" background"})
        )
    );
    let bash = origin_meta(
        "<task-notification><task-id>b1</task-id><summary>Background command \"Print background marker\" completed (exit code 0)</summary></task-notification>",
    );
    assert_eq!(
        bash,
        Some(
            json!({"backgroundSource": "bash", "workId": "b1", "title": "Print background marker"})
        )
    );
    assert_eq!(
        origin_meta(
            "<task-notification><task-id>m1</task-id><summary>Monitor ended</summary></task-notification>"
        ),
        None
    );
}

/// A notification turn's header is the background result header; a typed turn keeps `userInput`.
#[test]
fn a_notification_turn_is_a_background_result_turn() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_n"),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: notification("msg_n", "agent_1", "Agent \"Check background\" completed"),
    });
    let header = row_of(&feed.projection, "turnHeader", "turn_n");
    assert_eq!(header["origin"], "backgroundResult");
    assert_eq!(
        header["originMeta"],
        json!({
            "backgroundSource": "subagent",
            "workId": "agent_1",
            "title": "Check background",
            "subagentResult": {"status": "completed"},
        })
    );
}

/// Node's agent summary reads `finished`; a failed agent's reason becomes the structured error.
#[test]
fn an_agent_notification_carries_its_result() {
    let finished = origin_meta(
        "<task-notification><task-id>agent_1</task-id><status>completed</status><summary>Agent \"BG36 first\" finished</summary></task-notification>",
    );
    assert_eq!(
        finished,
        Some(json!({
            "backgroundSource": "subagent",
            "workId": "agent_1",
            "title": "BG36 first",
            "subagentResult": {"status": "completed"},
        }))
    );
    let failed = origin_meta(
        "<task-notification><task-id>agent_2</task-id><status>failed</status><summary>Agent \"Probe\" failed: provider down</summary></task-notification>",
    );
    assert_eq!(
        failed.as_ref().map(|meta| &meta["subagentResult"]),
        Some(&json!({"status": "failed", "error": "provider down"}))
    );
}

/// The cold projection opens a turn for a notification after a finished turn, and merges one that
/// followed a tool call into its turn.
#[test]
fn a_cold_notification_after_a_finished_turn_opens_its_own_turn() {
    let projection = Projection::from_view(
        &view(vec![
            user("msg_u1", "start it"),
            assistant(
                "msg_a1",
                vec![ContentBlock::Text {
                    text: "started".into(),
                }],
            ),
            notification(
                "msg_n1",
                "b1",
                "Background command \"Print background marker\" completed (exit code 0)",
            ),
            assistant(
                "msg_a2",
                vec![ContentBlock::Text {
                    text: "consumed".into(),
                }],
            ),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    let headers: Vec<_> = projection
        .rows
        .iter()
        .filter(|row| row["kind"] == "turnHeader")
        .collect();
    assert_eq!(headers.len(), 2);
    assert_eq!(headers[0]["origin"], "userInput");
    assert_eq!(headers[1]["origin"], "backgroundResult");
    assert_eq!(headers[1]["originMeta"]["title"], "Print background marker");
    assert_eq!(headers[1]["state"], "completedSuccess");
}

#[test]
fn every_notified_status_is_read() {
    let text = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>\n\
                <task-notification>\n<task-id>agent_2</task-id>\n<status>killed</status>\n</task-notification>";
    assert_eq!(
        super::super::background_result::notified_statuses(text),
        [
            ("b1".to_owned(), "completed".to_owned()),
            ("agent_2".to_owned(), "killed".to_owned())
        ]
    );
}

/// Node `resolveBackgroundTaskNotificationOriginMeta`: a batch of notifications opening one turn
/// titles the header with the first three titles joined by ` · ` and `+N` for the rest, under the
/// first task's work id.
#[test]
fn a_notification_batch_joins_the_titles() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_b"),
        command: None,
    });
    for (n, title) in ["One", "Two", "Three", "Four"].iter().enumerate() {
        feed.apply(KernelEvent::MessageDone {
            message: notification(
                &format!("msg_{n}"),
                &format!("agent_{n}"),
                &format!("Agent \"{title}\" completed"),
            ),
        });
        if n == 1 {
            let header = row_of(&feed.projection, "turnHeader", "turn_b");
            assert_eq!(header["originMeta"]["title"], "One · Two");
        }
    }
    let header = row_of(&feed.projection, "turnHeader", "turn_b");
    assert_eq!(header["origin"], "backgroundResult");
    assert_eq!(
        header["originMeta"],
        json!({"backgroundSource": "subagent", "workId": "agent_0", "title": "One · Two · Three · +1"})
    );
}

/// Each notification of a batch is its own stored message: on a cold read the ones that follow the
/// first without an assistant message in between join its turn, like the live turn.
#[test]
fn a_cold_notification_batch_is_one_turn() {
    let projection = Projection::from_view(
        &view(vec![
            user("msg_u1", "start them"),
            assistant(
                "msg_a1",
                vec![ContentBlock::Text {
                    text: "started".into(),
                }],
            ),
            notification("msg_n1", "agent_2", "Agent \"Second\" completed"),
            notification("msg_n2", "agent_3", "Agent \"Third\" completed"),
            assistant(
                "msg_a2",
                vec![ContentBlock::Text {
                    text: "consumed".into(),
                }],
            ),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    let headers: Vec<_> = projection
        .rows
        .iter()
        .filter(|row| row["kind"] == "turnHeader")
        .collect();
    assert_eq!(headers.len(), 2);
    assert_eq!(headers[1]["origin"], "backgroundResult");
    assert_eq!(
        headers[1]["originMeta"],
        json!({"backgroundSource": "subagent", "workId": "agent_2", "title": "Second · Third"})
    );
}

/// A batch stored as one message with a text block per notification (Node's storage) titles the
/// header with every notified work, live and cold.
#[test]
fn one_notification_message_with_two_blocks_is_one_batch_header() {
    let block = |task: &str, title: &str| ContentBlock::Text {
        text: format!(
            "<system-reminder>\n<task-notification>\n<task-id>{task}</task-id>\n<status>completed</status>\n<summary>Background command \"{title}\" completed (exit code 0)</summary>\n</task-notification>\n</system-reminder>"
        ),
    };
    let batch = Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("msg_n"),
        content: vec![block("b1", "First"), block("b2", "Second")],
        origin: UserOrigin::Meta {
            source: "task-notification".into(),
        },
    });
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_n"),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: batch.clone(),
    });
    let live = row_of(&feed.projection, "turnHeader", "turn_n");
    assert_eq!(live["origin"], "backgroundResult");
    assert_eq!(live["originMeta"]["title"], "First · Second");

    let projection = Projection::from_view(
        &view(vec![
            user("msg_u1", "start it"),
            assistant(
                "msg_a1",
                vec![ContentBlock::Text {
                    text: "started".into(),
                }],
            ),
            batch,
            assistant(
                "msg_a2",
                vec![ContentBlock::Text {
                    text: "consumed".into(),
                }],
            ),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    let cold: Vec<_> = projection
        .rows
        .iter()
        .filter(|row| row["kind"] == "turnHeader")
        .collect();
    assert_eq!(cold.len(), 2);
    assert_eq!(cold[1]["originMeta"]["title"], "First · Second");
}

fn agent_block(task: &str, call: &str, status: &str, summary: &str) -> ContentBlock {
    ContentBlock::Text {
        text: format!(
            "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n<task-notification>\n<task-id>{task}</task-id>\n<tool-use-id>{call}</tool-use-id>\n<output-file>/o/{task}</output-file>\n<status>{status}</status>\n<summary>{summary}</summary>\n</task-notification>\n</system-reminder>"
        ),
    }
}

fn notifications(id: &str, blocks: Vec<ContentBlock>) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new(id),
        content: blocks,
        origin: UserOrigin::Meta {
            source: "task-notification".into(),
        },
    })
}

fn agent_calls(ids: &[&str]) -> Message {
    assistant(
        "msg_a1",
        ids.iter()
            .map(|id| ContentBlock::ToolUse {
                id: ToolUseId::new(*id),
                name: "Agent".into(),
                input: json!({"description": id, "run_in_background": true}),
            })
            .collect(),
    )
}

/// Node `applyBackgroundTaskNotificationBlock`: in a merged batch each block settles its own Agent
/// card from the in-block status, not the launch acknowledgement's `success`.
#[test]
fn a_merged_notification_batch_settles_each_agent_card() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: agent_calls(&["call_1", "call_2", "call_3"]),
    });
    for id in ["call_1", "call_2", "call_3"] {
        feed.apply(KernelEvent::ToolDone {
            tool_use: ToolUseId::new(id),
            output: rust_cli_kernel_api::tool::ToolOutput {
                content: vec![ToolResultContent::Text {
                    text: "Async agent launched".into(),
                }],
                is_error: false,
                display: serde_json::Value::Null,
            },
        });
    }
    assert_eq!(
        row_of(&feed.projection, "toolCall", "call_1")["status"],
        "success"
    );
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_n"),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: notifications(
            "msg_n",
            vec![
                agent_block(
                    "a1",
                    "call_1",
                    "failed",
                    "Agent \"one\" failed: rate limited",
                ),
                agent_block("a2", "call_2", "completed", "Agent \"two\" finished"),
                agent_block("a3", "call_3", "killed", "Agent \"three\" was stopped"),
            ],
        ),
    });
    let failed = row_of(&feed.projection, "toolCall", "call_1");
    assert_eq!(failed["status"], "error");
    assert_eq!(
        failed["output"]["text"],
        "Agent \"one\" failed: rate limited"
    );
    assert_eq!(
        failed["error"],
        json!({"code": "fault.runtime.backgroundTaskFailed", "message": "Agent \"one\" failed: rate limited"})
    );
    let completed = row_of(&feed.projection, "toolCall", "call_2");
    assert_eq!(completed["status"], "success");
    assert!(completed.get("error").is_none());
    assert_eq!(
        row_of(&feed.projection, "toolCall", "call_3")["status"],
        "cancelled"
    );
}

/// One notification reads its status and error from `subagentResult`, and the cold read settles the
/// card the same way.
#[test]
fn a_single_failed_notification_settles_its_card_live_and_cold() {
    let failed = || {
        notifications(
            "msg_n",
            vec![agent_block(
                "a1",
                "call_1",
                "failed",
                "Agent \"one\" failed: provider &amp; quota",
            )],
        )
    };
    let projection = Projection::from_view(
        &view(vec![
            user("msg_u1", "start it"),
            agent_calls(&["call_1"]),
            Message::User(UserMessage {
                stall_execution: None,
                intent: None,
                id: MessageId::new("msg_r1"),
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: ToolUseId::new("call_1"),
                    content: vec![ToolResultContent::Text {
                        text: "Async agent launched".into(),
                    }],
                    is_error: false,
                }],
                origin: UserOrigin::ToolResult {
                    assistant: MessageId::new("msg_a1"),
                },
            }),
            failed(),
        ]),
        Followup::Queue,
        Vec::new(),
    );
    let row = row_of(&projection, "toolCall", "call_1");
    assert_eq!(row["status"], "error");
    assert_eq!(row["error"]["message"], "provider & quota");
    assert_eq!(
        row["output"]["text"],
        "Agent \"one\" failed: provider & quota"
    );
}
