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
