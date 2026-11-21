//! Tests of the run service's submit (specs/fork-rust-workflow-engine.md, 9.39, W7-8d; Node `submitDynamicWorkflowRun`
//! and `startNewRun`). The journal is a real session database in a temp directory and the owner is the production owner
//! factory, so a submitted run writes its own row. The child is `FakeChildRunner`, wrapped to answer with the compile's
//! tables.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic;
use rust_cli_kernel_api::workflow_child::{
    ChildHandler, Completion, LaunchError, LaunchInput, Outcome, RunningChild, WorkflowChildRunner,
};
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunSessions, SubmitRequest,
};
use rust_cli_node_store::dwf::{self, RunStatus as DwfStatus};
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};
use rust_cli_workflow::run_store::SqliteRunStore;
use serde_json::{Value, json};

use crate::workflow_owner::{
    ActorBindingsPort, OwnerStores, ParentBindings, UnwiredRelease, UnwiredTurns,
    production_owner_factory,
};
use crate::workflow_run::WorkflowRunService;

const PARENT: &str = "ses_p";
const OTHER: &str = "ses_other";
/// The default concurrency the fixture configures (Node `defaultConcurrency()`).
const DEFAULT: usize = 6;

/// The compile's tables of a script with two asks and a phase.
fn compiled_facts() -> Value {
    json!({
        "askSpecs": { "plain": { "typed": false } },
        "sitePhases": { "plain": "main" },
        "scriptHash": "fake-0",
    })
}

/// The fake child with the compiled facts the test wants. Everything else is the fake's.
struct WithCompiled {
    fake: Arc<FakeChildRunner>,
    compiled: Value,
}

#[async_trait]
impl WorkflowChildRunner for WithCompiled {
    async fn start(
        &self,
        input: LaunchInput,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<RunningChild, LaunchError> {
        let mut running = self.fake.start(input, handler).await?;
        running.compiled = self.compiled.clone();
        Ok(running)
    }
}

struct NoConcurrency;

impl RunConcurrency for NoConcurrency {
    fn set_run_bound(&self, _run_id: &str, _bound: u64) {}
    fn clear_run_bound(&self, _run_id: &str) {}
    fn subscribe(&self, _run_id: &str, _listener: ConcurrencyListener) -> Box<dyn FnOnce() + Send> {
        Box::new(|| {})
    }
}

/// The parent's permission mode as the test sets it (the store's read, in the composition).
struct Mode(Result<Option<PermissionMode>, String>);

impl ActorBindingsPort for Mode {
    fn parent_bindings(&self, _parent: &str) -> Result<Option<ParentBindings>, String> {
        Ok(None)
    }

    fn parent_permission_mode(&self, _parent: &str) -> Result<Option<PermissionMode>, String> {
        self.0.clone()
    }
}

fn open(path: &Path) -> rusqlite::Connection {
    rust_cli_node_store::open_session_database(path, Duration::from_secs(1), 0)
        .expect("session database")
        .0
}

fn add_session(conn: &rusqlite::Connection, id: &str) {
    conn.execute(
        "insert into session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated)
         values (?, 'proj', null, ?, '/work', 'title', '0.0.0', 1, 1)",
        rusqlite::params![id, id],
    )
    .expect("session row for the run's parent");
}

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    service: WorkflowRunService,
    fake: Arc<FakeChildRunner>,
}

/// A service over a temp session database with two parent sessions. The child compiles to `compiled`; the parent's
/// permission mode comes from `bindings` (no port, when `None`); the default concurrency is `DEFAULT`.
fn fixture(compiled: Value, bindings: Option<Arc<dyn ActorBindingsPort>>) -> Fixture {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("session.db");
    let conn = open(&path);
    add_session(&conn, PARENT);
    add_session(&conn, OTHER);
    let store = Arc::new(SqliteRunStore::new(conn, || 500));
    let fake = Arc::new(FakeChildRunner::new());
    let runner: Arc<dyn WorkflowChildRunner> = Arc::new(WithCompiled {
        fake: fake.clone(),
        compiled,
    });
    let factory = production_owner_factory(
        OwnerStores {
            database: path.clone(),
            directory: "project".to_owned(),
            version: "test".to_owned(),
            clock: || 1,
        },
        Arc::new(UnwiredTurns),
        Arc::new(UnwiredRelease),
    );
    let service = WorkflowRunService::new(
        Arc::new(SessionResidency::new()),
        Arc::new(NoConcurrency),
        runner,
        factory,
    );
    service.set_store(store);
    service.configure_concurrency(DEFAULT as f64);
    if let Some(bindings) = bindings {
        service.configure_bindings(bindings);
    }
    Fixture {
        _dir: dir,
        path,
        service,
        fake,
    }
}

