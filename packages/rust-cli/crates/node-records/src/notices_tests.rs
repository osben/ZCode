//! Fork: reading Node's background notification messages back.

use rust_cli_kernel_api::message::{ContentBlock, Message, UserOrigin};
use serde_json::json;

use crate::row::WithParts;

/// A Node-written notification batch (no `rustCli` marker, bare envelopes) is one notification
/// message with a wrapped text block per envelope, so the cold projection opens its turn.
#[test]
fn a_node_background_notification_is_read_as_a_notification() {
    let envelope = |id: &str| {
        format!(
            "<task-notification>\n<task-id>{id}</task-id>\n<status>completed</status>\n</task-notification>\n"
        )
    };
    let record = WithParts {
        info: json!({"id": "msg_n", "role": "user", "source": "background_task",
            "metadata": {"source": "background_task", "inputPresentation": "task_notification"}}),
        parts: vec![
            json!({"type": "text", "text": envelope("agent_1"), "synthetic": true}),
            json!({"type": "text", "text": envelope("agent_2"), "synthetic": true}),
        ],
    };
    let Some(Message::User(user)) = super::hydrate(&record) else {
        panic!("not read back");
    };
    assert_eq!(
        user.origin,
        UserOrigin::Meta {
            source: rust_cli_kernel_api::hooks::queued_command::TASK_NOTIFICATION.into()
        }
    );
    let texts: Vec<&str> = user
        .content
        .iter()
        .map(|block| match block {
            ContentBlock::Text { text } => text.as_str(),
            _ => "",
        })
        .collect();
    assert_eq!(texts.len(), 2);
    assert_eq!(
        texts[0],
        rust_cli_prompts::agents::notification_wrap(envelope("agent_1").trim_end())
    );
    assert!(texts[1].contains("<task-id>agent_2</task-id>"));
    assert!(
        texts[1].ends_with("</task-notification>\n</system-reminder>"),
        "{}",
        texts[1]
    );
}
