//! The turn-by-turn entry for a workflow actor (W6a part 2c-2b-2): `Agents::run_actor_turn` runs one turn of an ask on a
//! child session, and the session persists between calls, so the next turn resumes it.
use crate::actor_turn::{ActorRun, ActorTurnEnd};
use crate::test_support::{harness, workspace};
use rust_cli_base::models::GLM_5_3_ACCOUNT;
use rust_cli_kernel_api::ids::{SessionId, TraceId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::store::{SessionKind, SessionMeta, SessionStore};
use std::sync::Arc;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

fn run_for(child: &SessionId, parent: &SessionId) -> ActorRun {
    ActorRun {
        child: child.clone(),
        parent: parent.clone(),
        description: "workflow subagent site@1".to_owned(),
        persona_prompt: "You are a workflow actor.".to_owned(),
        workspace: workspace(),
        selection: ModelSelection::new("account:bigmodel-team-coding-plan", GLM_5_3_ACCOUNT),
        mode: PermissionMode::Default,
    }
}

/// The child session the workflow creates (NodeActorSessions writes this row in production).
async fn create_child(store: &dyn SessionStore, child: &SessionId, parent: &SessionId) {
    store
        .create(SessionMeta {
            id: child.clone(),
            kind: SessionKind::Subagent,
            parent: Some(parent.clone()),
            workspace: workspace(),
            title: "workflow subagent site@1".to_owned(),
            trace: TraceId::new(parent.as_str()),
            created_at_ms: 1,
            incognito: None,
        })
        .await
        .expect("the child session row");
}

#[tokio::test]
async fn an_actor_turn_runs_on_its_child_and_returns_the_final_text() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_child");
    create_child(h.store.as_ref(), &child, &parent).await;
    let end = h
        .agents
        .run_actor_turn(run_for(&child, &parent), "do it", CancellationToken::new())
        .await;
    assert_eq!(
        end,
        ActorTurnEnd::Text("Hello from the subagent.".to_owned())
    );
    assert_eq!(h.seen.lock().expect("seen").len(), 1, "one model turn ran");
}

#[tokio::test]
async fn the_next_turn_resumes_the_same_child_session() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_child");
    create_child(h.store.as_ref(), &child, &parent).await;
    let first = h
        .agents
        .run_actor_turn(run_for(&child, &parent), "first", CancellationToken::new())
        .await;
    let second = h
        .agents
        .run_actor_turn(run_for(&child, &parent), "second", CancellationToken::new())
        .await;
    assert_eq!(
        first,
        ActorTurnEnd::Text("Hello from the subagent.".to_owned())
    );
    assert_eq!(
        second,
        ActorTurnEnd::Text("Hello from the subagent.".to_owned())
    );
    // The guard is dropped before the first await below: a held std guard across an await is a lint error.
    let model_turns = h.seen.lock().expect("seen").len();
    assert_eq!(model_turns, 2, "two model turns ran");
    let stored = h
        .store
        .load(&child)
        .await
        .expect("the child session is stored");
    let prompts = stored
        .messages
        .iter()
        .filter(|message| matches!(message, rust_cli_kernel_api::message::Message::User(_)))
        .count();
    assert_eq!(prompts, 2, "both prompts are in the one child transcript");
}

#[tokio::test]
async fn a_turn_cancelled_before_it_runs_is_stopped_and_reports_no_text() {
    // A gated runner waits for the abort, so the cancel is what ends the turn.
    let gate = Arc::new(Notify::new());
    let h = harness(Some(gate));
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_child");
    create_child(h.store.as_ref(), &child, &parent).await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let end = h
        .agents
        .run_actor_turn(run_for(&child, &parent), "do it", cancel)
        .await;
    assert_eq!(end, ActorTurnEnd::Stopped);
}
