//! Fork: the ACP context-reset divider and stall status (specs/fork-rust-agent-parity.md "ACP external agents",
//! rule 14; Node `onSystemMessage` / `onExternalAgentStatus`).
use rust_cli_kernel_api::ids::TurnId;
use rust_cli_kernel_api::orchestration::ExternalAgentStatus;
use rust_cli_kernel_api::session_api::{KernelEvent, TurnOutcome};
use serde_json::{Value, json};

use super::Feed;

fn started() -> KernelEvent {
    KernelEvent::TurnStarted {
        turn: TurnId::new("turn_1"),
        command: None,
    }
}

fn finished(outcome: TurnOutcome) -> KernelEvent {
    KernelEvent::TurnFinished {
        turn: TurnId::new("turn_1"),
        outcome,
        usage: None,
    }
}

fn reset() -> KernelEvent {
    KernelEvent::ExternalAgentContextReset {
        agent: "mock".into(),
    }
}

fn status(status: ExternalAgentStatus) -> KernelEvent {
    KernelEvent::ExternalAgentStatus {
        agent: "mock".into(),
        status,
    }
}

const STALLED: ExternalAgentStatus = ExternalAgentStatus::Stalled { silent_ms: 120_000 };

/// The `control.externalAgentStall` values the deltas patch, in order (`Value::Null` for a clear).
fn stall_patches(deltas: &[Value]) -> Vec<Value> {
    deltas
        .iter()
        .filter(|delta| delta["op"] == "state.updated")
        .filter_map(|delta| {
            delta["patch"]
                .get("control")?
                .get("externalAgentStall")
                .cloned()
        })
        .collect()
}

/// The deltas besides the revision count every state-changing event bumps.
fn effects(deltas: Vec<Value>) -> Vec<Value> {
    deltas
        .into_iter()
        .filter(|delta| {
            delta["op"] != "state.updated"
                || delta["patch"]
                    .as_object()
                    .is_some_and(|patch| patch.keys().any(|key| key != "revision"))
        })
        .collect()
}

fn markers(feed: &Feed) -> Vec<Value> {
    feed.projection
        .rows
        .iter()
        .filter(|row| row["kind"] == "timelineMarker")
        .map(|row| json!({"lane": row["lane"], "marker": row["marker"], "turnId": row["turnId"]}))
        .collect()
}

/// A reset during a turn appends one `agentContextReset` divider in lane `lightBoundary`, in that turn.
#[test]
fn a_context_reset_is_a_divider_in_its_turn() {
    let mut feed = Feed::new();
    feed.apply(started());
    let turn = feed
        .projection
        .rows
        .iter()
        .find(|row| row["kind"] == "turnHeader")
        .map(|row| row["turnId"].clone())
        .expect("turn header");
    let deltas = feed.apply(reset());
    assert_eq!(
        deltas
            .iter()
            .filter(|delta| delta["op"] == "row.appended")
            .count(),
        1,
        "{deltas:?}"
    );
    assert_eq!(
        markers(&feed),
        vec![json!({
            "lane": "lightBoundary",
            "marker": {"type": "agentContextReset", "agentId": "mock"},
            "turnId": turn,
        })]
    );
    let snapshot = feed.projection.snapshot(0, "e");
    let rows = snapshot["rows"]["window"].as_array().expect("rows");
    assert_eq!(
        rows.iter()
            .filter(|row| row["kind"] == "timelineMarker")
            .count(),
        1
    );
}

/// A reset outside a running turn draws nothing (it is emitted only by a turn).
#[test]
fn a_context_reset_outside_a_turn_draws_nothing() {
    let mut feed = Feed::new();
    assert_eq!(effects(feed.apply(reset())), Vec::<Value>::new());
    assert!(markers(&feed).is_empty());
}

/// A stall sets `control.externalAgentStall` with the event time; `resumed` clears it once; the turn's end clears a
/// stall still shown. Outside a running turn nothing changes, and the field is absent until the first stall.
#[test]
fn a_stall_shows_until_resumed_or_the_turn_ends() {
    let mut feed = Feed::new();
    assert_eq!(effects(feed.apply(status(STALLED))), Vec::<Value>::new());
    feed.apply(started());
    assert!(
        feed.projection.snapshot(0, "e")["control"]
            .get("externalAgentStall")
            .is_none()
    );
    let stalled = feed.apply(status(STALLED));
    let since = 2000 + feed.seq;
    assert_eq!(
        stall_patches(&stalled),
        vec![json!({"agentId": "mock", "since": since, "silentMs": 120_000})]
    );
    assert_eq!(
        stall_patches(&feed.apply(status(ExternalAgentStatus::Resumed))),
        vec![Value::Null]
    );
    // A `resumed` with no stall shown rewrites nothing.
    assert_eq!(
        effects(feed.apply(status(ExternalAgentStatus::Resumed))),
        Vec::<Value>::new()
    );
    feed.apply(status(STALLED));
    assert_eq!(
        stall_patches(&feed.apply(finished(TurnOutcome::Success))),
        vec![Value::Null]
    );
    assert_eq!(
        feed.projection.snapshot(0, "e")["control"]["externalAgentStall"],
        Value::Null
    );
    assert_eq!(effects(feed.apply(status(STALLED))), Vec::<Value>::new());
}