fn mode(value: Result<Option<PermissionMode>, String>) -> Option<Arc<dyn ActorBindingsPort>> {
    Some(Arc::new(Mode(value)))
}

/// A submit of `script` from the parent session, with the fields a CreateWorkflow call fills.
fn request(script: &str) -> SubmitRequest {
    SubmitRequest {
        script_text: script.to_owned(),
        cwd: "project".to_owned(),
        name: Some("nightly".to_owned()),
        args: json!({"limit": 3}).as_object().cloned(),
        parent_session_id: Some(SessionId::new(PARENT)),
        tool_call_id: Some("toolu_1".to_owned()),
        max_concurrency: None,
        script_path: None,
        phase_names: None,
        phase_alongside: None,
        subagent_model: None,
        model_bindings: None,
    }
}

async fn submit(
    service: &WorkflowRunService,
    session: &str,
    request: SubmitRequest,
) -> Result<String, DynamicWorkflowRunError> {
    service
        .for_session(&SessionId::new(session))
        .submit(request)
        .await
        .map(|run| run.to_string())
}

fn completed(value: Value) -> Outcome {
    Outcome::Completed(Completion {
        ok: true,
        value: Some(value),
        error: None,
    })
}

async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

// ---- The submit itself, over the real journal and the production owner.

#[test]
fn an_invalid_default_concurrency_is_refused_and_the_first_valid_one_is_kept() {
    // The default is the caps default of every submit: a non-finite or sub-one value is refused, and a second set keeps the
    // first (review finding: validate the set-once value, and say so when a second set is ignored).
    let fx = fixture(compiled_facts(), mode(Ok(None)));
    let service = WorkflowRunService::new(
        Arc::new(SessionResidency::new()),
        Arc::new(NoConcurrency),
        Arc::new(FakeChildRunner::new()),
        production_owner_factory(
            OwnerStores {
                database: fx.path,
                directory: "project".to_owned(),
                version: "test".to_owned(),
                clock: || 1,
            },
            Arc::new(UnwiredTurns),
            Arc::new(UnwiredRelease),
        ),
    );
    assert!(!service.configure_concurrency(f64::NAN), "NaN is refused");
    assert!(
        !service.configure_concurrency(0.5),
        "a default below one is refused"
    );
    assert_eq!(
        service.default_concurrency_value(),
        None,
        "nothing was kept"
    );
    assert!(
        service.configure_concurrency(3.0),
        "a valid default is kept"
    );
    assert!(
        !service.configure_concurrency(9.0),
        "a second set is refused"
    );
    assert_eq!(
        service.default_concurrency_value(),
        Some(3.0),
        "the first value stays"
    );
}

#[tokio::test]
async fn a_submitted_run_starts_on_a_new_row_and_settles() {
    let fx = fixture(compiled_facts(), mode(Ok(None)));

    let run = submit(&fx.service, PARENT, request("return 1\n"))
        .await
        .expect("the submit starts the run");
    assert!(run.starts_with("dwfrun-"), "a minted run id: {run}");

    let launches = fx.fake.launches();
    assert_eq!(launches.len(), 1, "the child started once");
    assert_eq!(launches[0].input.script_text, "return 1\n");
    assert_eq!(launches[0].input.run_id, run);
    assert_eq!(launches[0].input.cwd, PathBuf::from("project"));
    assert_eq!(
        launches[0].input.args,
        json!({"limit": 3}).as_object().cloned()
    );

    fx.fake.finish(0, completed(json!("done")));
    wait_until("the run to settle", || fx.service.run_count() == 0).await;
    let conn = open(&fx.path);
    let row = dwf::get_run(&conn, &run)
        .expect("the row read")
        .expect("the run has its row");
    assert_eq!(row.status, DwfStatus::Completed);
    assert_eq!(row.parent_session_id.as_deref(), Some(PARENT));
    assert_eq!(row.cwd.as_deref(), Some("project"));
    assert_eq!(row.name.as_deref(), Some("nightly"));
    assert_eq!(row.tool_call_id.as_deref(), Some("toolu_1"));
    assert_eq!(row.args, Some(json!({"limit": 3})));
}

