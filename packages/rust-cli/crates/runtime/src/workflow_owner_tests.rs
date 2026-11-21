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

use super::{ActorBindingsPort, ParentBindings, RunWorld, bound_owner_factory};
use crate::actor_turns::ActorAgents;
use crate::workflow_assembly::ActorSessionRelease;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};
use serde_json::{Map, Value, json};

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

/// The agents a launched run's turns reach. It records each turn's bindings, waits `delay`, and answers with `reply`.
struct RecordingAgents {
    seen: Mutex<Vec<SeenRun>>,
    reply: String,
    delay: Duration,
    /// When set, a turn never answers: it ends only when its cancel is raised (the run is closed mid-ask).
    hang: bool,
}

impl RecordingAgents {
    fn replying(reply: &str) -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            reply: reply.to_owned(),
            delay: Duration::ZERO,
            hang: false,
        })
    }

    fn slow(reply: &str, delay: Duration) -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            reply: reply.to_owned(),
            delay,
            hang: false,
        })
    }

    fn hanging() -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(Vec::new()),
            reply: String::new(),
            delay: Duration::ZERO,
            hang: true,
        })
    }

    fn selections(&self) -> Vec<ModelSelection> {
        self.seen
            .lock()
            .expect("seen")
            .iter()
            .map(|turn| turn.selection.clone())
            .collect()
    }
}

#[async_trait]
impl ActorAgents for RecordingAgents {
    async fn run_actor_turn(
        &self,
        run: ActorRun,
        _prompt: &str,
        cancel: CancellationToken,
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
        if self.hang {
            cancel.cancelled().await;
            return ActorTurnEnd::Stopped;
        }
        tokio::time::sleep(self.delay).await;
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

/// The parent session `ses_p`: its current selection can change between launches and between actors. Any other
/// parent is unknown.
struct ParentFixture {
    selection: Mutex<Option<ModelSelection>>,
}

impl ParentFixture {
    fn with(selection: Option<ModelSelection>) -> Arc<Self> {
        Arc::new(Self {
            selection: Mutex::new(selection),
        })
    }

    fn set(&self, selection: Option<ModelSelection>) {
        *self.selection.lock().expect("selection") = selection;
    }
}

impl ActorBindingsPort for ParentFixture {
    fn parent_bindings(&self, parent: &str) -> Result<Option<ParentBindings>, String> {
        Ok((parent == "ses_p").then(|| ParentBindings {
            selection: self.selection.lock().expect("selection").clone(),
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/work"),
            },
            interactions: None,
        }))
    }
}

fn selection(provider: &str, model: &str) -> ModelSelection {
    ModelSelection::new(provider, model)
}

/// A run service over the bound factory. The parent's bindings come from `parent`, the turns reach `agents`.
fn bound_service(
    path: std::path::PathBuf,
    parent: Arc<ParentFixture>,
    agents: Arc<RecordingAgents>,
) -> (
    WorkflowRunService,
    Arc<FakeChildRunner>,
    Arc<SessionResidency>,
) {
    bound_service_with(path, parent, agents, None)
}

/// A run service over the bound factory with the host's world ports (9.61), or none.
fn bound_service_with(
    path: std::path::PathBuf,
    parent: Arc<ParentFixture>,
    agents: Arc<RecordingAgents>,
    world: Option<RunWorld>,
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
        parent,
        Arc::new(FixedClock(1_700_000_000_000)),
        world,
    );
    let service = WorkflowRunService::new(
        residency.clone(),
        Arc::new(NoGovernor),
        runner.clone(),
        factory,
    );
    (service, runner, residency)
}

/// A launch from `ses_p` with the given recorded fields.
fn launched(run_id: &str, fields: LaunchFields) -> EngineConfig {
    let mut config = config(run_id, Some("ses_p"));
    config.launch = Some(fields);
    config
}

/// The fields a launch records for a guarded run, with no model override.
fn guarded() -> LaunchFields {
    LaunchFields {
        subagent_permission_mode: Some("guarded".to_owned()),
        ..Default::default()
    }
}

/// The child creates actor `local` (with `persona`) and asks it once. Returns the ask's result.
async fn actor_asks(
    handler: &Arc<dyn ChildHandler>,
    local: &str,
    persona: Value,
    prompt: &str,
) -> std::result::Result<Value, WireError> {
    let create: CreateActor = serde_json::from_value(json!({
        "localId": local,
        "siteId": "plain",
        "name": persona.get("name").cloned().unwrap_or(Value::Null),
        "persona": persona,
    }))
    .expect("create-actor");
    let engine_id = handler
        .create_actor(&create)
        .await
        .expect("the actor is created");
    let ask: ChildRequest = serde_json::from_value(json!({
        "id": format!("r-{local}"),
        "type": "ask",
        "siteId": "plain",
        "actor": local,
        "prompt": prompt,
        "instructions": prompt,
    }))
    .expect("ask");
    handler.request(ask, Some(engine_id)).await
}

