//! Fork: a steer absorbed into the running turn is a guided user row (Node's drained guide row), live and cold.

use rust_cli_kernel_api::hooks::{SteerSender, queued_command};
use rust_cli_kernel_api::ids::{CommandId, MessageId, ToolUseId, TurnId};
use rust_cli_kernel_api::message::{
    AttachmentMessage, ContentBlock, Message, ToolResultContent, UserMessage, UserOrigin,
};
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};
use serde_json::{Map, Value, json};

use super::{Feed, Followup, Projection, RowAction, assistant, user, view};

fn history(steer: AttachmentMessage) -> Vec<Message> {
    vec![
        user("msg_u1", "plan it"),
        assistant(
            "msg_a1",
            vec![ContentBlock::ToolUse {
                id: ToolUseId::new("toolu_exit"),
                name: "ExitPlanMode".into(),
                input: json!({"plan": "p"}),
            }],
        ),
        Message::User(UserMessage {
            intent: None,
            id: MessageId::new("msg_r1"),
            content: vec![ContentBlock::ToolResult {
                tool_use_id: ToolUseId::new("toolu_exit"),
                content: vec![ToolResultContent::Text {
                    text: "The plan was not approved by the user.".into(),
                }],
                is_error: true,
            }],
            origin: UserOrigin::ToolResult {
                assistant: MessageId::new("msg_a1"),
            },
        }),
        Message::Attachment(steer),
        assistant(
            "msg_a2",
            vec![ContentBlock::Text {
                text: "revised".into(),
            }],
        ),
    ]
}

fn feedback() -> AttachmentMessage {
    queued_command::steer_attachment(
        MessageId::new("msg_s1"),
        "add tests",
        SteerSender::User,
        None,
        Some(queued_command::PLAN_APPROVAL_FEEDBACK),
    )
}

fn live(messages: Vec<Message>) -> Projection {
    let mut feed = Feed::new();
    let turn = TurnId::new("turn_1");
    feed.apply(KernelEvent::TurnStarted {
        turn: turn.clone(),
        command: Some(CommandId::new("c1")),
    });
    for message in messages {
        feed.apply(KernelEvent::MessageDone { message });
    }
    feed.apply(KernelEvent::TurnFinished {
        turn,
        outcome: TurnOutcome::Success,
        usage: None,
    });
    feed.projection
}

fn cold(messages: Vec<Message>) -> Projection {
    Projection::from_view(&view(messages), Followup::Queue, Vec::new())
}

fn kind_rows<'a>(projection: &'a Projection, kind: &str) -> Vec<&'a Map<String, Value>> {
    projection
        .rows
        .iter()
        .filter(|row| row["kind"] == kind)
        .collect()
}

/// The fields Node's drained guide row carries (times and row ids differ between live and cold).
fn guided_fields(projection: &Projection) -> Value {
    let rows = kind_rows(projection, "userInput");
    let [prompt, steer] = rows.as_slice() else {
        panic!("two user rows: {rows:?}");
    };
    assert_eq!(prompt["turnId"], steer["turnId"], "one turn");
    assert!(prompt.get("guided").is_none());
    let mut fields = json!({
        "text": steer["text"],
        "origin": steer["origin"],
        "guided": steer["guided"],
        "sourceCommandId": steer["sourceCommandId"],
        "rootSourceCommandId": steer["rootSourceCommandId"],
    });
    if let Some(quotes) = steer.get("conversationQuotes") {
        fields["conversationQuotes"] = quotes.clone();
    }
    fields
}

#[test]
fn plan_feedback_is_a_guided_row_of_the_running_turn_live_and_cold() {
    let expected = json!({
        "text": "add tests",
        "origin": "realUser",
        "guided": true,
        "sourceCommandId": "msg_s1",
        "rootSourceCommandId": "msg_s1",
    });
    for projection in [live(history(feedback())), cold(history(feedback()))] {
        assert_eq!(kind_rows(&projection, "turnHeader").len(), 1);
        assert_eq!(guided_fields(&projection), expected);
    }
}

#[test]
fn a_typed_steer_row_carries_its_command() {
    let steer = queued_command::steer_attachment(
        MessageId::new("msg_s2"),
        "also b",
        SteerSender::User,
        Some("c2"),
        None,
    );
    for projection in [live(history(steer.clone())), cold(history(steer))] {
        let fields = guided_fields(&projection);
        assert_eq!(fields["text"], "also b");
        assert_eq!(fields["sourceCommandId"], "c2");
        assert_eq!(fields["rootSourceCommandId"], "c2");
    }
}

/// Fork: a quoted steer shows its typed text and quotes from the intent it carries; its prompt is the composed text.
#[test]
fn a_quoted_steer_row_reads_its_intent() {
    let intent: rust_cli_kernel_api::input_intent::InputIntent = serde_json::from_value(
        serde_json::json!({"text": "also b", "conversationQuotes": [{"text": "q"}]}),
    )
    .unwrap();
    let mut steer = queued_command::steer_attachment(
        MessageId::new("msg_s4"),
        &intent.compose("also b"),
        SteerSender::User,
        Some("c2"),
        None,
    );
    steer.data[queued_command::INTENT_KEY] = serde_json::to_value(&intent).unwrap();
    for projection in [live(history(steer.clone())), cold(history(steer))] {
        let fields = guided_fields(&projection);
        assert_eq!(fields["text"], "also b");
        assert_eq!(
            fields["conversationQuotes"],
            serde_json::json!([{"text": "q"}])
        );
    }
}

/// Steers stored before the keys existed, and coordinator steers, keep showing no row.
#[test]
fn a_steer_without_a_command_or_source_shows_no_row() {
    let steer = queued_command::steer_attachment(
        MessageId::new("msg_s3"),
        "check the logs",
        SteerSender::Coordinator,
        None,
        None,
    );
    for projection in [live(history(steer.clone())), cold(history(steer))] {
        assert_eq!(kind_rows(&projection, "userInput").len(), 1);
        assert_eq!(kind_rows(&projection, "turnHeader").len(), 1);
    }
}

/// Node offers Edit only on a latest real-user row with an edit target; a guided row has none on Rust, so no
/// row offers Edit (Node's no-target path), and the reply can still be retried from the typed input.
#[test]
fn a_latest_guided_row_offers_edit_and_the_reply_keeps_retry() {
    for projection in [live(history(feedback())), cold(history(feedback()))] {
        let editable: Vec<_> = projection
            .rows
            .iter()
            .filter(|row| row.get("actions").and_then(|a| a.get("canEdit")) == Some(&json!(true)))
            .collect();
        assert_eq!(editable.len(), 1, "{:?}", projection.rows);
        let guided = editable[0];
        assert_eq!(guided["guided"], true);
        assert_eq!(guided["actions"]["editDisposition"], "rewind");
        // The edit targets the guided steer itself, not the turn's typed input.
        let entity = guided["entityId"].as_str().unwrap();
        let target = projection
            .row_target(guided["rowId"].as_u64().unwrap(), entity, RowAction::Edit)
            .unwrap();
        assert_eq!(target.user_message, entity);
        let replies = kind_rows(&projection, "assistantText");
        let last = replies.last().expect("a reply");
        assert_eq!(last["actions"]["canRetry"], true);
    }
}
