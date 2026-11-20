//! Tests of the run service's composition (9.30, 9.34). The gate is off: with no child runner there is no service, and with
//! one the service holds no run and opens nothing until a run is launched.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_child::{Completion, LaunchInput, Outcome};
use rust_cli_kernel_api::workflow_run::WorkflowRunHost;
use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use rust_cli_workflow::engine::EngineConfig;
use rust_cli_workflow::residency::SessionResidency;
use serde_json::{Map, Value, json};

use rust_cli_node_store::dwf::{self, RunRecord, RunStatus};
use rust_cli_node_store::{MIGRATION_LOCK_WAIT, open_session_database};

use super::build;

#[test]
fn a_run_source_whose_service_is_gone_reports_no_live_runs() {
    // Fork (W7-11, 9.44, ocr round 2): the source holds the service weakly; once it is gone no run is live and none owes.
    use rust_cli_protocol_zcode::RunDecisionsSource;
    let gone = super::ServiceRunDecisions(std::sync::Weak::new());
    assert!(gone.live_run_ids("ses_p").is_empty());
    assert!(matches!(gone.open("ses_p", "wf_live"), Ok(None)));
}

use async_trait::async_trait;
use rust_cli_agents::actor_turn::{ActorRun, ActorTurnEnd, ActorTurnStats};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::workflow_child::{ChildHandler, ChildRequest, CreateActor, WireError};
use rust_cli_runtime::actor_turns::ActorAgents;
use rust_cli_runtime::workflow_assembly::ActorSessionRelease;
use rust_cli_runtime::workflow_owner::{ActorBindingsPort, ParentBindings, record_parent_mode};
use rust_cli_workflow::engine::AskSpec;
use tokio_util::sync::CancellationToken;

/// The agents a composed run's turns reach. Each turn records the bindings it ran under and answers "done".
#[derive(Default)]
struct FakeAgents {
    seen: Mutex<Vec<(String, ModelSelection, PermissionMode)>>,
}

#[async_trait]
impl ActorAgents for FakeAgents {
    async fn run_actor_turn(
        &self,
        run: ActorRun,
        _prompt: &str,
        _cancel: CancellationToken,
    ) -> ActorTurnEnd {
        self.seen.lock().expect("seen").push((
            run.parent.as_str().to_owned(),
            run.selection.clone(),
            run.mode,
        ));
        ActorTurnEnd::Text("done".to_owned())
    }

    fn turn_messages(&self, _child: &SessionId) -> Option<u64> {
        Some(0)
    }

    fn actor_turn_stats(&self, _child: &SessionId) -> Option<ActorTurnStats> {
        None
    }
}

impl ActorSessionRelease for FakeAgents {
    fn release_actor_session(&self, _child: &SessionId) -> std::result::Result<(), String> {
        Ok(())
    }
}

/// The parent `ses_p` with a fixed selection and mode; any other session is unknown.
struct FixedParent {
    selection: Option<ModelSelection>,
    mode: Option<PermissionMode>,
}

impl ActorBindingsPort for FixedParent {
    fn parent_bindings(&self, parent: &str) -> Result<Option<ParentBindings>, String> {
        Ok((parent == "ses_p").then(|| ParentBindings {
            selection: self.selection.clone(),
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/work"),
            },
            interactions: None,
        }))
    }

    fn parent_permission_mode(&self, parent: &str) -> Result<Option<PermissionMode>, String> {
        Ok((parent == "ses_p").then_some(self.mode).flatten())
    }
}

/// The session row the composed run's journal and actor rows point at.
fn add_parent(path: &std::path::Path) {
    let (conn, _) = rust_cli_node_store::open_session_database(
        path,
        rust_cli_node_store::MIGRATION_LOCK_WAIT,
        1,
    )
    .expect("session database");
    add_session(&conn, "ses_p");
}

