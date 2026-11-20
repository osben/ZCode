//! Tests of the production owner assembly (9.30). The owner is the real one over a real temp session database; the child
//! is `FakeChildRunner`. The integration test is one launch that completes through the whole assembly.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use rust_cli_agents::actor_turn::{ActorRun, ActorTurnEnd, ActorTurnStats};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::{FakeChildRunner, FixedClock};
use rust_cli_kernel_api::workflow_child::{
    ChildHandler, ChildRequest, Completion, CreateActor, LaunchInput, Outcome, WireError,
};
use rust_cli_node_store::dwf::{self, RunStatus};
use rust_cli_workflow::engine::{AskSpec, EngineConfig};
use rust_cli_workflow::event::LaunchFields;
use rust_cli_workflow::residency::SessionResidency;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::{ActorBindingsPort, ParentBindings, bound_owner_factory};
use crate::actor_turns::ActorAgents;
use crate::workflow_assembly::ActorSessionRelease;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};
use serde_json::{Map, json};

use super::{OwnerStores, UnwiredRelease, UnwiredTurns, ledger_ms, production_owner_factory};
use crate::workflow_run::WorkflowRunService;

/// Review of #586 (ocr, finding 2): one clock convention. A reading before the epoch is zero in the ledger; a positive
/// reading is itself.
#[test]
fn a_clock_reading_before_the_epoch_is_read_as_zero_in_the_ledger() {
    assert_eq!(ledger_ms(-5), 0);
    assert_eq!(ledger_ms(0), 0);
    assert_eq!(ledger_ms(1_700_000_000_000), 1_700_000_000_000);
}

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

// ---- W7-5d (9.33): a launched run's actor turns carry the parent's bindings ----

/// What a scripted turn saw of its run: the bindings the turn side passed to the agents.
#[derive(Debug, Clone, PartialEq)]
struct SeenRun {
    parent: String,
    selection: ModelSelection,
    mode: PermissionMode,
    workspace_root: String,
    persona: String,
    admission_run: Option<String>,
    description: String,
}

/// The agents a launched run's turns reach. It records each turn's bindings and answers with `reply`.
struct RecordingAgents {
    seen: Mutex<Vec<SeenRun>>,
    reply: String,
}

impl RecordingAgents {
    fn replying(reply: &str) -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            reply: reply.to_owned(),
        })
    }
}

#[async_trait]
impl ActorAgents for RecordingAgents {
    async fn run_actor_turn(
        &self,
        run: ActorRun,
        _prompt: &str,
        _cancel: CancellationToken,
    ) -> ActorTurnEnd {
        self.seen.lock().expect("seen").push(SeenRun {
            parent: run.parent.as_str().to_owned(),
            selection: run.selection.clone(),
            mode: run.mode,
            workspace_root: run.workspace.root.as_str().to_owned(),
            persona: run.persona_prompt.clone(),
            admission_run: run.admission_run.as_ref().map(|id| id.as_str().to_owned()),
            description: run.interaction_description.clone(),
        });
        ActorTurnEnd::Text(self.reply.clone())
    }

    fn turn_messages(&self, _child: &SessionId) -> Option<u64> {
        Some(0)
    }

    fn actor_turn_stats(&self, _child: &SessionId) -> Option<ActorTurnStats> {
        None
    }
}

impl ActorSessionRelease for RecordingAgents {
    fn release_actor_session(&self, _child: &SessionId) -> std::result::Result<(), String> {
        Ok(())
    }
}

/// The parent session `ses_p` has this selection and the app's workspace; any other parent is unknown.
struct ParentFixture {
    selection: Option<ModelSelection>,
}

impl ActorBindingsPort for ParentFixture {
    fn parent_bindings(&self, parent: &str) -> Option<ParentBindings> {
        (parent == "ses_p").then(|| ParentBindings {
            selection: self.selection.clone(),
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/work"),
            },
            interactions: None,
        })
    }
}

fn parent_selection() -> ModelSelection {
    ModelSelection::new("account:bigmodel-team-coding-plan", "glm-5.3")
}

