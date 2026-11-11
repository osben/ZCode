//! Fork: the fork child's divider (Node `onSessionForked`; specs/fork-rust-agent-parity.md).

use rust_cli_kernel_api::message::AttachmentMessage;
use rust_cli_kernel_api::store::SessionKind;

use super::*;

fn notice(data: Value) -> Message {
    Message::Attachment(AttachmentMessage {
        id: MessageId::new("msg_notice"),
        source: "fork".into(),
        text: "<system-reminder>This session was forked.</system-reminder>".into(),
        data,
    })
}

fn forks(projection: &Projection) -> Vec<&Map<String, Value>> {
    projection
        .rows
        .iter()
        .filter(|row| row["kind"] == "timelineMarker" && row["marker"]["type"] == "forkNotice")
        .collect()
}

/// A forked session shows one divider in its latest copied turn, keyed and shaped like Node's.
#[test]
fn a_fork_child_shows_the_fork_divider() {
    let mut child = view(vec![
        user("msg_u1", "one"),
        assistant("msg_a1", vec![ContentBlock::Text { text: "a".into() }]),
        notice(
            json!({"kind": "session_fork", "parentSessionId": "ses_parent", "targetMessageId": "msg_a1"}),
        ),
    ]);
    child.meta.kind = SessionKind::Fork;
    child.meta.parent = Some(SessionId::new("ses_parent"));
    let projection = Projection::from_view(&child, Followup::Queue, Vec::new());
    let found = forks(&projection);
    assert_eq!(found.len(), 1);
    let row = found[0];
    assert_eq!(row["entityId"], "fork:ses_parent:msg_a1");
    assert_eq!(row["lane"], "turnTailBoundary");
    assert_eq!(
        row["marker"],
        json!({"type": "forkNotice", "parentSessionId": "ses_parent", "parentRowId": 0})
    );
    let header = projection
        .rows
        .iter()
        .find(|row| row["kind"] == "turnHeader")
        .expect("turn header");
    assert_eq!(row["turnId"], header["turnId"]);

    // A notice without a stored context falls back to the session's parent.
    let mut bare = view(vec![user("msg_u1", "one"), notice(Value::Null)]);
    bare.meta.kind = SessionKind::Fork;
    bare.meta.parent = Some(SessionId::new("ses_parent"));
    let projection = Projection::from_view(&bare, Followup::Queue, Vec::new());
    assert_eq!(forks(&projection)[0]["entityId"], "fork:ses_parent:unknown");

    // Without a parent there is nothing to link to.
    let orphan = view(vec![user("msg_u1", "one"), notice(Value::Null)]);
    let projection = Projection::from_view(&orphan, Followup::Queue, Vec::new());
    assert!(forks(&projection).is_empty());
}