/// A launch from `ses_p` with its one plain ask, the way the tools will start a run (the mode is recorded at launch).
fn launch_config(run_id: &str, parent: &dyn ActorBindingsPort) -> EngineConfig {
    let mut config = EngineConfig {
        run_id: run_id.to_owned(),
        parent_session_id: Some("ses_p".to_owned()),
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
    record_parent_mode(&mut config, parent).expect("the parent's mode is read");
    config
}

fn launch_input(run_id: &str) -> LaunchInput {
    LaunchInput {
        script_text: "return 1".to_owned(),
        run_id: run_id.to_owned(),
        args: Some(Map::new()),
        resumed_from: None,
        cwd: std::path::PathBuf::from("/work"),
    }
}

/// One actor created and asked once through the child's handler, as the child runtime does.
async fn actor_asks(
    handler: &Arc<dyn ChildHandler>,
    prompt: &str,
) -> std::result::Result<Value, WireError> {
    let persona = json!({"name": "Ada", "system": "Be terse."});
    let create: CreateActor = serde_json::from_value(json!({
        "localId": "a1",
        "siteId": "plain",
        "name": "Ada",
        "persona": persona,
    }))
    .expect("create-actor");
    let engine_id = handler
        .create_actor(&create)
        .await
        .expect("the actor is created");
    let ask: ChildRequest = serde_json::from_value(json!({
        "id": "r-a1",
        "type": "ask",
        "siteId": "plain",
        "actor": "a1",
        "prompt": prompt,
        "instructions": prompt,
    }))
    .expect("ask");
    handler.request(ask, Some(engine_id)).await
}

/// 9.35 (W7-5f): a run launched in the composed service runs its actor's turn under the parent's selection and the
/// permission mode the launch recorded from the parent (Node's submit, divergence 273).
#[tokio::test]
async fn a_launched_run_actor_completes_its_turn_under_the_parents_selection_and_mode() {
    let dir = tempfile::tempdir().expect("temp dir");
    let database = dir.path().join("sessions.db");
    add_parent(&database);
    let agents = Arc::new(FakeAgents::default());
    let parent = Arc::new(FixedParent {
        selection: Some(ModelSelection::new("acct-a", "ma")),
        mode: Some(PermissionMode::AcceptEdits),
    });
    let runner = Arc::new(FakeChildRunner::new());
    let service = build(
        Some(runner.clone()),
        Arc::new(SessionResidency::new()),
        &database,
        "/work",
        agents.clone(),
        parent.clone(),
        tokio::runtime::Handle::current(),
        Arc::new(RecordingPort::default()),
        Arc::new(rust_cli_kernel_api::dynamic_workflow::SessionGates::default()),
    )
    .expect("the service is built over the runner");
    service
        .launch(launch_input("wf_1"), launch_config("wf_1", parent.as_ref()))
        .await
        .expect("the run is launched");

    let answer = actor_asks(&runner.launches()[0].handler, "do it").await;

    assert!(answer.is_ok(), "the actor's turn completes: {answer:?}");
    let seen = agents.seen.lock().expect("seen").clone();
    assert_eq!(seen.len(), 1, "the turn reached the agents once");
    assert_eq!(seen[0].0, "ses_p", "the parent session");
    assert_eq!(
        seen[0].1,
        ModelSelection::new("acct-a", "ma"),
        "the parent's selection"
    );
    assert_eq!(
        seen[0].2,
        PermissionMode::AcceptEdits,
        "the mode the launch recorded"
    );

    runner.finish(
        0,
        Outcome::Completed(Completion {
            ok: true,
            value: Some(json!("done")),
            error: None,
        }),
    );
    let lines = WorkflowRunHost::close(&service).await;
    assert!(lines.is_empty(), "a clean close: {lines:?}");
}

/// 9.35 (W7-5f): a parent with no model selection gives its actor none, so the actor's turn is refused at its ask and the
/// agents never see it. The launch itself starts.
#[tokio::test]
async fn a_parent_with_no_selection_refuses_its_actor_at_the_ask() {
    let dir = tempfile::tempdir().expect("temp dir");
    let database = dir.path().join("sessions.db");
    add_parent(&database);
    let agents = Arc::new(FakeAgents::default());
    let runner = Arc::new(FakeChildRunner::new());
    let parent = Arc::new(FixedParent {
        selection: None,
        mode: Some(PermissionMode::Default),
    });
    let service = build(
        Some(runner.clone()),
        Arc::new(SessionResidency::new()),
        &database,
        "/work",
        agents.clone(),
        parent.clone(),
        tokio::runtime::Handle::current(),
        Arc::new(RecordingPort::default()),
        Arc::new(rust_cli_kernel_api::dynamic_workflow::SessionGates::default()),
    )
    .expect("the service is built over the runner");
    service
        .launch(launch_input("wf_2"), launch_config("wf_2", parent.as_ref()))
        .await
        .expect("the run is launched");

    let answer = actor_asks(&runner.launches()[0].handler, "do it").await;

    let refusal = answer.expect_err("the actor's ask is refused");
    assert!(
        refusal.message.contains("no model selection"),
        "the refusal names the missing selection: {}",
        refusal.message
    );
    assert!(
        agents.seen.lock().expect("seen").is_empty(),
        "the agents never see the turn"
    );
    runner.finish(
        0,
        Outcome::Completed(Completion {
            ok: true,
            value: None,
            error: None,
        }),
    );
    let lines = WorkflowRunHost::close(&service).await;
    assert!(lines.is_empty(), "a clean close: {lines:?}");
}

/// A session row the run's parent points at (the test database has no sessions otherwise).
fn add_session(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, 'proj', null, ?, '/work', 'title', '0.0.0', 1, 1)",
        rusqlite::params![id, id],
    )
    .expect("session row for the run's parent");
}

