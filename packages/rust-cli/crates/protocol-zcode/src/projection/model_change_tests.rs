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

/// A cold projection draws no past switches but remembers the current model, so the first turn after reopening on
/// another model draws the divider.
#[test]
fn a_cold_projection_seeds_the_previous_model() {
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
