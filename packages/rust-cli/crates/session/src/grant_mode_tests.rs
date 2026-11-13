//! Fork (B3, specs/fork-rust-agent-parity.md): `Command::GrantPermissionMode`, the permission dialog's mode switch
//! (Node `resolvePermissionMode`). One actor step checks the pending ask, grants the mode and answers allow once; a
//! refusal changes nothing and leaves the ask pending.

use rust_cli_kernel_api::permission::{ExecutionState, PermissionMode};
use rust_cli_kernel_api::session_api::{CommandResult, InputExecution, QueuedKind};

use super::*;

async fn permission_session(
    scope: &TaskScope,
    permission: serde_json::Value,
) -> (Session, BoxStream<'static, SequencedEvent>, InteractionId) {
    let (_store, session, events, interaction) = stored_permission_session(scope, permission).await;
    (session, events, interaction)
}

/// [`permission_session`] with its store.
async fn stored_permission_session(
    scope: &TaskScope,
    permission: serde_json::Value,
) -> (
    Arc<MemoryStore>,
    Session,
    BoxStream<'static, SequencedEvent>,
    InteractionId,
) {
    let (store, _model, session) = asking_session_input(
        scope,
        Arc::new(NoHooks),
        serde_json::json!({"permission": permission}),
    )
    .await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    let interaction = asked(&mut events).await;
    (store, session, events, interaction)
}

fn grant(id: &str, interaction: &InteractionId, mode: PermissionMode) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::GrantPermissionMode {
            interaction: interaction.as_str().to_owned(),
            mode,
        },
    }
}

fn queued(id: &str, mode: PermissionMode, plan: bool) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::SubmitWith {
            intent: None,
            kind: QueuedKind::Text,
            text: "later".to_owned(),
            content: Vec::new(),
            delivery: Delivery::Queue,
            execution: Some(InputExecution {
                state: ExecutionState { mode, plan },
                selection: None,
                limits: Default::default(),
                keeps_session_state: false,
            }),
            behind_held: false,
            lease: None,
        },
    }
}

/// The ask is still pending and the mode is unchanged.
async fn unchanged(session: &Session, interaction: &InteractionId) {
    let view = session.view().await.unwrap();
    assert_eq!(view.mode, PermissionMode::Default);
    assert!(view.pending.iter().any(|(id, _)| id == interaction));
}

/// Allow and switch to guarded: the mode and every queued input's frozen mode become guarded (plan switches kept),
/// `PermissionGranted` follows the mode change, then the ask is answered allow once and the tool goes on.
#[tokio::test]
async fn a_guarded_grant_switches_the_mode_and_allows_the_call_once() {
    let scope = TaskScope::root("test", |_| {});
    let (store, session, mut events, interaction) =
        stored_permission_session(&scope, serde_json::json!({})).await;
    session
        .send(queued("c2", PermissionMode::Default, true))
        .await;
    let ack = session
        .send(grant("c3", &interaction, PermissionMode::Guarded))
        .await;
    assert_eq!(
        ack,
        Ack::Accepted {
            result: CommandResult::Done
        }
    );
    let seen = until_finished(&mut events, 2).await;
    let order: Vec<&str> = seen
        .iter()
        .filter_map(|event| match event {
            KernelEvent::ModeChanged { .. } => Some("mode"),
            KernelEvent::PermissionGranted {
                interaction: granted,
            } => {
                assert_eq!(granted, interaction.as_str());
                Some("granted")
            }
            KernelEvent::InteractionResolved { .. } => Some("resolved"),
            _ => None,
        })
        .collect();
    assert_eq!(order[..3], ["mode", "granted", "resolved"]);
    let view = session.view().await.unwrap();
    assert_eq!((view.mode, view.plan), (PermissionMode::Guarded, true));
    assert!(view.pending.is_empty());
    // B3 review: the receipt is committed with the execution state in one batch (plan was off when it was granted; the
    // queued input turned it on later) (Node `commitPermissionFullAccess`),
    // and the view names the grant (`config.permissionGrant`).
    assert_eq!(view.permission_grant.as_deref(), Some(interaction.as_str()));
    let facts = store.facts(&view.meta.id);
    let at = facts
        .iter()
        .position(|fact| matches!(fact, Fact::PermissionGranted { .. }))
        .expect("no receipt");
    assert!(
        matches!(
            &facts[at - 2..=at],
            [
                Fact::ExecutionChanged { .. },
                Fact::ProjectModeSet { .. },
                Fact::PermissionGranted { interaction: granted, previous, next, queue_items },
            ] if granted == interaction.as_str()
                && previous.mode == PermissionMode::Default
                && *next == ExecutionState { mode: PermissionMode::Guarded, plan: false }
                && queue_items == &["queue_c2".to_owned()]
        ),
        "{:?}",
        &facts[at - 2..=at]
    );
}

/// A grant to the mode the session already has still commits its execution state and receipt (Node does not
/// short-circuit), so a cold read names it.
#[tokio::test]
async fn a_grant_to_the_current_mode_still_stores_its_receipt() {
    let scope = TaskScope::root("test", |_| {});
    let (store, session, _events, interaction) =
        stored_permission_session(&scope, serde_json::json!({})).await;
    session
        .send(CommandEnvelope {
            id: CommandId::new("m1"),
            command: Command::SetMode {
                mode: PermissionMode::Guarded,
            },
        })
        .await;
    let before = store.facts(&session.view().await.unwrap().meta.id).len();
    let ack = session
        .send(grant("c2", &interaction, PermissionMode::Guarded))
        .await;
    assert!(matches!(ack, Ack::Accepted { .. }), "{ack:?}");
    let view = session.view().await.unwrap();
    let after = store.facts(&view.meta.id);
    assert!(
        after[before..]
            .iter()
            .any(|fact| matches!(fact, Fact::PermissionGranted { .. })),
        "{:?}",
        &after[before..]
    );
    assert_eq!(view.permission_grant.as_deref(), Some(interaction.as_str()));
}

