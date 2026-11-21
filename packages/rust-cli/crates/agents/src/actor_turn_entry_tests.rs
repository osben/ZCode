//! The turn-by-turn entry for a workflow actor (W6a part 2c-2b-2): `Agents::run_actor_turn` runs one turn of an ask on a
//! child session, and the session persists between calls, so the next turn resumes it.
use crate::actor_turn::{ActorPort, ActorRun, ActorSubmit, ActorTurnEnd, SubmitPort};
use crate::live::LiveAgent;
use crate::test_support::{harness, workspace};
use rust_cli_base::models::GLM_5_3_ACCOUNT;
use rust_cli_kernel_api::ids::{AgentId, SessionId, TraceId, WorkflowRunId};
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
        on_mutating: None,
        on_request: None,
        admission_run: None,
        child: child.clone(),
        parent: parent.clone(),
        interaction_description: "Ada (site@1)".to_owned(),
        interactions: None,
        port: None,
        epilogue_start: None,
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

/// W6b part 2b: the run an actor belongs to reaches the model request as its admission run, on every request of the
/// actor's turn. A turn with no run carries none.
#[tokio::test]
async fn an_actor_turns_model_request_carries_its_workflow_run() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_child");
    create_child(h.store.as_ref(), &child, &parent).await;
    let mut run = run_for(&child, &parent);
    run.admission_run = Some(WorkflowRunId::new("wf_1"));
    h.agents
        .run_actor_turn(run, "do it", CancellationToken::new())
        .await;
    {
        let seen = h.seen.lock().expect("seen");
        assert_eq!(
            seen[0]
                .request
                .admission_run
                .as_ref()
                .map(WorkflowRunId::as_str),
            Some("wf_1"),
            "the turn's request is admitted under its run"
        );
    }

    let plain_child = SessionId::new("sess_actor_plain");
    create_child(h.store.as_ref(), &plain_child, &parent).await;
    h.agents
        .run_actor_turn(
            run_for(&plain_child, &parent),
            "do it",
            CancellationToken::new(),
        )
        .await;
    let seen = h.seen.lock().expect("seen");
    assert_eq!(seen.len(), 2, "one model turn per run");
    assert_eq!(seen[1].request.admission_run, None);
}

/// A child's live entry is made by its first turn, and a later turn refreshes its run: a child first run with no run and
/// then with one has its second turn's requests admitted under that run.
#[tokio::test]
async fn a_later_turn_of_a_child_takes_the_run_it_now_belongs_to() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_rerun");
    create_child(h.store.as_ref(), &child, &parent).await;
    h.agents
        .run_actor_turn(run_for(&child, &parent), "first", CancellationToken::new())
        .await;
    let mut run = run_for(&child, &parent);
    run.admission_run = Some(WorkflowRunId::new("wf_1"));
    h.agents
        .run_actor_turn(run, "second", CancellationToken::new())
        .await;
    // A third turn under a different run follows the run it now belongs to, not the first one's.
    let mut run = run_for(&child, &parent);
    run.admission_run = Some(WorkflowRunId::new("wf_2"));
    h.agents
        .run_actor_turn(run, "third", CancellationToken::new())
        .await;
    let seen = h.seen.lock().expect("seen");
    assert_eq!(seen.len(), 3, "one model turn per run");
    assert_eq!(seen[0].request.admission_run, None);
    assert_eq!(
        seen[1]
            .request
            .admission_run
            .as_ref()
            .map(WorkflowRunId::as_str),
        Some("wf_1"),
        "the second turn is admitted under the run it now belongs to"
    );
    assert_eq!(
        seen[2]
            .request
            .admission_run
            .as_ref()
            .map(WorkflowRunId::as_str),
        Some("wf_2"),
        "the third turn is admitted under the next run"
    );
}

/// A port that refuses every submit: these tests look at the tool list and the entry, not at a submit.
struct PortStub;

