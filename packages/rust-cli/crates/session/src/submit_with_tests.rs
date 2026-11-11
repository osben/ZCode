//! Fork: `Command::SubmitWith` (the desktop App's inputs) and `Command::GrantFullAccess`
//! (specs/fork-rust-agent-parity.md, "Queued input kinds and execution state"): a queued input
//! freezes its execution state without touching the running turn's, applies it when it drains, and
//! full access rewrites the queued modes while keeping each plan switch.

use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
use rust_cli_kernel_api::session_api::{COMPACT_LOCKED, InputExecution, QueuedKind};

use super::*;

fn submit_with(id: &str, text: &str, mode: PermissionMode, plan: bool) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::SubmitWith {
            kind: QueuedKind::Text,
            text: text.to_owned(),
            content: Vec::new(),
            delivery: Delivery::Queue,
            execution: Some(InputExecution {
                state: ExecutionState { mode, plan },
                selection: None,
            }),
            behind_held: false,
        },
    }
}

fn compact(id: &str) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::SubmitWith {
            kind: QueuedKind::Compact,
            text: "/compact".to_owned(),
            content: Vec::new(),
            delivery: Delivery::Queue,
            execution: None,
            behind_held: true,
        },
    }
}

fn frozen(
    view: &rust_cli_kernel_api::session_api::SessionView,
) -> Vec<(QueuedKind, Option<ExecutionState>)> {
    view.queue
        .iter()
        .map(|item| {
            (
                item.kind,
                item.execution.as_ref().map(|execution| execution.state),
            )
        })
        .collect()
}

#[tokio::test]
async fn a_queued_input_freezes_its_state_and_applies_it_when_it_drains() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, _model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session
        .send(submit_with("c1", "ask me", PermissionMode::Default, false))
        .await;
    let interaction = asked(&mut events).await;
    assert!(matches!(
        session
            .send(submit_with(
                "c2",
                "plan later",
                PermissionMode::Guarded,
                true
            ))
            .await,
        Ack::Accepted { .. }
    ));
    let view = session.view().await.unwrap();
    // The running turn keeps its state: nothing of the queued input is applied yet.
    assert_eq!((view.mode, view.plan), (PermissionMode::Default, false));
    assert_eq!(
        frozen(&view),
        [(
            QueuedKind::Text,
            Some(ExecutionState {
                mode: PermissionMode::Guarded,
                plan: true
            })
        )]
    );
    session.send(answer("c3", interaction)).await;
    until_finished(&mut events, 2).await;
    let view = session.view().await.unwrap();
    assert!(view.queue.is_empty());
    assert_eq!((view.mode, view.plan), (PermissionMode::Guarded, true));
}

#[tokio::test]
async fn full_access_rewrites_queued_modes_and_keeps_plan() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, _model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session
        .send(submit_with("c1", "ask me", PermissionMode::Default, false))
        .await;
    asked(&mut events).await;
    session
        .send(submit_with("c2", "plan", PermissionMode::Default, true))
        .await;
    session
        .send(submit_with("c3", "guarded", PermissionMode::Guarded, false))
        .await;
    let ack = session
        .send(CommandEnvelope {
            id: CommandId::new("c4"),
            command: Command::GrantFullAccess {
                interaction: "i1".to_owned(),
            },
        })
        .await;
    assert!(matches!(ack, Ack::Accepted { .. }), "{ack:?}");
    let view = session.view().await.unwrap();
    assert_eq!(
        (view.mode, view.plan),
        (PermissionMode::BypassPermissions, false)
    );
    let bypass = |plan| {
        Some(ExecutionState {
            mode: PermissionMode::BypassPermissions,
            plan,
        })
    };
    assert_eq!(
        frozen(&view),
        [
            (QueuedKind::Text, bypass(true)),
            (QueuedKind::Text, bypass(false))
        ]
    );
}

