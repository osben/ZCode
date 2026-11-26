//! Fork: the row fields `feedback` and `pinnedAt` and the target a mark command resolves to
//! (specs/fork-rust-feedback-and-pins.md), live and cold.

use rust_cli_kernel_api::ids::{CommandId, MessageId, TurnId};
use rust_cli_kernel_api::message::ContentBlock;
use rust_cli_kernel_api::message_mark::{Feedback, Mark, Marks};
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};
use serde_json::Value;

use super::{Feed, Followup, Projection, assistant, user, view};
use crate::projection::{MarkKind, TargetMiss};

fn text(text: &str) -> ContentBlock {
    ContentBlock::Text { text: text.into() }
}

fn marked(message: &str, mark: Mark) -> KernelEvent {
    KernelEvent::MessageMarked {
        message: MessageId::new(message),
        mark,
    }
}

/// A finished turn: the typed input `msg_u1` and the reply `msg_a1` of two text blocks.
fn finished_turn() -> Feed {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    feed.apply(KernelEvent::MessageDone {
        message: user("msg_u1", "hello"),
    });
    feed.apply(KernelEvent::MessageDone {
        message: assistant("msg_a1", vec![text("first"), text("second")]),
    });
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    feed
}

fn rows_of(projection: &Projection, kind: &str) -> Vec<serde_json::Map<String, Value>> {
    projection
        .rows
        .iter()
        .filter(|row| row["kind"] == kind)
        .cloned()
        .collect()
}

fn cold_with(marks: &[(&str, Marks)]) -> Projection {
    let mut view = view(vec![
        user("msg_u1", "hello"),
        assistant("msg_a1", vec![text("first"), text("second")]),
    ]);
    for (id, marks) in marks {
        view.marks.insert(MessageId::new(*id), *marks);
    }
    Projection::from_view(&view, Followup::Queue, Vec::new())
}

#[test]
fn a_stored_like_and_pin_show_on_a_cold_open() {
    let projection = cold_with(&[
        (
            "msg_a1",
            Marks {
                feedback: Some(Feedback::Like),
                pinned_at: Some(5_000),
            },
        ),
        (
            "msg_u1",
            Marks {
                feedback: None,
                pinned_at: Some(4_000),
            },
        ),
    ]);
    let texts = rows_of(&projection, "assistantText");
    assert_eq!(texts.len(), 2);
    // Feedback is on the last text row of the message, the pin on the first (Node `findLast` and `find`).
    assert!(texts[0].get("feedback").is_none());
    assert_eq!(texts[0]["pinnedAt"], 5_000);
    assert_eq!(texts[1]["feedback"], "like");
    assert!(texts[1].get("pinnedAt").is_none());
    let users = rows_of(&projection, "userInput");
    assert_eq!(users[0]["pinnedAt"], 4_000);
    assert!(users[0].get("feedback").is_none());
}

#[test]
fn a_session_without_marks_sends_neither_field() {
    let projection = cold_with(&[]);
    for row in &projection.rows {
        assert!(row.get("feedback").is_none() && row.get("pinnedAt").is_none());
    }
}

#[test]
fn a_dislike_reads_back_as_dislike() {
    let projection = cold_with(&[(
        "msg_a1",
        Marks {
            feedback: Some(Feedback::Dislike),
            pinned_at: None,
        },
    )]);
    assert_eq!(
        rows_of(&projection, "assistantText")[1]["feedback"],
        "dislike"
    );
}

#[test]
fn a_live_like_is_set_changed_and_cleared_as_row_deltas() {
    let mut feed = finished_turn();
    let like = feed.apply(marked("msg_a1", Mark::Feedback(Some(Feedback::Like))));
    let upserted: Vec<&Value> = like.iter().filter(|d| d["op"] == "row.upserted").collect();
    assert_eq!(upserted.len(), 1, "{like:?}");
    assert_eq!(upserted[0]["row"]["feedback"], "like");
    // The revision moves with the event, like every state change.
    assert!(like.iter().any(|d| d["op"] == "state.updated"));
    let change = feed.apply(marked("msg_a1", Mark::Feedback(Some(Feedback::Dislike))));
    assert_eq!(change[0]["row"]["feedback"], "dislike");
    // The same value again changes no row.
    let same = feed.apply(marked("msg_a1", Mark::Feedback(Some(Feedback::Dislike))));
    assert!(same.iter().all(|d| d["op"] != "row.upserted"), "{same:?}");
    let cleared = feed.apply(marked("msg_a1", Mark::Feedback(None)));
    assert!(cleared[0]["row"].get("feedback").is_none());
    assert!(
        rows_of(&feed.projection, "assistantText")
            .iter()
            .all(|row| row.get("feedback").is_none())
    );
}