fn ada() -> Value {
    json!({"name": "Ada", "system": "Be terse."})
}

/// Starts Ada's ask on a turn that never answers, waits until the turn reached the agents, then closes the run
/// mid-ask. The journal keeps the actor and its resolved model, and the ask is not answered, so a resume runs it again.
async fn interrupt_mid_ask(
    service: &WorkflowRunService,
    handler: Arc<dyn ChildHandler>,
    agents: &RecordingAgents,
) {
    let pending = tokio::spawn(async move {
        let _ = actor_asks(&handler, "a1", ada(), "do it").await;
    });
    wait_until("the turn to reach the agents", || {
        agents.seen.lock().expect("seen").len() == 1
    })
    .await;
    let _ = service.close().await;
    let _ = pending.await;
}

/// The journaled `resolved_model` of the run's actors, by ordinal order.
fn journaled_models(path: &std::path::Path, run_id: &str) -> Vec<Option<String>> {
    let (conn, _) = rust_cli_node_store::open_session_database(path, Duration::from_secs(1), 0)
        .expect("reopened session database");
    dwf::list_actors(&conn, run_id)
        .expect("list the actors")
        .into_iter()
        .map(|actor| actor.resolved_model)
        .collect()
}

/// 9.33: a launched run's actor completes a turn under the parent's model and permission mode, with the parent's
/// workspace, the persona's system prompt and the run's admission. The scripted agents see those bindings.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_launched_run_actor_turn_runs_under_the_parent_model_and_permission_mode() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::replying("done");
    let (service, runner, residency) = bound_service(
        path,
        ParentFixture::with(Some(selection("acct-a", "ma"))),
        agents.clone(),
    );

    service
        .launch(input("wf_1"), launched("wf_1", guarded()))
        .await
        .expect("launched");
    let answer = actor_asks(&runner.launches()[0].handler, "a1", ada(), "do it").await;
    assert!(answer.is_ok(), "the actor's turn completes: {answer:?}");

    let seen = agents.seen.lock().expect("seen").clone();
    assert_eq!(seen.len(), 1, "the turn reached the agents once");
    let turn = &seen[0];
    assert_eq!(turn.parent, "ses_p");
    assert_eq!(
        turn.selection,
        selection("acct-a", "ma"),
        "the parent's model"
    );
    assert_eq!(
        turn.mode,
        PermissionMode::Guarded,
        "the recorded permission mode"
    );
    assert_eq!(turn.workspace_root, "/work", "the parent's workspace");
    assert_eq!(
        turn.persona,
        rust_cli_prompts::workflow_actor::identity(Some("Ada"), Some("Be terse.")),
        "the persona's identity prompt"
    );
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

/// 9.33 refusal, as Node refuses it: a parent with no model selection gives its actor none, so the actor's turn is
/// refused at its ask, and the agents never see it. The run itself is not refused at launch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_actor_whose_parent_has_no_model_selection_is_refused_at_its_ask() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::replying("done");
    let (service, runner, _residency) =
        bound_service(path, ParentFixture::with(None), agents.clone());

    service
        .launch(input("wf_2"), launched("wf_2", guarded()))
        .await
        .expect("launched");
    let answer = actor_asks(&runner.launches()[0].handler, "a1", ada(), "do it").await;
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

/// 9.33 finding 1: a resumed run (no launch fields in the config) keeps the permission mode its journal recorded, not
/// YOLO. Node reads the journal's run-launched mode on resume (`dynamic-workflow-run-launch.ts`).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resumed_run_keeps_the_mode_its_launch_recorded() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let parent = ParentFixture::with(Some(selection("acct-a", "ma")));
    let hanging = RecordingAgents::hanging();
    let (first, runner, _residency) = bound_service(path.clone(), parent.clone(), hanging.clone());
    first
        .launch(input("wf_r"), launched("wf_r", guarded()))
        .await
        .expect("launched");
    interrupt_mid_ask(&first, runner.launches()[0].handler.clone(), &hanging).await;

    let agents = RecordingAgents::replying("done");
    let (second, runner, _residency) = bound_service(path, parent, agents.clone());
    second
        .launch(input("wf_r"), config("wf_r", Some("ses_p")))
        .await
        .expect("resumed");
    actor_asks(&runner.launches()[0].handler, "a1", ada(), "do it")
        .await
        .expect("the resumed turn completes");
    let seen = agents.seen.lock().expect("seen").clone();
    assert_eq!(seen.len(), 1, "the resumed turn reached the agents");
    assert_eq!(
        seen[0].mode,
        PermissionMode::Guarded,
        "the journal's mode, not YOLO"
    );
    let _ = second.close().await;
}