#[tokio::test]
async fn a_second_compaction_is_locked_while_one_is_queued() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, _model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session
        .send(submit_with("c1", "ask me", PermissionMode::Default, false))
        .await;
    asked(&mut events).await;
    assert!(matches!(
        session.send(compact("c2")).await,
        Ack::Accepted { .. }
    ));
    assert_eq!(
        session.send(compact("c3")).await,
        Ack::Rejected {
            reason: COMPACT_LOCKED.to_owned()
        }
    );
    let view = session.view().await.unwrap();
    assert_eq!(frozen(&view), [(QueuedKind::Compact, None)]);
    // A queued compaction is maintenance: its text cannot be edited.
    let edit = session
        .send(CommandEnvelope {
            id: CommandId::new("c4"),
            command: Command::EditQueued {
                command: CommandId::new("c2"),
                text: "other".to_owned(),
            },
        })
        .await;
    assert!(matches!(edit, Ack::Rejected { .. }), "{edit:?}");
}

#[tokio::test]
async fn an_idle_compaction_joins_the_tail_of_a_held_queue() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session
        .send(submit_with("c1", "ask me", PermissionMode::Default, false))
        .await;
    let interaction = asked(&mut events).await;
    session
        .send(submit_with("c2", "held", PermissionMode::Default, false))
        .await;
    session
        .send(CommandEnvelope {
            id: CommandId::new("c3"),
            command: Command::HoldQueue { held: true },
        })
        .await;
    session.send(answer("c4", interaction)).await;
    until_finished(&mut events, 1).await;
    let requests = model.requests().len();
    // Node `compact`: idle behind a held queue, the compaction does not bypass the queued intent.
    assert!(matches!(
        session.send(compact("c5")).await,
        Ack::Accepted { .. }
    ));
    let view = session.view().await.unwrap();
    assert!(!view.running);
    assert_eq!(
        frozen(&view)
            .into_iter()
            .map(|(kind, _)| kind)
            .collect::<Vec<_>>(),
        [QueuedKind::Text, QueuedKind::Compact]
    );
    assert_eq!(model.requests().len(), requests);
}

#[test]
fn yolo_with_plan_on_still_runs_in_plan_mode() {
    let state = ExecutionState {
        mode: PermissionMode::BypassPermissions,
        plan: true,
    };
    assert_eq!(state.effective(), PermissionMode::Plan);
}

/// Fork: a guide (`Delivery::Steer`) absorbed into the running turn applies its frozen mode and Plan switch at once,
/// like Node's drain `applyRuntimeExecutionState`, instead of losing them when it leaves the queue without a turn.
#[tokio::test]
async fn an_absorbed_guide_applies_its_mode_and_plan_to_the_running_turn() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session
        .send(submit_with("c1", "ask me", PermissionMode::Default, false))
        .await;
    let interaction = asked(&mut events).await;
    let mut guide = submit_with("c2", "guide in plan", PermissionMode::Guarded, true);
    if let Command::SubmitWith { delivery, .. } = &mut guide.command {
        *delivery = Delivery::Steer;
    }
    assert!(matches!(session.send(guide).await, Ack::Accepted { .. }));
    let view = session.view().await.unwrap();
    assert_eq!((view.mode, view.plan), (PermissionMode::Default, false));
    session.send(answer("c3", interaction)).await;
    until_finished(&mut events, 1).await;
    // The guide joined the same turn (one turn, its text in the request after the tool round) and its state applies.
    assert!(format!("{:?}", model.requests().last().unwrap().messages).contains("guide in plan"));
    let view = session.view().await.unwrap();
    assert!(view.queue.is_empty());
    assert_eq!((view.mode, view.plan), (PermissionMode::Guarded, true));
}

/// Fork: an input's own model becomes the session's when its turn starts and stays for the turns after it, as Node
/// `acceptSubmissionModelSelection` makes it the session's selection (a prepared session's `firstInput` included).
#[tokio::test]
async fn a_submitted_model_becomes_the_session_model_when_its_turn_starts() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, _model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session
        .send(submit_with("c1", "ask me", PermissionMode::Default, false))
        .await;
    let interaction = asked(&mut events).await;
    let chosen = rust_cli_kernel_api::model::ModelSelection::new("other", "m2");
    let mut later = submit_with("c2", "on m2", PermissionMode::Default, false);
    if let Command::SubmitWith {
        execution: Some(execution),
        ..
    } = &mut later.command
    {
        execution.selection = Some(chosen.clone());
    }
    session.send(later).await;
    assert_ne!(session.view().await.unwrap().selection, chosen);
    session.send(answer("c3", interaction)).await;
    until_finished(&mut events, 2).await;
    assert_eq!(session.view().await.unwrap().selection, chosen);
}
