//! B1.1（specs/fork-rust-agent-parity.md）：受管 worktree 的 `worktreeCreated` 时间线标记。Node 在
//! TurnStarted 之前落盘 `worktree_creation` 时间线 part 并在首个回合头前冲刷 pending 标记
//!（product-projection.ts `onTurnStarted`，`lightBoundary` 道）；Rust 以会话记录存同一事实，首个回合头
//! 之前画出同一行，重建的历史再画一次。

use super::*;

fn fact() -> Value {
    json!({"path": "/w/.zcode-worktrees/one", "sha": "a1b2c3d4", "ref": null, "output": "worktree added"})
}

fn seeded(fact: Option<Value>) -> Projection {
    Projection::from_view_with_creation(&view(Vec::new()), Followup::Queue, Vec::new(), fact)
}

/// The marker leads the first turn, before its header, in Node's row shape.
#[test]
fn the_creation_fact_leads_the_first_turn() {
    let mut projection = seeded(Some(fact()));
    let started = projection.apply(
        &SequencedEvent {
            seq: 1,
            event: KernelEvent::TurnStarted {
                turn: TurnId::new("turn_1"),
                command: Some(CommandId::new("c1")),
            },
            revision: 1,
        },
        2000,
    );
    let rows: Vec<&str> = started
        .iter()
        .filter(|delta| delta.get("row").is_some())
        .map(|delta| delta["row"]["kind"].as_str().unwrap())
        .collect();
    assert_eq!(rows, ["timelineMarker", "turnHeader"]);
    let marker = &started[0]["row"];
    assert_eq!(marker["lane"], "lightBoundary");
    assert_eq!(
        marker["entityId"],
        "worktree-created:/w/.zcode-worktrees/one"
    );
    assert_eq!(
        marker["marker"],
        json!({"type": "worktreeCreated", "path": "/w/.zcode-worktrees/one",
               "sha": "a1b2c3d4", "ref": null, "output": "worktree added"})
    );
    // One marker per session: the second turn draws nothing.
    let second = projection.apply(
        &SequencedEvent {
            seq: 2,
            event: KernelEvent::TurnStarted {
                turn: TurnId::new("turn_2"),
                command: None,
            },
            revision: 2,
        },
        3000,
    );
    assert!(
        second
            .iter()
            .all(|delta| delta["row"]["marker"]["type"] != "worktreeCreated")
    );
}

/// Without a fact there is no marker (every ordinary session).
#[test]
fn a_session_without_a_creation_fact_draws_no_marker() {
    let mut projection = seeded(None);
    let started = projection.apply(
        &SequencedEvent {
            seq: 1,
            event: KernelEvent::TurnStarted {
                turn: TurnId::new("turn_1"),
                command: None,
            },
            revision: 1,
        },
        2000,
    );
    assert!(
        started
            .iter()
            .all(|delta| delta["row"]["marker"]["type"] != "worktreeCreated")
    );
}

/// The fact outlives the rows: a rebuilt history (rewind, edit, retry) draws the marker again, from the
/// stored fact, in the history's first turn.
#[test]
fn a_rebuilt_history_draws_the_marker_again() {
    let mut projection = seeded(Some(fact()));
    projection.apply(
        &SequencedEvent {
            seq: 1,
            event: KernelEvent::TurnStarted {
                turn: TurnId::new("turn_1"),
                command: None,
            },
            revision: 1,
        },
        2000,
    );
    let rebuilt = projection.rebuilt(&view(vec![user("m1", "hello")]));
    let rows = &rebuilt.rows;
    let marker = rows
        .iter()
        .find(|row| row["marker"]["type"] == "worktreeCreated")
        .expect("the rebuilt history draws the marker again");
    let header = rows
        .iter()
        .position(|row| row["kind"] == "turnHeader")
        .unwrap();
    assert!(
        rows.iter()
            .position(|row| row["marker"]["type"] == "worktreeCreated")
            .unwrap()
            < header
    );
    assert_eq!(marker["turnId"], rows[header]["turnId"]);
}