/// Full access rewrites the queued modes too, keeping each plan switch (Node `fullAccess`); a once-ask (guarded
/// already) takes it.
#[tokio::test]
async fn full_access_rewrites_queued_modes_and_keeps_plan() {
    let scope = TaskScope::root("test", |_| {});
    let (session, _events, interaction) =
        permission_session(&scope, serde_json::json!({"once": true})).await;
    session
        .send(CommandEnvelope {
            id: CommandId::new("hold"),
            command: Command::HoldQueue { held: true },
        })
        .await;
    session
        .send(queued("c2", PermissionMode::Default, true))
        .await;
    session
        .send(queued("c3", PermissionMode::Guarded, false))
        .await;
    let ack = session
        .send(grant("c4", &interaction, PermissionMode::BypassPermissions))
        .await;
    assert!(matches!(ack, Ack::Accepted { .. }), "{ack:?}");
    let view = session.view().await.unwrap();
    assert_eq!(view.mode, PermissionMode::BypassPermissions);
    let bypass = |plan| {
        Some(ExecutionState {
            mode: PermissionMode::BypassPermissions,
            plan,
        })
    };
    let frozen: Vec<_> = view
        .queue
        .iter()
        .map(|item| item.execution.as_ref().map(|execution| execution.state))
        .collect();
    assert_eq!(frozen, [bypass(true), bypass(false)]);
}

/// A once-ask (a guarded dangerous command) takes only full access (Node broker `Already in autonomous mode`).
#[tokio::test]
async fn a_once_ask_refuses_the_guarded_switch() {
    let scope = TaskScope::root("test", |_| {});
    let (session, _events, interaction) =
        permission_session(&scope, serde_json::json!({"once": true})).await;
    let ack = session
        .send(grant("c2", &interaction, PermissionMode::Guarded))
        .await;
    assert_eq!(
        ack,
        Ack::Rejected {
            reason: "Already in autonomous mode".to_owned()
        }
    );
    unchanged(&session, &interaction).await;
}

/// A subagent's ask, an independent confirmation and a question cannot grant a mode (Node registers the grant only
/// for the session's own ask without `optionsPolicy`; a plain question has no grant hook).
#[tokio::test]
async fn asks_without_a_mode_switch_refuse_the_grant() {
    for permission in [
        Some(serde_json::json!({"subagent": true})),
        Some(serde_json::json!({"once": true, "independent": true})),
        None,
    ] {
        let scope = TaskScope::root("test", |_| {});
        let (session, _events, interaction) = match permission {
            Some(permission) => permission_session(&scope, permission).await,
            None => {
                let (_store, _model, session) = asking_session(&scope).await;
                let mut events = session.subscribe(Some(0));
                session.send(submit("c1", "ask me")).await;
                let interaction = asked(&mut events).await;
                (session, events, interaction)
            }
        };
        let ack = session
            .send(grant("c2", &interaction, PermissionMode::BypassPermissions))
            .await;
        assert_eq!(
            ack,
            Ack::Rejected {
                reason: "Full access is not supported for this interaction".to_owned()
            }
        );
        unchanged(&session, &interaction).await;
    }
}

/// A held promotion lease refuses the grant (Node `Queue mutation is busy; retry approval`): its input, outside the
/// queue, would keep its old mode. Released, the retry is granted.
#[tokio::test]
async fn a_held_promotion_lease_refuses_the_grant_until_it_is_released() {
    let scope = TaskScope::root("test", |_| {});
    let (session, _events, interaction) = permission_session(&scope, serde_json::json!({})).await;
    let lease = |id: &str, reserved| CommandEnvelope {
        id: CommandId::new(id),
        command: Command::ReserveForeground {
            reserved,
            lease: "lease_1".to_owned(),
        },
    };
    assert!(matches!(
        session.send(lease("l1", true)).await,
        Ack::Accepted { .. }
    ));
    assert_eq!(
        session
            .send(grant("c2", &interaction, PermissionMode::Guarded))
            .await,
        Ack::Rejected {
            reason: "Queue mutation is busy; retry approval".to_owned()
        }
    );
    unchanged(&session, &interaction).await;
    session.send(lease("l2", false)).await;
    assert!(matches!(
        session
            .send(grant("c3", &interaction, PermissionMode::Guarded))
            .await,
        Ack::Accepted {
            result: CommandResult::Done
        }
    ));
}

/// A grant for an ask that is no longer pending changes nothing (a late answer, Node's registry miss).
#[tokio::test]
async fn a_grant_for_an_ask_no_longer_pending_changes_nothing() {
    let scope = TaskScope::root("test", |_| {});
    let (session, _events, _interaction) = permission_session(&scope, serde_json::json!({})).await;
    let ack = session
        .send(grant(
            "c2",
            &InteractionId::new("int_gone"),
            PermissionMode::BypassPermissions,
        ))
        .await;
    assert_eq!(
        ack,
        Ack::Accepted {
            result: CommandResult::NotPending
        }
    );
    assert_eq!(session.view().await.unwrap().mode, PermissionMode::Default);
}
