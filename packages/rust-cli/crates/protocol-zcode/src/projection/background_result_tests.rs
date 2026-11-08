//! Fork: the background result turn header (projection/background_result.rs).

use rust_cli_kernel_api::ids::{MessageId, TurnId};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::session_api::KernelEvent;
use serde_json::json;

use super::super::background_result::origin_meta;
use super::{Feed, Followup, Projection, assistant, row_of, user, view};

fn notification(id: &str, task: &str, summary: &str) -> Message {
    Message::User(UserMessage {
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
        json!({"backgroundSource": "subagent", "workId": "agent_1", "title": "Check background"})
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