#[async_trait::async_trait]
impl ActorPort for PortStub {
    async fn submit(&self, _result: serde_json::Value) -> Result<ActorSubmit, String> {
        Err("not under test".to_owned())
    }

    async fn escalate(
        &self,
        _question: crate::actor_turn::ActorQuestion,
    ) -> Result<crate::actor_turn::ActorEscalation, String> {
        Err("not under test".to_owned())
    }
}

fn actor_entry_id(child: &SessionId) -> AgentId {
    AgentId::new(format!("actor-{}", child.as_str()))
}

/// The submit port a turn carries: the refusing stub, with the mono session's schema (None for a generic one).
fn port_with(submit_schema: Option<serde_json::Value>) -> SubmitPort {
    SubmitPort {
        port: Arc::new(PortStub),
        submit_schema,
    }
}

/// A run whose turn carries a submit port with the given schema.
fn run_with_port(
    child: &SessionId,
    parent: &SessionId,
    submit_schema: Option<serde_json::Value>,
) -> ActorRun {
    let mut run = run_for(child, parent);
    run.port = Some(port_with(submit_schema));
    run
}

#[test]
fn a_turns_submit_schema_reaches_its_entry_port_and_its_declaration() {
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_schema");
    let schema = serde_json::json!({"type": "object", "required": ["ok"]});
    let entry = LiveAgent::for_actor(
        run_with_port(&child, &parent, Some(schema.clone())),
        actor_entry_id(&child),
        parent.clone(),
    );
    let port = entry.actor_port.as_ref().expect("the entry holds the port");
    assert_eq!(port.submit_schema, Some(schema));
    let submit = crate::submit::tools_for(entry.actor_port.as_ref())
        .into_iter()
        .find(|tool| tool.name() == "submit_result")
        .expect("the port offers submit_result");
    assert_eq!(
        submit.input_schema()["properties"]["result"]["required"],
        serde_json::json!(["ok"]),
        "the declaration is the mono session's schema"
    );
}

#[test]
fn a_generic_turns_port_carries_no_schema_and_its_declaration_takes_any_json() {
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_generic_schema");
    let entry = LiveAgent::for_actor(
        run_with_port(&child, &parent, None),
        actor_entry_id(&child),
        parent.clone(),
    );
    assert_eq!(
        entry.actor_port.as_ref().expect("the port").submit_schema,
        None
    );
}

#[tokio::test]
async fn a_turn_with_a_port_offers_submit_result_and_its_end_clears_the_port() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_port_clear");
    create_child(h.store.as_ref(), &child, &parent).await;
    let mut run = run_for(&child, &parent);
    run.port = Some(port_with(None));
    h.agents
        .run_actor_turn(run, "do it", CancellationToken::new())
        .await;
    let offered = h.seen.lock().expect("seen")[0].tools.clone();
    assert!(
        offered.iter().any(|tool| tool == "submit_result"),
        "the turn offers submit_result: {offered:?}"
    );
    let entry = h
        .agents
        .core
        .live
        .get(&actor_entry_id(&child))
        .expect("the actor's entry");
    assert!(
        entry.actor_port.is_none(),
        "the turn's end clears its port, so a restart of the finished child offers no submit_result"
    );
}

#[tokio::test]
async fn a_turn_without_a_port_offers_no_submit_result() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_no_port");
    create_child(h.store.as_ref(), &child, &parent).await;
    h.agents
        .run_actor_turn(run_for(&child, &parent), "do it", CancellationToken::new())
        .await;
    let offered = h.seen.lock().expect("seen")[0].tools.clone();
    assert!(
        !offered.iter().any(|tool| tool == "submit_result"),
        "without a port there is no submit_result: {offered:?}"
    );
}