/// The progress port the composition is given in these tests: it keeps what it was asked to record.
#[derive(Default)]
struct RecordingPort {
    calls: Mutex<Vec<(String, Value)>>,
}

impl WorkflowRunProgressPort for RecordingPort {
    fn record(
        &self,
        parent_session_id: &str,
        progress: &Value,
        _deltas: &[Value],
    ) -> Result<(), String> {
        self.calls
            .lock()
            .expect("calls")
            .push((parent_session_id.to_owned(), progress.clone()));
        Ok(())
    }
}

/// The composition's session open settles the parent's orphan through the production store, which opens the database
/// on first use (W7-5c item 1): a run a previous process left running reads back as stopped once its session opens.
#[tokio::test]
async fn a_session_open_settles_the_parents_orphan_in_the_composed_service() {
    let dir = tempfile::tempdir().expect("temp dir");
    let database = dir.path().join("sessions.db");
    {
        let (conn, _) =
            open_session_database(&database, MIGRATION_LOCK_WAIT, 1).expect("session database");
        add_session(&conn, "ses_parent");
        let run = RunRecord {
            run_id: "dwfrun-orphan".to_owned(),
            parent_session_id: Some("ses_parent".to_owned()),
            cwd: Some("project".to_owned()),
            script_text: Some("return 1".to_owned()),
            max_concurrency: 4,
            status: RunStatus::Running,
            ..RunRecord::default()
        };
        dwf::create_run(&conn, &run, 1).expect("seed the orphan");
    }
    let service = build(
        Some(Arc::new(FakeChildRunner::new())),
        Arc::new(SessionResidency::new()),
        &database,
        "/work",
        Arc::new(FakeAgents::default()),
        Arc::new(FixedParent {
            selection: None,
            mode: None,
        }),
        tokio::runtime::Handle::current(),
        Arc::new(RecordingPort::default()),
        Arc::new(rust_cli_kernel_api::dynamic_workflow::SessionGates::default()),
    )
    .expect("the service is built over the runner");

    WorkflowRunHost::session_opened(&service, "ses_parent").await;

    let (conn, _) =
        open_session_database(&database, MIGRATION_LOCK_WAIT, 2).expect("session database");
    let row = dwf::get_run(&conn, "dwfrun-orphan")
        .expect("the row read")
        .expect("the row exists");
    assert_eq!(row.status, RunStatus::Stopped, "the orphan is settled");
}

