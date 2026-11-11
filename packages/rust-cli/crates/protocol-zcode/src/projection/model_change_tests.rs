//! Fork: the model switch divider (Node `onTurnStarted` `lastTurnModel`; specs/fork-rust-agent-parity.md).

use rust_cli_kernel_api::model::ModelSelection;

use super::*;

fn markers(deltas: &[Value]) -> Vec<&Value> {
    deltas
        .iter()
        .filter(|delta| delta["op"] == "row.appended")
        .map(|delta| &delta["row"])
        .filter(|row| row["kind"] == "timelineMarker" && row["marker"]["type"] == "modelChange")
        .collect()
}

fn turn(feed: &mut Feed, id: &str) -> Vec<Value> {
    let started = feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new(id),
        command: None,
    });
    feed.apply(KernelEvent::TurnFinished {
        turn: TurnId::new(id),
        outcome: TurnOutcome::Success,
        usage: None,
    });
    started
}

fn select(feed: &mut Feed, provider: &str, model: &str, reasoning: Option<&str>) {
    let mut selection = ModelSelection::new(provider.to_owned(), model.to_owned());
    selection.reasoning = reasoning.map(str::to_owned);
    feed.apply(KernelEvent::ModelChanged { selection });
}

/// The first turn draws nothing; a turn on another model draws one divider before its header.
#[test]
fn a_turn_on_another_model_starts_with_a_model_change_marker() {
    let mut feed = Feed::new();
    select(&mut feed, "fixture", "other", None);
    assert!(markers(&turn(&mut feed, "turn_1")).is_empty());
    select(&mut feed, "upstream", "pro", Some("high"));
    let started = turn(&mut feed, "turn_2");
    let found = markers(&started);
    assert_eq!(found.len(), 1);
    let row = found[0];
    assert_eq!(row["lane"], "lightBoundary");
    assert_eq!(row["turnId"], "turn_2");
    assert_eq!(
        row["entityId"],
        "model-change:turn_2:fixture/other->upstream/pro"
    );
    assert_eq!(
        row["marker"],
        json!({
            "type": "modelChange",
            "fromProvider": "fixture",
            "fromModel": "other",
            "toProvider": "upstream",
            "toModel": "pro",
            "toThought": "high",
        })
    );
    let appended: Vec<&str> = started
        .iter()
        .filter(|delta| delta["op"] == "row.appended")
        .map(|delta| delta["row"]["kind"].as_str().unwrap_or_default())
        .collect();
    assert_eq!(&appended[..2], &["timelineMarker", "turnHeader"][..]);
    // The same model again draws nothing.
    assert!(markers(&turn(&mut feed, "turn_3")).is_empty());
}

/// A reasoning change alone is not a switch, and choosing a model between turns draws nothing until the next turn.
#[test]
fn a_reasoning_change_or_a_bare_selection_draws_no_marker() {
    let mut feed = Feed::new();
    turn(&mut feed, "turn_1");
    select(&mut feed, "fixture", "scripted", Some("high"));
    assert!(markers(&turn(&mut feed, "turn_2")).is_empty());
    let selection = ModelSelection::new("fixture".to_owned(), "pro".to_owned());
    let chosen = feed.apply(KernelEvent::ModelChanged { selection });
    assert!(markers(&chosen).is_empty());
}

/// A cold projection without stored models (older Rust sessions) takes the current model as the previous one, so the
/// first turn after reopening on another model draws the divider.
#[test]
fn a_cold_projection_without_stored_models_seeds_the_current_one() {
    let cold = view(vec![
        user("msg_u1", "hi"),
        assistant(
            "msg_a1",
            vec![ContentBlock::Text {
                text: "hello".into(),
            }],
        ),
    ]);
    let mut feed = Feed::new();
    feed.projection = Projection::from_view(&cold, Followup::Queue, vec!["high".into()]);
    assert!(
        feed.projection
            .rows
            .iter()
            .all(|row| row["kind"] != "timelineMarker")
    );
    select(&mut feed, "fixture", "pro", None);
    let found = turn(&mut feed, "turn_2");
    let found = markers(&found);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["marker"]["fromModel"], "scripted");
    assert_eq!(found[0]["marker"]["toModel"], "pro");
}