/// A run service over the bound factory: the parent's bindings come from `selection`, and the turns reach `agents`.
fn bound_service(
    path: std::path::PathBuf,
    selection: Option<ModelSelection>,
    agents: Arc<RecordingAgents>,
) -> (
    WorkflowRunService,
    Arc<FakeChildRunner>,
    Arc<SessionResidency>,
) {
    let runner = Arc::new(FakeChildRunner::new());
    let residency = Arc::new(SessionResidency::new());
    let factory = bound_owner_factory(
        stores(path),
        agents,
        tokio::runtime::Handle::current(),
        Arc::new(ParentFixture { selection }),
        Arc::new(FixedClock(1_700_000_000_000)),
    );
    let service = WorkflowRunService::new(
        residency.clone(),
        Arc::new(NoGovernor),
        runner.clone(),
        factory,
    );
    (service, runner, residency)
}

/// The launch config of a run from `ses_p`, with the subagent permission mode the launch recorded.
fn bound_config(run_id: &str) -> EngineConfig {
    let mut config = config(run_id, Some("ses_p"));
    config.launch = Some(LaunchFields {
        subagent_permission_mode: Some("guarded".to_owned()),
        ..Default::default()
    });
    config
}

/// The child's `create-actor`, then one `ask` on that actor, as the child sends them. Returns the ask's result.
async fn child_asks_once(
    handler: Arc<dyn ChildHandler>,
) -> std::result::Result<serde_json::Value, WireError> {
    let create: CreateActor = serde_json::from_value(json!({
        "localId": "a1",
        "siteId": "plain",
        "name": "Ada",
        "persona": {"name": "Ada", "system": "Be terse."},
    }))
    .expect("create-actor");
    let engine_id = handler
        .create_actor(&create)
        .await
        .expect("the actor is created");
    let ask: ChildRequest = serde_json::from_value(json!({
        "id": "r1",
        "type": "ask",
        "siteId": "plain",
        "actor": "a1",
        "prompt": "do it",
    }))
    .expect("ask");
    handler.request(ask, Some(engine_id)).await
}

/// 9.33: a launched run's actor completes a turn under the parent's model and permission mode, with the parent's
/// workspace, the persona's system prompt and the run's admission. The scripted agents see those bindings.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_launched_run_actor_turn_runs_under_the_parent_model_and_permission_mode() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::replying("done");
    let (service, runner, residency) =
        bound_service(path, Some(parent_selection()), agents.clone());

    service
        .launch(input("wf_1"), bound_config("wf_1"))
        .await
        .expect("launched");
    let answer = child_asks_once(runner.launches()[0].handler.clone()).await;
    assert!(answer.is_ok(), "the actor's turn completes: {answer:?}");

    let seen = agents.seen.lock().expect("seen").clone();
    assert_eq!(seen.len(), 1, "the turn reached the agents once");
    let turn = &seen[0];
    assert_eq!(turn.parent, "ses_p");
    assert_eq!(turn.selection, parent_selection(), "the parent's model");
    assert_eq!(
        turn.mode,
        PermissionMode::Guarded,
        "the recorded permission mode"
    );
    assert_eq!(turn.workspace_root, "/work", "the parent's workspace");
    assert_eq!(turn.persona, "Be terse.", "the persona's system prompt");
    assert_eq!(
        turn.admission_run.as_deref(),
        Some("wf_1"),
        "admitted under the run"
    );
    assert!(
        turn.description.starts_with("Ada ("),
        "{}",
        turn.description
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
    let report = service.close().await;
    assert!(report.stuck.is_empty());
    assert!(
        report.close_failures.is_empty(),
        "{:?}",
        report.close_failures
    );
}

/// 9.33 refusal, as Node refuses it: a parent with no model selection gives its children none, so the actor's turn is
/// refused at its ask, and the agents never see the turn. The run itself is not refused at launch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_actor_whose_parent_has_no_model_selection_is_refused_at_its_ask() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::replying("done");
    let (service, runner, _residency) = bound_service(path, None, agents.clone());

    service
        .launch(input("wf_2"), bound_config("wf_2"))
        .await
        .expect("launched");
    let answer = child_asks_once(runner.launches()[0].handler.clone()).await;
    let error = answer.expect_err("the ask is refused");
    assert!(
        error.message.contains("model selection"),
        "the refusal names the missing selection: {}",
        error.message
    );
    assert!(
        agents.seen.lock().expect("seen").is_empty(),
        "no turn reached the agents"
    );

    runner.finish(
        0,
        Outcome::Completed(Completion {
            ok: true,
            value: None,
            error: None,
        }),
    );
    wait_until("the run to settle", || service.run_count() == 0).await;
    let _ = service.close().await;
}
