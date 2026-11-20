//! Tests of the production owner assembly (9.30). The owner is the real one over a real temp session database; the child
//! is `FakeChildRunner`. The integration test is one launch that completes through the whole assembly.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_child::{Completion, LaunchInput, Outcome};
use rust_cli_node_store::dwf::{self, RunStatus};
use rust_cli_workflow::engine::{AskSpec, EngineConfig};
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};
use serde_json::{Map, json};

use super::{OwnerStores, UnwiredRelease, UnwiredTurns, production_owner_factory};
use crate::workflow_run::WorkflowRunService;

/// The governor is not part of the owner assembly; the run's bound is a no-op here.
struct NoGovernor;

impl RunConcurrency for NoGovernor {
    fn set_run_bound(&self, _run_id: &str, _bound: u64) {}
    fn clear_run_bound(&self, _run_id: &str) {}
    fn subscribe(&self, _run_id: &str, _listener: ConcurrencyListener) -> Box<dyn FnOnce() + Send> {
        Box::new(|| {})
    }
}

fn clock() -> i64 {
    42
}

/// A session database with Node's migrations, and the parent session a run is launched from.
fn database(dir: &Path) -> std::path::PathBuf {
    let path = dir.join("sessions.db");
    let (conn, _) = rust_cli_node_store::open_session_database(&path, Duration::from_secs(1), 0)
        .expect("session database");
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values ('ses_p', 'proj', null, 'ses_p', '/work', 'title', '0.0.0', 1, 1)",
        [],
    )
    .expect("parent session row");
    path
}

fn stores(path: std::path::PathBuf) -> OwnerStores {
    OwnerStores {
        database: path,
        directory: "/work".to_owned(),
        version: "0.0.0".to_owned(),
        clock,
    }
}

fn config(run_id: &str, parent: Option<&str>) -> EngineConfig {
    let mut config = EngineConfig {
        run_id: run_id.to_owned(),
        parent_session_id: parent.map(str::to_owned),
        ..Default::default()
    };
    config.caps.max_concurrency = 4.0;
    config.ask_specs.insert(
        "plain".into(),
        AskSpec {
            typed: false,
            schema: None,
        },
    );
    config
}

fn input(run_id: &str) -> LaunchInput {
    LaunchInput {
        script_text: "return 1".to_owned(),
        run_id: run_id.to_owned(),
        args: Some(Map::new()),
        resumed_from: None,
        cwd: std::path::PathBuf::from("/work"),
    }
}

async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Integration (9.30): the production assembly launches a run through a fake child, the child completes, and the
/// settlement is in the real SQLite journal. Nothing is mocked below the child runner.
#[tokio::test]
async fn a_launch_completes_through_the_production_assembly_over_a_real_journal() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let runner = Arc::new(FakeChildRunner::new());
    let residency = Arc::new(SessionResidency::new());
    let factory = production_owner_factory(
        stores(path.clone()),
        Arc::new(UnwiredTurns),
        Arc::new(UnwiredRelease),
    );
    let service = WorkflowRunService::new(
        residency.clone(),
        Arc::new(NoGovernor),
        runner.clone(),
        factory,
    );

    service
        .launch(input("wf_1"), config("wf_1", Some("ses_p")))
        .await
        .expect("launched");
    assert_eq!(runner.launches().len(), 1, "the child started once");
    assert_eq!(
        residency.live_runs("ses_p"),
        1,
        "the run keeps its parent resident"
    );

    runner.finish(
        0,
        Outcome::Completed(Completion {
            ok: true,
            value: Some(json!("done")),
            error: None,
        }),
    );
    wait_until("the run to settle", || service.run_count() == 0).await;
    assert_eq!(
        residency.live_runs("ses_p"),
        0,
        "the settled run releases its parent"
    );

    let (conn, _) = rust_cli_node_store::open_session_database(&path, Duration::from_secs(1), 0)
        .expect("reopened session database");
    let run = dwf::get_run(&conn, "wf_1")
        .expect("read the run")
        .expect("the run row was journaled");
    assert_eq!(
        run.status,
        RunStatus::Completed,
        "the completion is journaled"
    );
    assert_eq!(run.result, Some(json!("done")), "the result is journaled");

    let report = service.close().await;
    assert_eq!(report.stopped, 0, "nothing is left to stop");
    assert!(report.stuck.is_empty());
}

/// 9.30 item 2: the turn side is refused until the agents' bindings are wired, and the release likewise. The refusal
/// names what is missing, so a child's ask fails with a reason rather than hanging.
#[test]
fn the_unwired_turn_side_refuses_its_turns_and_its_releases() {
    use rust_cli_workflow::actor_turns::{TurnInput, TurnRunner};
    use std::sync::atomic::AtomicBool;

    let turn = UnwiredTurns;
    let input = TurnInput {
        text: "go".to_owned(),
        epilogue_start: 0,
        submit_schema: None,
    };
    let failure = turn
        .run_turn("ses_a", "worker", &input, &AtomicBool::new(false))
        .expect_err("a turn is refused");
    assert!(failure.message.contains("not wired"), "{}", failure.message);

    use crate::workflow_assembly::ActorSessionRelease;
    let error = UnwiredRelease
        .release_actor_session(&rust_cli_kernel_api::ids::SessionId::new("ses_a"))
        .expect_err("a release is refused");
    assert!(error.contains("not wired"), "{error}");
}