#[tokio::test]
async fn the_child_tools_carry_submit_result_only_for_an_entry_with_a_port() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_tools");
    let names = |entry: &LiveAgent| -> Vec<String> {
        crate::spawn::child_tools(&h.agents.core, entry)
            .iter()
            .map(|tool| tool.name().to_owned())
            .collect()
    };
    let mut with = run_for(&child, &parent);
    with.port = Some(port_with(None));
    let with_port = LiveAgent::for_actor(with, actor_entry_id(&child), parent.clone());
    assert!(names(&with_port).iter().any(|name| name == "submit_result"));
    let without = LiveAgent::for_actor(
        run_for(&child, &parent),
        actor_entry_id(&child),
        parent.clone(),
    );
    assert!(!names(&without).iter().any(|name| name == "submit_result"));
}

#[tokio::test]
async fn a_second_turn_offers_submit_result_again_with_its_own_port() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_port_swap");
    create_child(h.store.as_ref(), &child, &parent).await;
    // The first turn's end clears its port. The second turn offers submit_result only if its refresh set its own port.
    for prompt in ["first", "second"] {
        let mut run = run_for(&child, &parent);
        run.port = Some(port_with(None));
        h.agents
            .run_actor_turn(run, prompt, CancellationToken::new())
            .await;
    }
    let seen = h.seen.lock().expect("seen");
    assert_eq!(seen.len(), 2, "one model turn per run");
    assert!(
        seen[1].tools.iter().any(|tool| tool == "submit_result"),
        "the second turn offers submit_result: {:?}",
        seen[1].tools
    );
}

#[tokio::test]
async fn a_turns_epilogue_boundary_is_on_its_user_message() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_boundary");
    create_child(h.store.as_ref(), &child, &parent).await;
    let mut run = run_for(&child, &parent);
    run.epilogue_start = Some(5);
    let end = h
        .agents
        .run_actor_turn(run, "do it", CancellationToken::new())
        .await;
    assert_eq!(
        end,
        ActorTurnEnd::Text("Hello from the subagent.".to_owned())
    );
    let stored = h
        .store
        .load(&child)
        .await
        .expect("the child session is stored");
    let boundaries: Vec<Option<usize>> = stored
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::User(user) => Some(user.epilogue_start),
            _ => None,
        })
        .collect();
    assert_eq!(
        boundaries,
        vec![Some(5)],
        "the turn's prompt carries its boundary"
    );
}

#[tokio::test]
async fn a_nudged_turns_prompt_is_stored_with_the_boundary_zero() {
    // Node `runTurn(NUDGE_PROMPT, 0)`: the nudge's user message carries Some(0), not no boundary.
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_nudge_boundary");
    create_child(h.store.as_ref(), &child, &parent).await;
    let mut first = run_for(&child, &parent);
    first.epilogue_start = Some(5);
    h.agents
        .run_actor_turn(first, "do it", CancellationToken::new())
        .await;
    let mut nudge = run_for(&child, &parent);
    nudge.epilogue_start = Some(0);
    h.agents
        .run_actor_turn(nudge, "nudge", CancellationToken::new())
        .await;
    let stored = h
        .store
        .load(&child)
        .await
        .expect("the child session is stored");
    let boundaries: Vec<Option<usize>> = stored
        .messages
        .iter()
        .filter_map(|message| match message {
            Message::User(user) => Some(user.epilogue_start),
            _ => None,
        })
        .collect();
    assert_eq!(boundaries, vec![Some(5), Some(0)]);
}

#[tokio::test]
async fn a_finished_turn_keeps_its_counts_for_the_bridge() {
    // The turn's response carries no usage record, so the bridge reads no request, no tokens, and no tool calls.
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_turn_stats");
    create_child(h.store.as_ref(), &child, &parent).await;
    h.agents
        .run_actor_turn(run_for(&child, &parent), "do it", CancellationToken::new())
        .await;
    let stats = h
        .agents
        .actor_turn_stats(&child)
        .expect("the finished turn has counts");
    assert_eq!(
        stats.requests, 0,
        "the harness responses carry no usage record, so no request is counted"
    );
    assert_eq!(
        stats.tokens, None,
        "and the turn reports no usage: the failed usage read"
    );
    assert_eq!(stats.tool_calls, 0, "no tool started");
    assert_eq!(stats.world_tool_calls, 0);
}

