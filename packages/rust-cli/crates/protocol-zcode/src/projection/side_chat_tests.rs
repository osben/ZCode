//! Fork: a selection side chat's pane starts after its boundary reminder (specs/fork-rust-selection-side-chat.md).

use rust_cli_kernel_api::message::AttachmentMessage;
use rust_cli_kernel_api::store::{SELECTION_SIDE_CHAT_SOURCE, SessionKind};

use super::*;

fn boundary() -> Message {
    Message::Attachment(AttachmentMessage {
        id: MessageId::new("msg_boundary"),
        source: SELECTION_SIDE_CHAT_SOURCE.into(),
        text: "<system-reminder>inherited for reference only</system-reminder>".into(),
        data: Value::Null,
    })
}

fn texts(projection: &Projection) -> Vec<String> {
    projection
        .rows
        .iter()
        .filter(|row| row["kind"] == "userInput")
        .map(|row| row["text"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// The inherited turns are the model's context only: the cold pane shows the side chat's own turns, and no fork divider.
#[test]
fn a_side_chat_pane_starts_after_the_boundary() {
    let mut child = view(vec![
        user("msg_u1", "inherited question"),
        assistant(
            "msg_a1",
            vec![ContentBlock::Text {
                text: "inherited answer".into(),
            }],
        ),
        boundary(),
        user("msg_u2", "side question"),
        assistant(
            "msg_a2",
            vec![ContentBlock::Text {
                text: "side answer".into(),
            }],
        ),
    ]);
    child.meta.kind = SessionKind::Fork;
    child.meta.parent = Some(SessionId::new("ses_parent"));
    let projection = Projection::from_view(&child, Followup::Queue, Vec::new());
    assert_eq!(texts(&projection), ["side question"]);
    assert!(
        projection
            .rows
            .iter()
            .all(|row| row["kind"] != "timelineMarker")
    );
}

/// An empty side chat (a boundary only) is a blank pane, and a session without a boundary shows all it has.
#[test]
fn only_a_boundary_hides_history() {
    let blank = view(vec![user("msg_u1", "inherited"), boundary()]);
    assert!(texts(&Projection::from_view(&blank, Followup::Queue, Vec::new())).is_empty());
    let plain = view(vec![user("msg_u1", "kept")]);
    assert_eq!(
        texts(&Projection::from_view(&plain, Followup::Queue, Vec::new())),
        ["kept"]
    );
}

/// A side chat opened from a side chat inherits both boundaries: its pane starts after the last one.
#[test]
fn a_nested_side_chat_starts_after_its_own_boundary() {
    let mut inner = boundary();
    if let Message::Attachment(attachment) = &mut inner {
        attachment.id = MessageId::new("msg_boundary_2");
    }
    let child = view(vec![
        user("msg_u1", "parent question"),
        boundary(),
        user("msg_u2", "first side question"),
        inner,
        user("msg_u3", "nested side question"),
    ]);
    assert_eq!(
        texts(&Projection::from_view(&child, Followup::Queue, Vec::new())),
        ["nested side question"]
    );
}