/// 9.33 finding 2: an actor's model follows Node's order: the persona's model (through the run's bindings), then the
/// run's subagent model, then the parent's selection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_persona_model_wins_over_the_run_model_and_the_parent() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::replying("done");
    let (service, runner, _residency) = bound_service(
        path,
        ParentFixture::with(Some(selection("acct-a", "ma"))),
        agents.clone(),
    );
    let mut fields = guarded();
    fields.subagent_model = Some("acct-r/mr".to_owned());
    fields.model_bindings = Some(json!({"fast": "acct-x/glm-5.3$high"}));
    service
        .launch(input("wf_p"), launched("wf_p", fields))
        .await
        .expect("launched");
    let persona = json!({"name": "Ada", "system": "Be terse.", "model": "fast"});
    actor_asks(&runner.launches()[0].handler, "a1", persona, "do it")
        .await
        .expect("the turn completes");
    let mut expected = selection("acct-x", "glm-5.3");
    expected.reasoning = Some("high".to_owned());
    assert_eq!(agents.selections(), vec![expected], "the persona's model");
    let _ = service.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_run_model_wins_over_the_parent_when_the_persona_names_none() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::replying("done");
    let (service, runner, _residency) = bound_service(
        path,
        ParentFixture::with(Some(selection("acct-a", "ma"))),
        agents.clone(),
    );
    let mut fields = guarded();
    fields.subagent_model = Some("acct-r/mr".to_owned());
    service
        .launch(input("wf_q"), launched("wf_q", fields))
        .await
        .expect("launched");
    actor_asks(&runner.launches()[0].handler, "a1", ada(), "do it")
        .await
        .expect("the turn completes");
    assert_eq!(
        agents.selections(),
        vec![selection("acct-r", "mr")],
        "the run's model"
    );
    let _ = service.close().await;
}

/// 9.33 finding 2: a run model is an override, so an actor runs even when its parent has no selection.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_run_model_runs_an_actor_whose_parent_has_no_selection() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::replying("done");
    let (service, runner, _residency) =
        bound_service(path, ParentFixture::with(None), agents.clone());
    let mut fields = guarded();
    fields.subagent_model = Some("acct-r/mr".to_owned());
    service
        .launch(input("wf_o"), launched("wf_o", fields))
        .await
        .expect("launched");
    actor_asks(&runner.launches()[0].handler, "a1", ada(), "do it")
        .await
        .expect("the turn runs under the run's model");
    assert_eq!(agents.selections(), vec![selection("acct-r", "mr")]);
    let _ = service.close().await;
}

/// 9.33 finding 2: an actor's resolved model is journaled, and a resumed run keeps it (Node's pin) even when the parent
/// has since changed its model.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_resumed_actor_keeps_the_model_it_was_journaled_with() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let parent = ParentFixture::with(Some(selection("acct-a", "ma")));
    let hanging = RecordingAgents::hanging();
    let (first, runner, _residency) = bound_service(path.clone(), parent.clone(), hanging.clone());
    first
        .launch(input("wf_k"), launched("wf_k", guarded()))
        .await
        .expect("launched");
    interrupt_mid_ask(&first, runner.launches()[0].handler.clone(), &hanging).await;
    assert_eq!(
        journaled_models(&path, "wf_k"),
        vec![Some("acct-a/ma".to_owned())],
        "the actor's resolved model is journaled"
    );

    parent.set(Some(selection("acct-b", "mb")));
    let agents = RecordingAgents::replying("done");
    let (second, runner, _residency) = bound_service(path, parent, agents.clone());
    second
        .launch(input("wf_k"), config("wf_k", Some("ses_p")))
        .await
        .expect("resumed");
    actor_asks(&runner.launches()[0].handler, "a1", ada(), "do it")
        .await
        .expect("the resumed turn completes");
    assert_eq!(
        agents.selections(),
        vec![selection("acct-a", "ma")],
        "the journaled model"
    );
    let _ = second.close().await;
}

