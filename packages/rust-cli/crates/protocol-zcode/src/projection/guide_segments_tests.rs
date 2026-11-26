//! Fork (specs/fork-rust-guide-work-segments.md): guided steers split the turn header into work segments.

use rust_cli_kernel_api::hooks::{SteerSender, queued_command};
use rust_cli_kernel_api::ids::{CommandId, MessageId, TurnId};
use rust_cli_kernel_api::message::{ContentBlock, Message};
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};
use serde_json::{Value, json};

use super::{Feed, Followup, Projection, assistant, user, view};

fn steer(id: &str) -> Message {
    Message::Attachment(queued_command::steer_attachment(
        MessageId::new(id),
        "also this",
        SteerSender::User,
        Some("c2"),
        None,
    ))
}

fn text(id: &str) -> Message {
    assistant(id, vec![ContentBlock::Text { text: "ok".into() }])
}

fn start(feed: &mut Feed) {
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: Some(CommandId::new("c1")),
    });
    feed.apply(KernelEvent::MessageDone {
        message: user("msg_u1", "go"),
    });
}

/// The row deltas of a stored message (state patches left out).
fn done(feed: &mut Feed, message: Message) -> Vec<Value> {
    let mut deltas = feed.apply(KernelEvent::MessageDone { message });
    deltas.retain(|delta| delta.get("row").is_some());
    deltas
}

fn finish(feed: &mut Feed) -> Vec<Value> {
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome: TurnOutcome::Success,
        usage: None,
    })
}

fn header(projection: &Projection) -> &serde_json::Map<String, Value> {
    projection
        .rows
        .iter()
        .find(|row| row["kind"] == "turnHeader")
        .expect("a header")
}

fn segment_ids(projection: &Projection) -> Vec<String> {
    header(projection)["workSegments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["segmentId"].as_str().unwrap().to_owned())
        .collect()
}

/// Feed times are `2000 + seq`: TurnStarted 2001, user 2002, then one per event.
#[test]
fn one_guide_gives_two_segments_with_the_steer_as_trigger() {
    let mut feed = Feed::new();
    start(&mut feed);
    done(&mut feed, text("msg_a1"));
    let deltas = done(&mut feed, steer("msg_s1"));
    // The header update goes out before the steer row, as in Node.
    assert_eq!(deltas[0]["row"]["kind"], "turnHeader");
    assert_eq!(deltas[1]["row"]["kind"], "userInput");
    assert_eq!(
        deltas[0]["row"]["workSegments"],
        json!([
            {"segmentId": "turn_1:initial", "startedAt": 2001, "endedAt": 2004, "activeMs": 3},
            {"segmentId": "msg_s1", "triggerEntityId": "msg_s1", "startedAt": 2004},
        ])
    );
    done(&mut feed, text("msg_a2"));
    finish(&mut feed);
    assert_eq!(
        header(&feed.projection)["workSegments"],
        json!([
            {"segmentId": "turn_1:initial", "startedAt": 2001, "endedAt": 2004, "activeMs": 3},
            {"segmentId": "msg_s1", "triggerEntityId": "msg_s1", "startedAt": 2004,
                "endedAt": 2006, "activeMs": 2},
        ])
    );
}

#[test]
fn two_guides_with_a_model_step_between_give_three_segments() {
    let mut feed = Feed::new();
    start(&mut feed);
    done(&mut feed, steer("msg_s1"));
    done(&mut feed, text("msg_a1"));
    done(&mut feed, steer("msg_s2"));
    done(&mut feed, text("msg_a2"));
    finish(&mut feed);
    assert_eq!(
        segment_ids(&feed.projection),
        ["turn_1:initial", "msg_s1", "msg_s2"]
    );
    let segments = header(&feed.projection)["workSegments"].as_array().unwrap();
    assert_eq!(segments[1]["endedAt"], segments[2]["startedAt"]);
    assert!(segments.iter().all(|s| s["activeMs"].is_u64()));
    assert_eq!(segments[2]["endedAt"], header(&feed.projection)["endedAt"]);
}

#[test]
fn guides_drained_at_one_boundary_share_one_segment() {
    let mut feed = Feed::new();
    start(&mut feed);
    done(&mut feed, steer("msg_s1"));
    let second = done(&mut feed, steer("msg_s2"));
    // The second steer appends its row and leaves the header alone.
    assert!(second.iter().any(|d| d["op"] == "row.appended"));
    assert!(second.iter().all(|d| d["row"]["kind"] != "turnHeader"));
    assert_eq!(segment_ids(&feed.projection), ["turn_1:initial", "msg_s1"]);
}

#[test]
fn a_streamed_reply_between_guides_opens_a_new_segment() {
    let mut feed = Feed::new();
    start(&mut feed);
    done(&mut feed, steer("msg_s1"));
    feed.apply(KernelEvent::StreamDelta {
        turn: TurnId::new("turn_1"),
        response: 1,
        index: 0,
        delta: rust_cli_kernel_api::model::BlockDelta::Text("hi".into()),
    });
    done(&mut feed, steer("msg_s2"));
    assert_eq!(segment_ids(&feed.projection).len(), 3);
}

/// Node writes `workSegments` only once a guide opened one, so the field is absent (not empty) otherwise.
#[test]
fn a_turn_without_a_guide_has_no_segments() {
    let mut feed = Feed::new();
    start(&mut feed);
    done(&mut feed, text("msg_a1"));
    finish(&mut feed);
    assert!(header(&feed.projection).get("workSegments").is_none());
}

#[test]
fn a_control_only_turn_keeps_no_segments() {
    let mut feed = Feed::new();
    feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    });
    feed.apply(KernelEvent::TurnControlOnly {
        turn: TurnId::new("turn_1"),
    });
    done(&mut feed, steer("msg_s1"));
    assert!(header(&feed.projection).get("workSegments").is_none());
}

