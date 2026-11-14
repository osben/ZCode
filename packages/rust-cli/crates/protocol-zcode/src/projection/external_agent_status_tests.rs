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