/// 9.33 finding 3: each actor resolves the parent's selection when its session is created, then keeps it. A change
/// between two actors reaches the second only.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_selection_change_reaches_the_next_actor_and_not_the_running_one() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::replying("done");
    let parent = ParentFixture::with(Some(selection("acct-a", "ma")));
    let (service, runner, _residency) = bound_service(path, parent.clone(), agents.clone());
    service
        .launch(input("wf_c"), launched("wf_c", guarded()))
        .await
        .expect("launched");
    let handler = runner.launches()[0].handler.clone();
    actor_asks(&handler, "a1", ada(), "first")
        .await
        .expect("the first actor completes");
    parent.set(Some(selection("acct-b", "mb")));
    actor_asks(
        &handler,
        "a2",
        json!({"name": "Bob", "system": "Be wordy."}),
        "second",
    )
    .await
    .expect("the second actor completes");
    assert_eq!(
        agents.selections(),
        vec![selection("acct-a", "ma"), selection("acct-b", "mb")],
        "the first actor keeps its model; the second takes the change"
    );
    let _ = service.close().await;
}

/// 9.33 finding 3: a parent with no selection refuses only the actors created while it has none. Once the parent
/// has one, a later actor runs.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_absent_selection_refuses_only_the_actors_created_before_it_is_set() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::replying("done");
    let parent = ParentFixture::with(None);
    let (service, runner, _residency) = bound_service(path, parent.clone(), agents.clone());
    service
        .launch(input("wf_m"), launched("wf_m", guarded()))
        .await
        .expect("launched");
    let handler = runner.launches()[0].handler.clone();
    let refused = actor_asks(&handler, "a1", ada(), "first").await;
    assert!(refused.is_err(), "the actor with no selection is refused");
    parent.set(Some(selection("acct-a", "ma")));
    actor_asks(
        &handler,
        "a2",
        json!({"name": "Bob", "system": "Be wordy."}),
        "second",
    )
    .await
    .expect("the later actor runs");
    assert_eq!(agents.selections(), vec![selection("acct-a", "ma")]);
    let _ = service.close().await;
}

/// 9.33 finding 4: two actors whose turns overlap each run under their own persona prompt.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_overlapping_actors_each_keep_their_own_persona() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::slow("done", Duration::from_millis(60));
    let (service, runner, _residency) = bound_service(
        path,
        ParentFixture::with(Some(selection("acct-a", "ma"))),
        agents.clone(),
    );
    service
        .launch(input("wf_o2"), launched("wf_o2", guarded()))
        .await
        .expect("launched");
    let handler = runner.launches()[0].handler.clone();
    let bob = json!({"name": "Bob", "system": "Be wordy."});
    let (first, second) = tokio::join!(
        actor_asks(&handler, "a1", ada(), "first"),
        actor_asks(&handler, "a2", bob, "second"),
    );
    first.expect("Ada completes");
    second.expect("Bob completes");
    let mut prompts: Vec<(String, String)> = agents
        .seen
        .lock()
        .expect("seen")
        .iter()
        .map(|turn| (turn.description.clone(), turn.persona.clone()))
        .collect();
    prompts.sort();
    assert_eq!(prompts.len(), 2, "both turns reached the agents");
    assert!(prompts[0].0.starts_with("Ada ("), "{}", prompts[0].0);
    // The persona is the workflow subagent identity (Node `buildWorkflowActorIdentitySection`): the opening names the
    // actor, then the persona text.
    assert_eq!(
        prompts[0].1,
        rust_cli_prompts::workflow_actor::identity(Some("Ada"), Some("Be terse.")),
        "Ada's persona"
    );
    assert!(prompts[1].0.starts_with("Bob ("), "{}", prompts[1].0);
    assert_eq!(
        prompts[1].1,
        rust_cli_prompts::workflow_actor::identity(Some("Bob"), Some("Be wordy.")),
        "Bob's persona"
    );
    let _ = service.close().await;
}

/// 9.33 review round 3: an amend-resume's first live dispatch has no pin of its own, so the actor keeps the model its
/// predecessor journaled (the seed's pin, Node `currentRunPin ?? seed?.resolvedModel`), not the parent's current model.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_amended_actor_keeps_its_predecessors_model_over_the_parents() {
    use rust_cli_workflow::imported_cache::{
        ImportedActorCandidate, ImportedInFlightAsk, ImportedRunCache,
    };
    use rust_cli_workflow::persona::normalize_persona;
    use rust_cli_workflow::scheduler::input_hash;

    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let agents = RecordingAgents::replying("done");
    let parent = ParentFixture::with(Some(selection("acct-b", "mb")));
    let (service, runner, _residency) = bound_service(path, parent, agents.clone());

    let candidate = ImportedActorCandidate {
        persona: normalize_persona(Some("Ada"), Some(&ada())),
        entries: Vec::new(),
        in_flight: Some(ImportedInFlightAsk {
            input_hash: input_hash("do it"),
            message_boundary: 0,
        }),
        transcript_source_session_id: "ses_p".to_owned(),
        resolved_model: Some("acct-a/ma".to_owned()),
    };
    let mut config = launched("wf_am", guarded());
    config.imported_cache = Some(ImportedRunCache {
        actors: std::collections::BTreeMap::from([("Ada".to_owned(), candidate)]),
        world: Default::default(),
    });
    service
        .launch(input("wf_am"), config)
        .await
        .expect("launched");
    actor_asks(&runner.launches()[0].handler, "a1", ada(), "do it")
        .await
        .expect("the amended turn completes");
    assert_eq!(
        agents.selections(),
        vec![selection("acct-a", "ma")],
        "the predecessor's pinned model, not the parent's current one"
    );
    let _ = service.close().await;
}

