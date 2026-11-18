//! The turn-by-turn entry for a workflow actor (W6a part 2c-2b-2): `Agents::run_actor_turn` runs one turn of an ask on a
//! child session, and the session persists between calls, so the next turn resumes it.
use crate::actor_turn::{ActorRun, ActorTurnEnd};
use crate::test_support::{harness, workspace};
use rust_cli_base::models::GLM_5_3_ACCOUNT;
use rust_cli_kernel_api::ids::{SessionId, TraceId};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::model::{ModelSelection, QuerySource};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::store::{SessionKind, SessionMeta, SessionStore};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

/// The persona prompt the entry must put in the child's system blocks.
const PERSONA: &str = "You are a workflow actor.";
/// The title the workflow writes on the child row. The entry must leave it alone.
const SEEDED_TITLE: &str = "seeded by the workflow";
const SEEDED_CREATED_AT: u64 = 7;

fn selection() -> ModelSelection {
    ModelSelection::new("account:bigmodel-team-coding-plan", GLM_5_3_ACCOUNT)
}

fn run_for(child: &SessionId, parent: &SessionId) -> ActorRun {
    ActorRun {
        child: child.clone(),
        parent: parent.clone(),
        interaction_description: "Ada (site@1)".to_owned(),
        interactions: None,
        persona_prompt: PERSONA.to_owned(),
        workspace: workspace(),
        selection: selection(),
        mode: PermissionMode::Default,
    }
}

/// The child session row the workflow writes (NodeActorSessions does this in production). The title and the creation
/// time are markers: a first-call `store.create` would overwrite them, and the tests check they survive.
async fn create_child(store: &dyn SessionStore, child: &SessionId, parent: &SessionId) {
    store
        .create(SessionMeta {
            id: child.clone(),
            kind: SessionKind::Subagent,
            parent: Some(parent.clone()),
            workspace: workspace(),
            title: SEEDED_TITLE.to_owned(),
            trace: TraceId::new(parent.as_str()),
            created_at_ms: SEEDED_CREATED_AT,
            incognito: None,
        })
        .await
        .expect("the child session row");
}

fn user_prompts(messages: &[Message]) -> usize {
    messages
        .iter()
        .filter(|message| matches!(message, Message::User(_)))
        .count()
}

fn assistant_replies(messages: &[Message]) -> usize {
    messages
        .iter()
        .filter(|message| matches!(message, Message::Assistant(_)))
        .count()
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
    let model_turns = h.seen.lock().expect("seen").len();
    assert_eq!(model_turns, 1, "one model turn ran");
}

#[tokio::test]
async fn the_first_turn_keeps_the_workflows_child_row() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_child");
    create_child(h.store.as_ref(), &child, &parent).await;
    h.agents
        .run_actor_turn(run_for(&child, &parent), "do it", CancellationToken::new())
        .await;
    let loaded = h
        .store
        .load(&child)
        .await
        .expect("the child session is stored");
    assert_eq!(
        loaded.meta.title, SEEDED_TITLE,
        "the entry does not rewrite the row"
    );
    assert_eq!(loaded.meta.created_at_ms, SEEDED_CREATED_AT);
}

#[tokio::test]
async fn a_turn_for_a_child_with_no_row_fails_and_creates_no_row() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_missing_child");
    let end = h
        .agents
        .run_actor_turn(run_for(&child, &parent), "do it", CancellationToken::new())
        .await;
    assert!(matches!(end, ActorTurnEnd::Failed(_)), "{end:?}");
    assert!(
        h.store.load(&child).await.is_err(),
        "the entry must not create the child row"
    );
    assert_eq!(h.seen.lock().expect("seen").len(), 0, "no model turn ran");
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
    assert_eq!(
        user_prompts(&stored.messages),
        2,
        "both prompts are in the one child transcript"
    );
}

#[tokio::test]
async fn the_second_model_request_carries_the_first_turns_exchange() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_child");
    create_child(h.store.as_ref(), &child, &parent).await;
    h.agents
        .run_actor_turn(
            run_for(&child, &parent),
            "first prompt",
            CancellationToken::new(),
        )
        .await;
    h.agents
        .run_actor_turn(
            run_for(&child, &parent),
            "second prompt",
            CancellationToken::new(),
        )
        .await;
    let second_request = {
        let seen = h.seen.lock().expect("seen");
        assert_eq!(seen.len(), 2);
        serde_json::to_string(&seen[1].request.messages).expect("the messages serialise")
    };
    assert!(
        second_request.contains("first prompt"),
        "turn 1's prompt is in turn 2's request"
    );
    assert!(
        second_request.contains("Hello from the subagent."),
        "turn 1's reply is in turn 2's request"
    );
    assert!(second_request.contains("second prompt"));
}

#[tokio::test]
async fn the_model_request_carries_the_persona_selection_mode_and_source() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_child");
    create_child(h.store.as_ref(), &child, &parent).await;
    h.agents
        .run_actor_turn(run_for(&child, &parent), "do it", CancellationToken::new())
        .await;
    let seen = h.seen.lock().expect("seen");
    let request = &seen[0].request;
    assert_eq!(request.selection, selection());
    assert_eq!(request.mode, PermissionMode::Default);
    assert_eq!(
        request.source,
        QuerySource::Subagent("workflow_actor".to_owned())
    );
    assert!(
        seen[0]
            .system
            .iter()
            .any(|block| block.text.contains(PERSONA)),
        "the persona prompt is in the system blocks"
    );
}

#[tokio::test]
async fn a_turn_cancelled_before_it_runs_is_stopped_and_leaves_only_its_prompt() {
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
    let stored = h
        .store
        .load(&child)
        .await
        .expect("the child session is stored");
    assert_eq!(
        user_prompts(&stored.messages),
        1,
        "the prompt was appended before the cancel"
    );
    assert_eq!(
        assistant_replies(&stored.messages),
        0,
        "no reply was committed"
    );
}

#[tokio::test]
async fn a_second_turn_on_a_running_actor_is_refused_and_does_not_disturb_the_first() {
    // The first turn blocks on the gate. The second call must be refused while the first is running; the second's
    // completion cancels the first, which then ends as stopped.
    let gate = Arc::new(Notify::new());
    let h = harness(Some(gate));
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_child");
    create_child(h.store.as_ref(), &child, &parent).await;
    let cancel_first = CancellationToken::new();
    let cancel_first_handle = cancel_first.clone();
    let first = h
        .agents
        .run_actor_turn(run_for(&child, &parent), "first", cancel_first);
    let second = async {
        let refused = h
            .agents
            .run_actor_turn(run_for(&child, &parent), "second", CancellationToken::new())
            .await;
        cancel_first_handle.cancel();
        refused
    };
    let (first_end, second_end) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(first, second)
    })
    .await
    .expect("the refused turn returns and the first is stopped by it");
    assert!(
        matches!(&second_end, ActorTurnEnd::Failed(message) if message.contains("already")),
        "{second_end:?}"
    );
    assert_eq!(first_end, ActorTurnEnd::Stopped);
}