#[tokio::test]
async fn the_child_message_count_is_its_stored_message_count() {
    // The count the ask's boundary is written with (Node `journalAskMessageBoundary`): the child's messages, as stored.
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_message_count");
    create_child(h.store.as_ref(), &child, &parent).await;
    h.agents
        .run_actor_turn(run_for(&child, &parent), "do it", CancellationToken::new())
        .await;
    let stored = h.store.load(&child).await.expect("the child is stored");
    assert_eq!(
        h.agents.child_message_count(&child).await,
        Some(stored.messages.len() as u64)
    );
    assert!(
        stored.messages.len() >= 2,
        "the prompt and the reply are both counted"
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

/// Review finding 4: releasing a child with no live entry is nothing to release.
#[tokio::test]
async fn releasing_an_actor_session_with_no_entry_is_ok() {
    let h = harness(None);
    let child = SessionId::new("sess_unknown");
    h.agents
        .release_actor_session(&child)
        .expect("nothing to release");
    assert!(h.agents.core.live.get(&actor_entry_id(&child)).is_none());
}

/// Review finding 4: a turn still running holds its session, so the release is refused and the entry stays.
#[tokio::test]
async fn a_running_actor_session_is_refused_and_keeps_its_entry() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_running");
    let agent = actor_entry_id(&child);
    let root = h.agents.core.live.root_of(&parent);
    let started = h.agents.core.live.begin_actor_run(
        &agent,
        || LiveAgent::for_actor(run_for(&child, &parent), agent.clone(), root.clone()),
        |_entry| {},
        "exec_running".to_owned(),
    );
    assert!(matches!(started, crate::live::BeginActorRun::Started));
    let error = h
        .agents
        .release_actor_session(&child)
        .expect_err("a running session is not released");
    assert!(error.contains("still running"), "{error}");
    assert!(
        h.agents
            .core
            .live
            .get(&agent)
            .is_some_and(|entry| entry.is_live()),
        "the refused release leaves the running entry"
    );
}

/// Review finding 4: a finished turn's entry is removed by the release, and a second release is a no-op.
#[tokio::test]
async fn a_finished_actor_session_is_released_once_and_releasing_again_is_ok() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_done");
    create_child(h.store.as_ref(), &child, &parent).await;
    h.agents
        .run_actor_turn(run_for(&child, &parent), "do it", CancellationToken::new())
        .await;
    assert!(
        h.agents.core.live.get(&actor_entry_id(&child)).is_some(),
        "the finished turn leaves its entry"
    );
    h.agents
        .release_actor_session(&child)
        .expect("a finished session is released");
    assert!(h.agents.core.live.get(&actor_entry_id(&child)).is_none());
    h.agents
        .release_actor_session(&child)
        .expect("releasing again does nothing");
}

/// Counts the model requests an actor turn reports (the bridge's `askExecuting` source).
#[derive(Debug, Default)]
struct CountingRequests(std::sync::atomic::AtomicUsize);

impl crate::actor_turn::RequestNotify for CountingRequests {
    fn request_started(&self) {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Node `askExecuting`: each model request of an actor's turn reaches the turn's observer, once per request.
#[tokio::test]
async fn each_model_request_of_an_actor_turn_reaches_its_observer() {
    let h = harness(None);
    let parent = SessionId::new("ses_parent");
    let child = SessionId::new("sess_actor_child");
    create_child(h.store.as_ref(), &child, &parent).await;
    let requests = Arc::new(CountingRequests::default());
    let run = ActorRun {
        on_request: Some(requests.clone()),
        ..run_for(&child, &parent)
    };
    h.agents
        .run_actor_turn(run, "do it", CancellationToken::new())
        .await;
    assert_eq!(
        requests.0.load(std::sync::atomic::Ordering::SeqCst),
        h.seen.lock().expect("seen").len(),
        "one report per model request"
    );
    assert_eq!(requests.0.load(std::sync::atomic::Ordering::SeqCst), 1);
}