/// Without a helper there is no child runner, so no run service is built: the families stay as they were.
#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test checks that no database file was created, which is a file-system fact"
)]
async fn without_a_child_runner_no_run_service_is_built() {
    let dir = tempfile::tempdir().expect("temp dir");
    let database = dir.path().join("sessions.db");
    let service = build(
        None,
        Arc::new(SessionResidency::new()),
        &database,
        "/work",
        Arc::new(FakeAgents::default()),
        Arc::new(FixedParent {
            selection: None,
            mode: None,
        }),
        tokio::runtime::Handle::current(),
        Arc::new(RecordingPort::default()),
        Arc::new(rust_cli_kernel_api::dynamic_workflow::SessionGates::default()),
    );
    assert!(service.is_none(), "no child runner, no run service");
    assert!(!database.exists(), "nothing is opened");
}

/// With a child runner the service is built, but it holds no run and opens nothing until a launch: with the gate off,
/// nothing about the process changes at runtime.
#[tokio::test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test checks that no database file was created, which is a file-system fact"
)]
async fn a_built_run_service_is_idle_and_opens_nothing_until_a_launch() {
    let dir = tempfile::tempdir().expect("temp dir");
    let database = dir.path().join("sessions.db");
    let runner = Arc::new(FakeChildRunner::new());
    let service = build(
        Some(runner.clone()),
        Arc::new(SessionResidency::new()),
        &database,
        "/work",
        Arc::new(FakeAgents::default()),
        Arc::new(FixedParent {
            selection: None,
            mode: None,
        }),
        tokio::runtime::Handle::current(),
        Arc::new(RecordingPort::default()),
        Arc::new(rust_cli_kernel_api::dynamic_workflow::SessionGates::default()),
    )
    .expect("the service is built over the runner");

    assert_eq!(service.run_count(), 0, "no run is held");
    assert!(
        !database.exists(),
        "the database is not opened by building the service"
    );
    assert!(runner.launches().is_empty(), "no child is started");

    let lines = WorkflowRunHost::close(&service).await;
    assert!(
        lines.is_empty(),
        "a clean close of an idle service: {lines:?}"
    );
}

/// The fake child, compiled as the helper compiles a script with no asks and no phases.
struct CompiledChild(Arc<FakeChildRunner>);

#[async_trait]
impl rust_cli_kernel_api::workflow_child::WorkflowChildRunner for CompiledChild {
    async fn start(
        &self,
        input: LaunchInput,
        handler: Arc<dyn rust_cli_kernel_api::workflow_child::ChildHandler>,
    ) -> Result<
        rust_cli_kernel_api::workflow_child::RunningChild,
        rust_cli_kernel_api::workflow_child::LaunchError,
    > {
        let mut running = self.0.start(input, handler).await?;
        running.compiled = json!({ "askSpecs": {}, "sitePhases": {} });
        Ok(running)
    }
}