#[test]
fn a_live_pin_and_unpin_move_pinned_at() {
    let mut feed = finished_turn();
    let pin = feed.apply(marked("msg_a1", Mark::Pinned(Some(7_000))));
    let row = &pin[0]["row"];
    assert_eq!(row["pinnedAt"], 7_000);
    assert_eq!(row["text"], "first");
    let pin_user = feed.apply(marked("msg_u1", Mark::Pinned(Some(7_500))));
    assert_eq!(pin_user[0]["row"]["kind"], "userInput");
    assert_eq!(pin_user[0]["row"]["pinnedAt"], 7_500);
    let unpin = feed.apply(marked("msg_a1", Mark::Pinned(None)));
    assert!(unpin[0]["row"].get("pinnedAt").is_none());
    // A mark on a message with no row changes nothing.
    let none = feed.apply(marked("msg_none", Mark::Pinned(Some(1))));
    assert!(none.iter().all(|d| d["op"] != "row.upserted"));
}

#[test]
fn a_rebuild_from_the_view_keeps_the_marks() {
    let mut feed = finished_turn();
    feed.apply(marked("msg_a1", Mark::Feedback(Some(Feedback::Like))));
    // The actor's view carries the map, so a rewind or a resubscribe snapshot draws the same rows.
    let rebuilt = cold_with(&[(
        "msg_a1",
        Marks {
            feedback: Some(Feedback::Like),
            pinned_at: None,
        },
    )]);
    assert_eq!(
        rows_of(&rebuilt, "assistantText")[1]["feedback"],
        rows_of(&feed.projection, "assistantText")[1]["feedback"]
    );
}

fn row_id(projection: &Projection, kind: &str, at: usize) -> (u64, String) {
    let row = &rows_of(projection, kind)[at];
    (
        row["rowId"].as_u64().unwrap(),
        row["entityId"].as_str().unwrap().to_owned(),
    )
}

#[test]
fn a_mark_command_resolves_to_the_stored_message() {
    let feed = finished_turn();
    let projection = &feed.projection;
    let (text_row, text_entity) = row_id(projection, "assistantText", 1);
    assert_eq!(
        projection.mark_target(text_row, &text_entity, MarkKind::Feedback),
        Ok("msg_a1".to_owned())
    );
    assert_eq!(
        projection.mark_target(text_row, &text_entity, MarkKind::Pin),
        Ok("msg_a1".to_owned())
    );
    let (user_row, user_entity) = row_id(projection, "userInput", 0);
    assert_eq!(
        projection.mark_target(user_row, &user_entity, MarkKind::Pin),
        Ok("msg_u1".to_owned())
    );
}

#[test]
fn a_mark_on_the_wrong_row_kind_is_unavailable() {
    let feed = finished_turn();
    let projection = &feed.projection;
    // A typed input takes a pin but not a like.
    let (user_row, user_entity) = row_id(projection, "userInput", 0);
    assert_eq!(
        projection.mark_target(user_row, &user_entity, MarkKind::Feedback),
        Err(TargetMiss::Unavailable)
    );
    // A turn header takes neither.
    let (header_row, header_entity) = row_id(projection, "turnHeader", 0);
    for kind in [MarkKind::Feedback, MarkKind::Pin] {
        assert_eq!(
            projection.mark_target(header_row, &header_entity, kind),
            Err(TargetMiss::Unavailable)
        );
    }
}

#[test]
fn a_missing_row_or_another_entity_is_stale() {
    let feed = finished_turn();
    let projection = &feed.projection;
    let (text_row, _) = row_id(projection, "assistantText", 1);
    assert_eq!(
        projection.mark_target(999_999, "x", MarkKind::Pin),
        Err(TargetMiss::Stale)
    );
    assert_eq!(
        projection.mark_target(text_row, "other", MarkKind::Feedback),
        Err(TargetMiss::Stale)
    );
}

#[test]
fn a_reply_still_streaming_cannot_be_pinned() {
    use rust_cli_kernel_api::model::BlockDelta;
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(KernelEvent::MessageDone {
        message: user("msg_u1", "hello"),
    });
    feed.apply(KernelEvent::StreamDelta {
        turn: TurnId::new("turn_1"),
        response: 0,
        index: 0,
        delta: BlockDelta::Text("typing".into()),
    });
    let (row, entity) = row_id(&feed.projection, "assistantText", 0);
    // The row has no stored message yet: neither mark can address it.
    for kind in [MarkKind::Feedback, MarkKind::Pin] {
        assert_eq!(
            feed.projection.mark_target(row, &entity, kind),
            Err(TargetMiss::Unavailable)
        );
    }
}
