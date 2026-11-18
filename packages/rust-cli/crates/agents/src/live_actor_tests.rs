//! `Live::begin_actor_run` (W6a part 2c-2b-2 review follow-up): the first run of a fresh actor, a run begun on an existing
//! entry, and the typed outcome.
use crate::actor_turn::ActorRun;
use crate::live::{BeginActorRun, Live, LiveAgent};
use crate::report::Ending;
use crate::test_support::workspace;
use rust_cli_base::models::GLM_5_3_ACCOUNT;
use rust_cli_kernel_api::ids::{AgentId, SessionId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::panels::SubagentStatus;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::FixedClock;
use std::sync::Arc;

fn live_at(now: u64) -> Live {
    Live::new(Arc::new(FixedClock(now)))
}

fn run(child: &str) -> ActorRun {
    ActorRun {
        child: SessionId::new(child),
        parent: SessionId::new("ses_parent"),
        interaction_description: "Ada (site@1)".to_owned(),
        interactions: None,
        port: None,
        persona_prompt: "You are a workflow actor.".to_owned(),
        workspace: workspace(),
        selection: ModelSelection::new("account:bigmodel-team-coding-plan", GLM_5_3_ACCOUNT),
        mode: PermissionMode::Default,
    }
}

/// Begin a run for the actor whose live entry is keyed by `id`, building a fresh entry when there is none.
fn begin(live: &Live, id: &AgentId, child: &str) -> BeginActorRun {
    live.begin_actor_run(
        id,
        || LiveAgent::for_actor(run(child), id.clone(), SessionId::new("ses_parent")),
        |_| {},
        "execution-1".to_owned(),
    )
}

#[test]
fn a_later_turn_refreshes_the_origin_and_the_asks_of_the_existing_entry() {
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    begin(&live, &id, "sess_a");
    live.finish(&id, Ending::Completed);
    // The second turn brings a different origin (as a changed persona name would) and no asks channel.
    let started = live.begin_actor_run(
        &id,
        || unreachable!("the entry exists"),
        |entry| {
            entry.description = "Bea (site@1)".to_owned();
            entry.asks = None;
        },
        "execution-2".to_owned(),
    );
    assert_eq!(started, BeginActorRun::Started);
    let entry = live.get(&id).expect("the entry exists");
    assert_eq!(entry.description, "Bea (site@1)");
    assert!(entry.asks.is_none());
}

#[test]
fn a_refused_start_does_not_refresh_the_running_entry() {
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    begin(&live, &id, "sess_a");
    let refused = live.begin_actor_run(
        &id,
        || unreachable!("the entry exists"),
        |entry| entry.description = "changed while running".to_owned(),
        "execution-2".to_owned(),
    );
    assert_eq!(refused, BeginActorRun::AlreadyRunning);
    assert_eq!(
        live.get(&id).expect("the entry exists").description,
        "Ada (site@1)"
    );
}

#[test]
fn the_first_run_of_a_fresh_actor_publishes_no_previous_status() {
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    assert_eq!(begin(&live, &id, "sess_a"), BeginActorRun::Started);
    let entry = live.get(&id).expect("the entry exists");
    assert!(
        entry.shown.previous.is_none(),
        "a fresh actor has no previous run to report, got {:?}",
        entry.shown.previous
    );
}

#[test]
fn a_second_run_publishes_the_previous_run_status() {
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    begin(&live, &id, "sess_a");
    live.finish(&id, Ending::Completed);
    assert_eq!(begin(&live, &id, "sess_a"), BeginActorRun::Started);
    assert_eq!(
        live.get(&id).expect("the entry exists").shown.previous,
        Some(SubagentStatus::Completed)
    );
}

#[test]
fn a_run_begun_on_an_existing_entry_clears_stopped_by_user() {
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    begin(&live, &id, "sess_a");
    live.finish(&id, Ending::KilledByUser);
    live.with(|agents| {
        agents
            .get_mut(&id)
            .expect("the entry exists")
            .stopped_by_user = true;
    });
    assert_eq!(begin(&live, &id, "sess_a"), BeginActorRun::Started);
    assert!(
        !live.get(&id).expect("the entry exists").stopped_by_user,
        "a new run clears the stop flag, as a restart does"
    );
}

#[test]
fn a_begin_on_a_running_entry_reports_already_running_and_leaves_it_running() {
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    begin(&live, &id, "sess_a");
    assert_eq!(begin(&live, &id, "sess_a"), BeginActorRun::AlreadyRunning);
    assert!(live.get(&id).expect("the entry exists").is_live());
}

#[test]
fn the_first_run_is_stamped_with_the_clock() {
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    begin(&live, &id, "sess_a");
    assert_eq!(
        live.get(&id).expect("the entry exists").shown.started_ms,
        42
    );
}

#[test]
fn an_actor_is_denied_the_tools_node_denies_its_subagents() {
    // Node `workflowActorToolPolicy` (`ACTOR_DISALLOWED_TOOLS`): the plan pair (nobody approves in a headless child),
    // the questions to the user (an actor escalates through `escalate`; only the main session answers), the meta tools
    // that would let an actor submit or amend another workflow, and the topic resource.
    let entry = LiveAgent::for_actor(
        run("sess_a"),
        AgentId::new("actor-sess_a"),
        SessionId::new("ses_parent"),
    );
    assert_eq!(
        entry.definition.disallowed_tools,
        crate::actor_turn::WORKFLOW_ACTOR_DISALLOWED_TOOLS
            .iter()
            .map(|tool| (*tool).to_owned())
            .collect::<Vec<_>>()
    );
    assert_eq!(
        crate::actor_turn::WORKFLOW_ACTOR_DISALLOWED_TOOLS,
        [
            "AskUserQuestion",
            "EnterPlanMode",
            "ExitPlanMode",
            "CreateWorkflow",
            "AmendWorkflow",
            "ReadTopicResource",
            "ResolveWorkflowQuestion",
        ]
    );
}

/// A submit port that is never asked to submit: these tests look at which port an entry holds.
struct NoSubmit;

#[async_trait::async_trait]
impl crate::actor_turn::ActorPort for NoSubmit {
    async fn submit(
        &self,
        _result: serde_json::Value,
    ) -> Result<crate::actor_turn::ActorSubmit, String> {
        Err("not under test".to_owned())
    }

    async fn escalate(
        &self,
        _question: crate::actor_turn::ActorQuestion,
    ) -> Result<crate::actor_turn::ActorEscalation, String> {
        Err("not under test".to_owned())
    }
}

/// An entry begun for a turn that holds `port`.
fn begun_with_port(live: &Live, id: &AgentId, port: &Arc<dyn crate::actor_turn::ActorPort>) {
    live.begin_actor_run(
        id,
        || {
            let mut entry =
                LiveAgent::for_actor(run("sess_a"), id.clone(), SessionId::new("ses_parent"));
            entry.actor_port = Some(crate::actor_turn::SubmitPort {
                port: port.clone(),
                submit_schema: None,
            });
            entry
        },
        |_| {},
        "execution-1".to_owned(),
    );
}

#[test]
fn the_next_turns_port_survives_the_previous_turns_end() {
    // A turn's end clears its own port in the same lock section as its finish. A later turn that begins after that end
    // installs its port, and nothing from the earlier turn can clear it afterwards.
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    let first: Arc<dyn crate::actor_turn::ActorPort> = Arc::new(NoSubmit);
    let second: Arc<dyn crate::actor_turn::ActorPort> = Arc::new(NoSubmit);
    begun_with_port(&live, &id, &first);
    live.finish_actor_turn(&id, Ending::Completed);
    assert!(
        live.get(&id).expect("the entry").actor_port.is_none(),
        "the turn's end clears its port"
    );
    live.begin_actor_run(
        &id,
        || unreachable!("the entry exists"),
        |entry| {
            entry.actor_port = Some(crate::actor_turn::SubmitPort {
                port: second.clone(),
                submit_schema: None,
            })
        },
        "execution-2".to_owned(),
    );
    let entry = live.get(&id).expect("the entry");
    assert!(
        Arc::ptr_eq(
            &entry
                .actor_port
                .as_ref()
                .expect("the second turn's port")
                .port,
            &second
        ),
        "the second turn keeps the port it installed"
    );
}

#[test]
fn a_restart_offers_no_submit_port() {
    // A resume (SendMessage) is never a workflow turn, so it must not keep or offer a turn's submit port.
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    let port: Arc<dyn crate::actor_turn::ActorPort> = Arc::new(NoSubmit);
    begun_with_port(&live, &id, &port);
    live.finish_actor_turn(&id, Ending::Completed);
    let restarted = live.restart(
        &id,
        rust_cli_kernel_api::abort::Abort::new(),
        None,
        "execution-2".to_owned(),
        None,
    );
    assert!(restarted.is_some(), "the finished actor restarts");
    assert!(
        live.get(&id).expect("the entry").actor_port.is_none(),
        "a restarted entry holds no submit port"
    );
}

#[test]
fn a_later_turns_port_refresh_replaces_the_submit_schema() {
    // Each turn's begin refreshes the entry's port, schema included: a mono turn's schema is not carried into a later one.
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    let first: Arc<dyn crate::actor_turn::ActorPort> = Arc::new(NoSubmit);
    let first_schema = serde_json::json!({"type": "object", "required": ["first"]});
    live.begin_actor_run(
        &id,
        || {
            let mut entry =
                LiveAgent::for_actor(run("sess_a"), id.clone(), SessionId::new("ses_parent"));
            entry.actor_port = Some(crate::actor_turn::SubmitPort {
                port: first.clone(),
                submit_schema: Some(first_schema.clone()),
            });
            entry
        },
        |_| {},
        "execution-1".to_owned(),
    );
    live.finish_actor_turn(&id, Ending::Completed);
    let second: Arc<dyn crate::actor_turn::ActorPort> = Arc::new(NoSubmit);
    live.begin_actor_run(
        &id,
        || unreachable!("the entry exists"),
        |entry| {
            entry.actor_port = Some(crate::actor_turn::SubmitPort {
                port: second.clone(),
                submit_schema: None,
            });
        },
        "execution-2".to_owned(),
    );
    let schema = live
        .get(&id)
        .expect("the entry")
        .actor_port
        .as_ref()
        .expect("the second turn's port")
        .submit_schema
        .clone();
    assert_eq!(
        schema, None,
        "the second turn's refresh replaces the first's schema"
    );
}

// The invariant is a debug_assert, so the test exists only where debug assertions are compiled in.
#[cfg(debug_assertions)]
#[test]
#[should_panic(expected = "keyed by the id it was begun under")]
fn a_fresh_entry_keyed_by_another_id_is_a_programming_error() {
    let live = live_at(42);
    let id = AgentId::new("actor-sess_a");
    let _ = live.begin_actor_run(
        &id,
        || {
            LiveAgent::for_actor(
                run("sess_a"),
                AgentId::new("actor-other"),
                SessionId::new("ses_parent"),
            )
        },
        |_| {},
        "execution-1".to_owned(),
    );
}

#[test]
fn the_actor_entry_carries_the_interaction_description_as_its_origin_description() {
    // `ChildSink::with_origin` reads the entry's description, so the entry must hold the interaction description, not the
    // session title. Node names the asking actor by its persona and instance: `<persona> (<site>@<ordinal>)`.
    let entry = LiveAgent::for_actor(
        run("sess_a"),
        AgentId::new("actor-sess_a"),
        SessionId::new("ses_parent"),
    );
    assert_eq!(entry.description, "Ada (site@1)");
}