/// W7-8d (9.39): a submit through the composed service's session port starts a run under that session, with the
/// governor's default concurrency. The composition wires the same bindings port the actors read.
#[tokio::test]
async fn a_submit_through_the_composed_sessions_starts_a_run_under_its_session() {
    use rust_cli_kernel_api::workflow_run::{DynamicWorkflowRunSessions, SubmitRequest};

    let dir = tempfile::tempdir().expect("temp dir");
    let database = dir.path().join("sessions.db");
    {
        let (conn, _) =
            open_session_database(&database, MIGRATION_LOCK_WAIT, 1).expect("session database");
        add_session(&conn, "ses_p");
    }
    let runner = Arc::new(FakeChildRunner::new());
    // The helper's compile reports both tables (the child's compile, 9.39); the fake reports none, so wrap it.
    let compiling: Arc<dyn rust_cli_kernel_api::workflow_child::WorkflowChildRunner> =
        Arc::new(CompiledChild(runner.clone()));
    let service = build(
        Some(compiling),
        Arc::new(SessionResidency::new()),
        &database,
        "/work",
        Arc::new(FakeAgents::default()),
        Arc::new(FixedParent {
            selection: None,
            mode: Some(PermissionMode::AcceptEdits),
        }),
        tokio::runtime::Handle::current(),
        Arc::new(RecordingPort::default()),
        Arc::new(rust_cli_kernel_api::dynamic_workflow::SessionGates::default()),
    )
    .expect("the service is built over the runner");

    let sessions: &dyn DynamicWorkflowRunSessions = &service;
    let port = sessions.for_session(&SessionId::new("ses_p"));
    assert!(
        port.default_concurrency().is_some_and(|value| value >= 4),
        "the governor's default is the caps default"
    );
    let run = port
        .submit(SubmitRequest {
            script_text: "return 1".to_owned(),
            cwd: "project".to_owned(),
            name: Some("composed".to_owned()),
            args: None,
            parent_session_id: Some(SessionId::new("ses_p")),
            tool_call_id: Some("toolu_composed".to_owned()),
            max_concurrency: None,
            script_path: None,
        })
        .await
        .expect("the submit starts the run");

    let launches = runner.launches();
    assert_eq!(launches.len(), 1, "the child started once");
    assert_eq!(launches[0].input.run_id, run.to_string());
    assert_eq!(launches[0].input.script_text, "return 1");

    runner.finish(
        0,
        Outcome::Completed(Completion {
            ok: true,
            value: Some(json!("done")),
            error: None,
        }),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while service.run_count() != 0 {
        assert!(Instant::now() < deadline, "the run settles");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let conn = open_session_database(&database, MIGRATION_LOCK_WAIT, 1)
        .expect("session database")
        .0;
    let row = dwf::get_run(&conn, run.as_str())
        .expect("the row read")
        .expect("the run has its row");
    assert_eq!(row.parent_session_id.as_deref(), Some("ses_p"));
    assert_eq!(row.status, RunStatus::Completed);
}

/// W7-5e (9.34): a run launched through the composed service records its progress to its parent session, through the
/// port the composition was given. Node's sink appends each run event to the parent; the first is `run-started`.
#[tokio::test]
async fn a_run_launched_in_the_composed_service_records_its_progress_to_its_parent() {
    let dir = tempfile::tempdir().expect("temp dir");
    let database = dir.path().join("sessions.db");
    {
        let (conn, _) =
            open_session_database(&database, MIGRATION_LOCK_WAIT, 1).expect("session database");
        add_session(&conn, "ses_p");
    }
    let runner = Arc::new(FakeChildRunner::new());
    let port = Arc::new(RecordingPort::default());
    let service = build(
        Some(runner.clone()),
        Arc::new(SessionResidency::new()),
        &database,
        "/work",
        Arc::new(FakeAgents::default()),
        Arc::new(FixedParent {
            selection: None,
            mode: None,
        }),
        tokio::runtime::Handle::current(),
        port.clone(),
        Arc::new(rust_cli_kernel_api::dynamic_workflow::SessionGates::default()),
    )
    .expect("the service is built over the runner");

    let mut config = EngineConfig {
        run_id: "dwfrun-progress".to_owned(),
        parent_session_id: Some("ses_p".to_owned()),
        ..Default::default()
    };
    config.caps.max_concurrency = 4.0;
    service
        .launch(
            LaunchInput {
                script_text: "return 1".to_owned(),
                run_id: "dwfrun-progress".to_owned(),
                args: Some(Map::new()),
                resumed_from: None,
                cwd: PathBuf::from("project"),
            },
            config,
        )
        .await
        .expect("launched");

    let deadline = Instant::now() + Duration::from_secs(5);
    while port.calls.lock().expect("calls").is_empty() {
        assert!(
            Instant::now() < deadline,
            "the run's progress was not recorded"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    {
        let calls = port.calls.lock().expect("calls");
        assert!(calls.iter().all(|(parent, _)| parent == "ses_p"));
        assert_eq!(calls[0].1["eventType"], json!("run-started"));
        assert_eq!(calls[0].1["runId"], json!("dwfrun-progress"));
    }

    runner.finish(
        0,
        Outcome::Completed(Completion {
            ok: true,
            value: Some(json!("done")),
            error: None,
        }),
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while service.run_count() != 0 {
        assert!(Instant::now() < deadline, "the run settles");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