#[tokio::test]
async fn a_submit_takes_the_default_concurrency_without_a_limit_and_floors_a_limit_to_one() {
    let fx = fixture(compiled_facts(), mode(Ok(None)));

    let unset = submit(&fx.service, PARENT, request("return 1\n"))
        .await
        .expect("no limit");
    let mut zero = request("return 2\n");
    zero.max_concurrency = Some(0);
    let floored = submit(&fx.service, PARENT, zero)
        .await
        .expect("a zero limit");
    let mut nine = request("return 3\n");
    nine.max_concurrency = Some(9);
    let above = submit(&fx.service, PARENT, nine)
        .await
        .expect("a limit above the default");

    let conn = open(&fx.path);
    let cap = |run: &str| {
        dwf::get_run(&conn, run)
            .expect("the row read")
            .expect("the row")
            .max_concurrency
    };
    assert_eq!(cap(&unset), DEFAULT as i64, "no limit is the default");
    assert_eq!(cap(&floored), 1, "a limit of zero is floored to one");
    assert_eq!(cap(&above), 9, "a limit above the default is used as given");
}

#[tokio::test]
async fn a_submit_records_the_parents_permission_mode_on_its_launch() {
    let fx = fixture(
        compiled_facts(),
        mode(Ok(Some(PermissionMode::AcceptEdits))),
    );

    let run = submit(&fx.service, PARENT, request("return 1\n"))
        .await
        .expect("the submit starts the run");

    let path = fx.path.clone();
    let id = run.clone();
    wait_until("the run-launched event", || {
        let conn = open(&path);
        dwf::list_events(&conn, &id)
            .map(|events| {
                events
                    .iter()
                    .any(|event| event.event["type"] == json!("run-launched"))
            })
            .unwrap_or(false)
    })
    .await;
    let conn = open(&fx.path);
    let launched = dwf::list_events(&conn, &run)
        .expect("the events")
        .into_iter()
        .find(|event| event.event["type"] == json!("run-launched"))
        .expect("the launch event");
    assert_eq!(
        launched.event["subagentPermissionMode"],
        json!("edit"),
        "the parent's acceptEdits mode is recorded as Node names it"
    );
}

#[tokio::test]
async fn a_script_with_no_asks_and_no_phases_is_accepted() {
    // An empty table is a real answer for a script with nothing to ask (the helper sends `{}`); submit starts it. Resume
    // refuses the same shape, because a stored script's tables cannot be told from a missing reply there.
    let fx = fixture(json!({ "askSpecs": {}, "sitePhases": {} }), mode(Ok(None)));

    let run = submit(&fx.service, PARENT, request("return 1\n"))
        .await
        .expect("the run starts");
    assert_eq!(fx.fake.launches().len(), 1, "the child started for {run}");
}

#[tokio::test]
async fn a_compile_that_rejects_the_script_starts_no_run_and_names_its_diagnostics() {
    let fx = fixture(compiled_facts(), mode(Ok(None)));
    fx.fake.refuse_next(LaunchError::Rejected {
        diagnostics: vec![WorkflowDiagnostic {
            code: 2304,
            line: 2,
            column: 3,
            message: "Cannot find name 'agnt'.".to_owned(),
        }],
        message: None,
    });

    let error = submit(&fx.service, PARENT, request("x\n"))
        .await
        .expect_err("the compile refuses the script");
    assert!(
        error.message.contains("L2:C3 Cannot find name 'agnt'."),
        "{}",
        error.message
    );
    assert_eq!(fx.service.run_count(), 0, "nothing is kept");
}

#[tokio::test]
async fn a_submit_without_a_permission_mode_port_is_refused_and_starts_nothing() {
    // Fail closed (9.35): without the port the parent's mode cannot be recorded, so no run starts.
    let fx = fixture(compiled_facts(), None);

    let error = submit(&fx.service, PARENT, request("return 1\n"))
        .await
        .expect_err("no bindings port, no run");
    assert!(
        error.message.contains("permission mode"),
        "{}",
        error.message
    );
    assert!(fx.fake.launches().is_empty(), "no child started");
}

#[tokio::test]
async fn a_failed_permission_read_refuses_the_submit() {
    let fx = fixture(
        compiled_facts(),
        mode(Err("the session store did not read".to_owned())),
    );

    let error = submit(&fx.service, PARENT, request("return 1\n"))
        .await
        .expect_err("a read error refuses");
    assert!(
        error.message.contains("the session store did not read"),
        "{}",
        error.message
    );
    assert!(fx.fake.launches().is_empty(), "no child started");
}