#[test]
fn a_duplicate_steer_message_opens_no_second_segment() {
    let mut feed = Feed::new();
    start(&mut feed);
    done(&mut feed, steer("msg_s1"));
    done(&mut feed, text("msg_a1"));
    let again = done(&mut feed, steer("msg_s1"));
    assert!(again.is_empty());
    assert_eq!(segment_ids(&feed.projection).len(), 2);
}

#[test]
fn the_snapshot_header_matches_the_delta_header() {
    let mut feed = Feed::new();
    start(&mut feed);
    done(&mut feed, steer("msg_s1"));
    let last = done(&mut feed, text("msg_a1"));
    assert!(last.iter().all(|d| d["row"]["kind"] != "turnHeader"));
    let finished = finish(&mut feed);
    let upserted = finished
        .iter()
        .find(|d| d["op"] == "row.upserted" && d["row"]["kind"] == "turnHeader")
        .expect("the closing header");
    let snapshot = feed.projection.snapshot(feed.seq, "e");
    let window = snapshot["rows"]["window"].as_array().unwrap();
    let in_snapshot = window.iter().find(|r| r["kind"] == "turnHeader").unwrap();
    assert_eq!(upserted["row"]["workSegments"], in_snapshot["workSegments"]);
    assert_eq!(in_snapshot["workSegments"][1]["triggerEntityId"], "msg_s1");
}

/// A cold read replays the stored steer through the same path; it has no per-message time, so every segment sits at the
/// session's creation time (divergence in the spec).
#[test]
fn a_cold_read_restores_the_segments() {
    let messages = vec![
        user("msg_u1", "go"),
        text("msg_a1"),
        steer("msg_s1"),
        text("msg_a2"),
        steer("msg_s2"),
        text("msg_a3"),
    ];
    let projection = Projection::from_view(&view(messages), Followup::Queue, Vec::new());
    assert_eq!(
        segment_ids(&projection),
        ["msg_u1:turn:1:initial", "msg_s1", "msg_s2"]
    );
    let segments = header(&projection)["workSegments"].as_array().unwrap();
    assert_eq!(segments[1]["triggerEntityId"], "msg_s1");
    assert!(
        segments
            .iter()
            .all(|s| s["endedAt"] == 1000 && s["activeMs"] == 0)
    );
}

#[test]
fn a_cold_turn_without_a_guide_has_no_segments() {
    let messages = vec![user("msg_u1", "go"), text("msg_a1")];
    let projection = Projection::from_view(&view(messages), Followup::Queue, Vec::new());
    assert!(header(&projection).get("workSegments").is_none());
}