/// A stopped or failed turn clears its stall too.
#[test]
fn a_stopped_or_failed_turn_clears_its_stall() {
    for outcome in [
        TurnOutcome::Interrupted,
        TurnOutcome::Failed {
            message: "boom".into(),
            code: None,
        },
    ] {
        let mut feed = Feed::new();
        feed.apply(started());
        feed.apply(status(STALLED));
        assert_eq!(
            stall_patches(&feed.apply(finished(outcome))),
            vec![Value::Null]
        );
    }
}

fn reply_turn(feed: &mut Feed) {
    feed.apply(started());
    feed.apply(KernelEvent::MessageDone {
        message: super::user("msg_u1", "hello"),
    });
    feed.apply(reset());
    feed.apply(KernelEvent::MessageDone {
        message: super::assistant(
            "msg_a1",
            vec![rust_cli_kernel_api::message::ContentBlock::Text {
                text: "pong".into(),
            }],
        ),
    });
    feed.apply(finished(TurnOutcome::Success));
}

/// The kinds of the rows in order, and the turn of each.
fn kinds(feed: &Feed) -> Vec<(String, String)> {
    feed.projection
        .rows
        .iter()
        .map(|row| {
            (
                row["kind"].as_str().unwrap_or_default().to_owned(),
                row["turnId"].as_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

/// A history rebuild (rewind, edit, retry) keeps the divider while the process lives, after the input that opened its
/// turn and before the reply, as Node's cold merge re-inserts the in-memory notice before its turn's durable events.
/// A rebuild whose history no longer has that turn drops it.
#[test]
fn a_rebuild_keeps_the_context_reset_divider_in_its_turn() {
    let mut feed = Feed::new();
    reply_turn(&mut feed);
    let history = vec![
        super::user("msg_u1", "hello"),
        super::assistant(
            "msg_a1",
            vec![rust_cli_kernel_api::message::ContentBlock::Text {
                text: "pong".into(),
            }],
        ),
    ];
    feed.projection = feed.projection.rebuilt(&super::view(history.clone()));
    let rows = kinds(&feed);
    let at = |kind: &str| rows.iter().position(|(row, _)| row == kind);
    let (input, marker, reply) = (
        at("userInput").expect("input"),
        at("timelineMarker").expect("divider"),
        at("assistantText").expect("reply"),
    );
    assert!(input < marker && marker < reply, "{rows:?}");
    assert_eq!(rows[marker].1, rows[input].1, "{rows:?}");
    assert_eq!(markers(&feed).len(), 1);
    // A second rebuild still has it.
    feed.projection = feed.projection.rebuilt(&super::view(history));
    assert_eq!(markers(&feed).len(), 1);
    // A rewind past the turn drops it.
    feed.projection = feed.projection.rebuilt(&super::view(Vec::new()));
    assert!(markers(&feed).is_empty());
}

/// A rebuild during the running turn keeps the stall shown.
#[test]
fn a_rebuild_keeps_the_stall() {
    let mut feed = Feed::new();
    feed.apply(started());
    feed.apply(status(STALLED));
    let shown = feed.projection.snapshot(0, "e")["control"]["externalAgentStall"].clone();
    assert!(shown.is_object(), "{shown}");
    let mut running = super::view(vec![super::user("msg_u1", "hello")]);
    running.running = true;
    running.running_turn = Some(TurnId::new("turn_1"));
    feed.projection = feed.projection.rebuilt(&running);
    assert_eq!(
        feed.projection.snapshot(0, "e")["control"]["externalAgentStall"],
        shown
    );
}

/// A turn start clears a stall still shown (Node `onTurnStarted` `clearedExternalAgentStall`).
#[test]
fn a_turn_start_clears_a_stall() {
    let mut feed = Feed::new();
    feed.apply(started());
    feed.apply(status(STALLED));
    let next = feed.apply(KernelEvent::TurnStarted {
        turn: TurnId::new("turn_2"),
        command: None,
    });
    assert_eq!(stall_patches(&next), vec![Value::Null]);
}