#[tokio::test]
async fn the_port_for_a_session_submits_under_that_session() {
    // The run service is one per app, and the port is per parent session (9.29, divergence 322): a submit through
    // another session's port records that session as the run's parent.
    let fx = fixture(compiled_facts(), mode(Ok(None)));
    let sessions: &dyn DynamicWorkflowRunSessions = &fx.service;
    let port = sessions.for_session(&SessionId::new(OTHER));
    assert_eq!(
        port.default_concurrency(),
        Some(DEFAULT),
        "the session's port reports the service's default"
    );

    let mut own = request("return 1\n");
    own.parent_session_id = Some(SessionId::new(OTHER));
    let run = port.submit(own).await.expect("the submit starts the run");

    let conn = open(&fx.path);
    let row = dwf::get_run(&conn, &run.to_string())
        .expect("the row read")
        .expect("the row");
    assert_eq!(row.parent_session_id.as_deref(), Some(OTHER));
}

#[tokio::test]
async fn a_submit_that_names_another_parent_is_refused_and_starts_nothing() {
    // The port is bound to one parent. A request naming a different one is a wiring fault: refused, not re-attributed
    // (divergence 380). The run and its recorded mode would otherwise follow the port, not the request.
    let fx = fixture(compiled_facts(), mode(Ok(None)));
    let sessions: &dyn DynamicWorkflowRunSessions = &fx.service;
    let port = sessions.for_session(&SessionId::new(PARENT));
    let mut misnamed = request("return 1\n");
    misnamed.parent_session_id = Some(SessionId::new(OTHER));

    let error = port
        .submit(misnamed)
        .await
        .expect_err("a mismatched parent is refused");
    assert!(
        error.message.contains(OTHER) && error.message.contains(PARENT),
        "{}",
        error.message
    );
    assert!(fx.fake.launches().is_empty(), "no child started");
    assert_eq!(fx.service.run_count(), 0, "nothing is kept");
}

#[tokio::test]
async fn a_long_compile_rejection_is_capped_at_the_resume_bound() {
    // A submit's rejection reaches the model verbatim, so it is cut at Node's 2000-unit diagnostics cap (divergence 377).
    let fx = fixture(compiled_facts(), mode(Ok(None)));
    let diagnostics: Vec<WorkflowDiagnostic> = (0..400)
        .map(|line| WorkflowDiagnostic {
            code: 2304,
            line,
            column: 1,
            message: "Cannot find name 'a-long-identifier-that-repeats'.".to_owned(),
        })
        .collect();
    fx.fake.refuse_next(LaunchError::Rejected {
        diagnostics,
        message: None,
    });

    let error = submit(&fx.service, PARENT, request("x\n"))
        .await
        .expect_err("the compile refuses the script");
    let units: usize = error.message.encode_utf16().count();
    assert!(units <= 2000, "{units} units");
    assert!(error.message.ends_with('…'), "the cut is marked");
    assert!(
        error
            .message
            .starts_with("The workflow script did not compile:\nL0:C1")
    );
}

/// 9.63 (DWR-04): the run's subagent model and the script's model table are recorded on `run-launched`, where the
/// owner's actors and the run's snapshot read them (Node `RunLaunchConfig`).
#[tokio::test]
async fn a_submit_records_the_subagent_model_and_the_script_models_on_its_launch() {
    let fx = fixture(compiled_facts(), mode(Ok(Some(PermissionMode::Default))));
    let mut asked = request("return 1\n");
    asked.subagent_model = Some("deepseek/deepseek-v4-pro".to_owned());
    asked.model_bindings = json!({"checker": "deepseek/deepseek-v4-flash"})
        .as_object()
        .cloned();
    let run = submit(&fx.service, PARENT, asked)
        .await
        .expect("the submit starts the run");
    let path = fx.path.clone();
    let id = run.clone();
    wait_until("the run-launched event", || {
        let conn = open(&path);
        dwf::list_events(&conn, &id)
            .map(|events| {
                events
                    .iter()
                    .any(|event| event.event["type"] == json!("run-launched"))
            })
            .unwrap_or(false)
    })
    .await;
    let conn = open(&fx.path);
    let launched = dwf::list_events(&conn, &run)
        .expect("the events")
        .into_iter()
        .find(|event| event.event["type"] == json!("run-launched"))
        .expect("the launch event");
    assert_eq!(
        launched.event["subagentModel"],
        json!("deepseek/deepseek-v4-pro")
    );
    assert_eq!(
        launched.event["modelBindings"],
        json!({"checker": "deepseek/deepseek-v4-flash"})
    );
}