/// The world read port of the run tests: a glob answers the files it was built with, and it records the root it was
/// asked at.
struct GlobRoots {
    asked: Mutex<Vec<std::path::PathBuf>>,
}

struct GlobPort;

impl rust_cli_workflow::world_read::WorldReadPorts for GlobPort {
    fn glob(
        &self,
        _pattern: &str,
        _limit: usize,
    ) -> Result<rust_cli_workflow::world_read::GlobHits, String> {
        Ok(rust_cli_workflow::world_read::GlobHits {
            files: vec!["a.md".to_owned()],
            total: 1,
        })
    }

    fn read_text(&self, _path: &str) -> Result<String, String> {
        Err("read is not used here".to_owned())
    }

    fn grep(
        &self,
        _pattern: &str,
        _glob: Option<&str>,
        _head_limit: usize,
    ) -> Result<rust_cli_workflow::world_read::GrepHits, String> {
        Err("grep is not used here".to_owned())
    }

    fn run(
        &self,
        _request: &rust_cli_workflow::world_read::RunRequest,
    ) -> Result<rust_cli_workflow::world_read::RunOutcome, String> {
        Err("run is not used here".to_owned())
    }
}

impl rust_cli_workflow::world_read::WorldReadRoots for GlobRoots {
    fn at(&self, root: &Path) -> Arc<dyn rust_cli_workflow::world_read::WorldReadPorts> {
        self.asked.lock().expect("asked").push(root.to_path_buf());
        Arc::new(GlobPort)
    }
}

struct NoArtifactFs;

impl rust_cli_workflow::artifact_publish::ArtifactFsPort for NoArtifactFs {
    fn read_file(
        &self,
        _path: &Path,
        _max_bytes: usize,
    ) -> Result<Vec<u8>, rust_cli_workflow::artifact_publish::FsFault> {
        Err(rust_cli_workflow::artifact_publish::FsFault::NotFound)
    }

    fn real_path(
        &self,
        _path: &Path,
    ) -> Result<std::path::PathBuf, rust_cli_workflow::artifact_publish::FsFault> {
        Err(rust_cli_workflow::artifact_publish::FsFault::NotFound)
    }
}

/// Fork (9.61): a run launched through the bound factory reaches the host's world ports. Before, nothing attached them,
/// so a script's world read never settled and the desktop run stayed on its running node.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bound_run_world_read_reaches_the_hosts_ports_at_the_run_cwd() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = database(dir.path());
    let roots = Arc::new(GlobRoots {
        asked: Mutex::new(Vec::new()),
    });
    let world = RunWorld {
        roots: roots.clone(),
        fs: Arc::new(NoArtifactFs),
        store: None,
        now_ms: || 7,
    };
    let (service, runner, _residency) = bound_service_with(
        path,
        ParentFixture::with(Some(selection("acct-a", "ma"))),
        RecordingAgents::replying("done"),
        Some(world),
    );
    let mut config = launched("wf_w", guarded());
    config.cwd = Some("/work/run".to_owned());
    service
        .launch(input("wf_w"), config)
        .await
        .expect("launched");
    let read: ChildRequest = serde_json::from_value(json!({
        "id": "r-glob",
        "type": "world-read",
        "siteId": "files",
        "op": "glob",
        "args": ["*.md"],
    }))
    .expect("world read");
    let answer = tokio::time::timeout(
        Duration::from_secs(5),
        runner.launches()[0].handler.request(read, None),
    )
    .await
    .expect("the world read settles");
    let value = answer.expect("the world read is answered by the host port");
    assert_eq!(value, json!(["a.md"]), "{value}");
    assert_eq!(
        roots.asked.lock().expect("asked").clone(),
        vec![std::path::PathBuf::from("/work/run")],
        "the ports are rooted at the run's cwd"
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