fn stored(provider: &str, model: &str) -> ModelSelection {
    ModelSelection::new(provider.to_owned(), model.to_owned())
}

/// A cold projection draws the stored switches between turns (Node's cold resume), and a switch made before closing
/// draws the divider on the first turn after reopening.
#[test]
fn a_cold_projection_draws_stored_switches() {
    let mut cold = view(vec![
        user("msg_u1", "one"),
        assistant("msg_a1", vec![ContentBlock::Text { text: "a".into() }]),
        user("msg_u2", "two"),
        assistant("msg_a2", vec![ContentBlock::Text { text: "b".into() }]),
        user("msg_u3", "three"),
        assistant("msg_a3", vec![ContentBlock::Text { text: "c".into() }]),
    ]);
    cold.message_models = [
        (MessageId::new("msg_a1"), stored("upstream", "flash")),
        (MessageId::new("msg_a2"), stored("upstream", "pro")),
        (MessageId::new("msg_a3"), stored("upstream", "pro")),
    ]
    .into_iter()
    .collect();
    // The session's current selection (`fixture/scripted`) was chosen after the last turn.
    let mut feed = Feed::new();
    feed.projection = Projection::from_view(&cold, Followup::Queue, vec!["high".into()]);
    let drawn: Vec<_> = feed
        .projection
        .rows
        .iter()
        .filter(|row| row["kind"] == "timelineMarker" && row["marker"]["type"] == "modelChange")
        .collect();
    assert_eq!(drawn.len(), 1);
    assert_eq!(drawn[0]["turnId"], "msg_u2:turn:2");
    assert_eq!(drawn[0]["marker"]["fromModel"], "flash");
    assert_eq!(drawn[0]["marker"]["toModel"], "pro");
    let started = turn(&mut feed, "turn_4");
    let found = markers(&started);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0]["marker"]["fromProvider"], "upstream");
    assert_eq!(found[0]["marker"]["fromModel"], "pro");
    assert_eq!(found[0]["marker"]["toModel"], "scripted");
}

/// A subagent child's first turn starts with the source-less "Using <model>" marker (Node's
/// `previousModelSelection: null` at the spawn), live and cold; later turns draw only real switches.
#[test]
fn a_subagent_child_starts_with_a_source_less_model_marker() {
    let mut child = view(Vec::new());
    child.meta.kind = rust_cli_kernel_api::store::SessionKind::Subagent;
    let mut feed = Feed::new();
    feed.projection = Projection::from_view(&child, Followup::Queue, Vec::new());
    let started = turn(&mut feed, "turn_1");
    let found = markers(&started);
    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0]["entityId"],
        "model-initial:turn_1:fixture/scripted"
    );
    assert_eq!(found[0]["lane"], "lightBoundary");
    assert_eq!(
        found[0]["marker"],
        json!({"type": "modelChange", "toProvider": "fixture", "toModel": "scripted", "toThought": ""})
    );
    assert!(markers(&turn(&mut feed, "turn_2")).is_empty());

    let mut cold = view(vec![
        user("msg_u1", "one"),
        assistant("msg_a1", vec![ContentBlock::Text { text: "a".into() }]),
        user("msg_u2", "two"),
        assistant("msg_a2", vec![ContentBlock::Text { text: "b".into() }]),
    ]);
    cold.meta.kind = rust_cli_kernel_api::store::SessionKind::Subagent;
    cold.message_models = [
        (MessageId::new("msg_a1"), stored("upstream", "flash")),
        (MessageId::new("msg_a2"), stored("upstream", "flash")),
    ]
    .into_iter()
    .collect();
    let projection = Projection::from_view(&cold, Followup::Queue, Vec::new());
    let drawn: Vec<_> = projection
        .rows
        .iter()
        .filter(|row| row["kind"] == "timelineMarker" && row["marker"]["type"] == "modelChange")
        .collect();
    assert_eq!(drawn.len(), 1);
    assert!(drawn[0]["marker"].get("fromModel").is_none());
    assert_eq!(drawn[0]["marker"]["toModel"], "flash");

    // A regular session's first turn stays silent.
    let mut feed = Feed::new();
    assert!(markers(&turn(&mut feed, "turn_1")).is_empty());
}
