//! Tests of the run service's amend (specs/fork-rust-workflow-engine.md, 9.43, W7-10). The journal is a real session
//! database in a temp directory and the owner is the production owner factory. The child is `FakeChildRunner`, which
//! answers the compile with the tables of a healthy script.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_child::{
    ChildHandler, ChildRequest, FillPrepareInput, FillPrepareOutcome, LaunchError, LaunchInput,
    RequestType, RunningChild, WorkflowChildRunner,
};
use rust_cli_kernel_api::workflow_run::{
    AmendRefusalReason, AmendRequest, AmendResult, DynamicWorkflowRunSessions, FillHoleOutcome,
    FillHoleRequest, FillRefusalReason,
};
use rust_cli_node_store::dwf::{
    self, NodeKind, NodeRecord, NodeStatus, RunRecord, RunStatus as DwfStatus,
    StopReason as DwfStop,
};
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
const DEFAULT: usize = 6;

/// The compile's tables a healthy script reports.
fn compiled_facts() -> Value {
    json!({
        "askSpecs": { "plain": { "typed": false } },
        "sitePhases": { "plain": "main" },
        "scriptHash": "fake-0",
    })
}

struct WithCompiled {
    fake: Arc<FakeChildRunner>,
}

#[async_trait]
impl WorkflowChildRunner for WithCompiled {
    async fn start(
        &self,
        input: LaunchInput,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<RunningChild, LaunchError> {
        let mut running = self.fake.start(input, handler).await?;
        running.compiled = compiled_facts();
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

struct Mode;

impl ActorBindingsPort for Mode {
    fn parent_bindings(&self, _parent: &str) -> Result<Option<ParentBindings>, String> {
        Ok(None)
    }

    fn parent_permission_mode(&self, _parent: &str) -> Result<Option<PermissionMode>, String> {
        Ok(Some(PermissionMode::Default))
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

/// A stopped run that an earlier process interrupted: the predecessor shape a settled amend starts from.
fn interrupted(conn: &rusqlite::Connection, id: &str, parent: &str, script: &str) {
    let run = RunRecord {
        run_id: id.to_owned(),
        parent_session_id: Some(parent.to_owned()),
        cwd: Some("project".to_owned()),
        script_text: Some(script.to_owned()),
        args: Some(json!({})),
        max_concurrency: 4,
        status: DwfStatus::Stopped,
        stop_reason: Some(DwfStop::Interrupted),
        failure: Some(json!({ "code": "Interrupted", "message": "the run was interrupted" })),
        ..RunRecord::default()
    };
    dwf::create_run(conn, &run, 1).expect("seed run row");
}

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    service: WorkflowRunService,
    fake: Arc<FakeChildRunner>,
}

/// A service over a temp session database that `seed` has filled, with the default concurrency and the parent's mode.
fn fixture(seed: impl FnOnce(&rusqlite::Connection)) -> Fixture {
    fixture_with_bindings(seed, Arc::new(Mode))
}

/// A parent whose permission mode cannot be read: the start fails after the predecessor is stopped.
struct FailingMode;

impl ActorBindingsPort for FailingMode {
    fn parent_bindings(&self, _parent: &str) -> Result<Option<ParentBindings>, String> {
        Ok(None)
    }

    fn parent_permission_mode(&self, _parent: &str) -> Result<Option<PermissionMode>, String> {
        Err("the store is busy".to_owned())
    }
}

/// A parent whose first mode read fails and whose later reads succeed: the first amend fails after the stop, a retry starts.
struct FlakyMode(std::sync::atomic::AtomicBool);

impl ActorBindingsPort for FlakyMode {
    fn parent_bindings(&self, _parent: &str) -> Result<Option<ParentBindings>, String> {
        Ok(None)
    }

    fn parent_permission_mode(&self, _parent: &str) -> Result<Option<PermissionMode>, String> {
        if self.0.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Err("the store is busy".to_owned());
        }
        Ok(Some(PermissionMode::Default))
    }
}

fn fixture_with_bindings(
    seed: impl FnOnce(&rusqlite::Connection),
    bindings: Arc<dyn ActorBindingsPort>,
) -> Fixture {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("session.db");
    let conn = open(&path);
    add_session(&conn, PARENT);
    add_session(&conn, OTHER);
    seed(&conn);
    let store = Arc::new(SqliteRunStore::new(conn, || 500));
    let fake = Arc::new(FakeChildRunner::new());
    let runner: Arc<dyn WorkflowChildRunner> = Arc::new(WithCompiled { fake: fake.clone() });
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
    service.configure_bindings(bindings);
    Fixture {
        _dir: dir,
        path,
        service,
        fake,
    }
}

fn amend_request(predecessor: &str, script: &str) -> AmendRequest {
    AmendRequest {
        script_text: script.to_owned(),
        cwd: "project".to_owned(),
        predecessor_run_id: WorkflowRunId::new(predecessor),
        name: None,
        parent_session_id: Some(SessionId::new(PARENT)),
        tool_call_id: Some("toolu_amend".to_owned()),
        phase_names: None,
        max_concurrency: None,
        subagent_model: None,
        model_bindings: None,
        script_path: None,
        phase_alongside: None,
        inherit_args: false,
    }
}

async fn amend(service: &WorkflowRunService, request: AmendRequest) -> AmendResult {
    service
        .for_session(&SessionId::new(PARENT))
        .amend(request)
        .await
        .expect("the amend answers")
}

async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn row(fx: &Fixture, id: &str) -> dwf::RunRecord {
    let conn = open(&fx.path);
    dwf::get_run(&conn, id)
        .expect("the row read")
        .unwrap_or_else(|| panic!("run {id} has a row"))
}

#[tokio::test]
async fn an_unknown_predecessor_is_refused_and_nothing_starts() {
    let fx = fixture(|_| {});
    let answer = amend(&fx.service, amend_request("dwfrun-missing", "return 2\n")).await;
    assert_eq!(
        answer,
        AmendResult::Refused(AmendRefusalReason::RunNotFound)
    );
    assert!(fx.fake.launches().is_empty(), "no child is started");
    assert_eq!(fx.service.run_count(), 0);
}

/// Node's run service is the app's, so a revision of another session's settled run starts a successor in this session
/// (DWW-06): it resumes from the predecessor, takes this session as its parent, and leaves the predecessor as it was.
#[tokio::test]
async fn a_settled_predecessor_of_another_session_is_amended_into_a_run_of_this_one() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-other", OTHER, "return 1\n"));
    let answer = amend(&fx.service, amend_request("dwfrun-other", "return 2\n")).await;
    let AmendResult::Started { run_id, .. } = answer else {
        panic!("the amend starts a successor: {answer:?}");
    };
    let successor = row(&fx, run_id.as_str());
    assert_eq!(successor.parent_session_id.as_deref(), Some(PARENT));
    assert_eq!(successor.resumed_from.as_deref(), Some("dwfrun-other"));
    let predecessor = row(&fx, "dwfrun-other");
    assert_eq!(predecessor.parent_session_id.as_deref(), Some(OTHER));
    assert_eq!(predecessor.stop_reason, Some(DwfStop::Interrupted));
}

/// A run of another session that has not settled is not this session's to stop, so it stays unknown here and nothing
/// starts (the tool refuses it first with Node's held-elsewhere text).
#[tokio::test]
async fn an_unsettled_predecessor_of_another_session_is_unknown_to_this_one() {
    let fx = fixture(|conn| {
        let run = RunRecord {
            run_id: "dwfrun-other-live".to_owned(),
            parent_session_id: Some(OTHER.to_owned()),
            cwd: Some("project".to_owned()),
            script_text: Some("return 1\n".to_owned()),
            args: Some(json!({})),
            max_concurrency: 4,
            status: DwfStatus::Running,
            ..RunRecord::default()
        };
        dwf::create_run(conn, &run, 1).expect("seed run row");
    });
    let answer = amend(
        &fx.service,
        amend_request("dwfrun-other-live", "return 2\n"),
    )
    .await;
    assert_eq!(
        answer,
        AmendResult::Refused(AmendRefusalReason::RunNotFound)
    );
    assert!(fx.fake.launches().is_empty(), "no child is started");
}

#[tokio::test]
async fn missing_boundaries_refuse_the_amend_and_leave_the_predecessor_as_it_was() {
    let fx = fixture(|conn| {
        interrupted(conn, "dwfrun-old", PARENT, "return 1\n");
        // A completed ask with no message boundary: the journal predates boundary bookkeeping.
        dwf::put_node(
            conn,
            &NodeRecord {
                run_id: "dwfrun-old".to_owned(),
                site_id: "site#1".to_owned(),
                ordinal: 1,
                kind: NodeKind::Ask,
                input_hash: "hash".to_owned(),
                status: NodeStatus::Completed,
                result: Some(json!("done")),
                ..NodeRecord::default()
            },
            1,
        )
        .expect("seed the ask");
    });
    let answer = amend(&fx.service, amend_request("dwfrun-old", "return 2\n")).await;
    assert_eq!(
        answer,
        AmendResult::Refused(AmendRefusalReason::MissingBoundaries)
    );
    assert!(fx.fake.launches().is_empty(), "no successor is started");
    let old = row(&fx, "dwfrun-old");
    assert_eq!(old.status, DwfStatus::Stopped);
    assert_eq!(
        old.stop_reason,
        Some(DwfStop::Interrupted),
        "the predecessor is not superseded"
    );
}

#[tokio::test]
async fn a_settled_predecessor_is_replaced_by_a_successor_that_resumes_from_it() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-settled", PARENT, "return 1\n"));

    let answer = amend(&fx.service, amend_request("dwfrun-settled", "return 2\n")).await;
    let AmendResult::Started {
        run_id,
        superseded_run_id,
    } = answer
    else {
        panic!("the amend starts a successor: {answer:?}");
    };
    assert_eq!(
        superseded_run_id, None,
        "the predecessor had already settled"
    );

    // The successor's script is compiled by a probe child (9.50, divergence 667) and then started: two launches, one run.
    let launches = fx.fake.launches();
    assert_eq!(
        launches.len(),
        2,
        "the compile probe, then the successor's child"
    );
    assert_eq!(
        launches[1].input.script_text, "return 2\n",
        "the revised script runs"
    );
    assert_eq!(
        launches[0].input.resumed_from.as_deref(),
        Some("dwfrun-settled")
    );

    let successor = row(&fx, run_id.as_str());
    assert_eq!(successor.resumed_from.as_deref(), Some("dwfrun-settled"));
    assert_eq!(successor.script_text.as_deref(), Some("return 2\n"));
    assert_eq!(successor.name, None, "the predecessor had no name");
    let predecessor = row(&fx, "dwfrun-settled");
    assert_eq!(
        predecessor.stop_reason,
        Some(DwfStop::Interrupted),
        "the predecessor is untouched"
    );
}

#[tokio::test]
async fn a_live_predecessor_is_superseded_by_the_successor_and_its_settlement_is_awaited() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-live", PARENT, "return 1\n"));
    // The predecessor is live: a resume starts its owner, and the fake child keeps running.
    let resumed = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new("dwfrun-live"))
        .await
        .expect("the resume answers");
    assert_eq!(resumed, json!({ "ok": true, "runId": "dwfrun-live" }));

    let answer = amend(&fx.service, amend_request("dwfrun-live", "return 2\n")).await;
    let AmendResult::Started {
        run_id,
        superseded_run_id,
    } = answer
    else {
        panic!("the amend starts a successor: {answer:?}");
    };
    assert_eq!(superseded_run_id, Some(WorkflowRunId::new("dwfrun-live")));

    // The stop was awaited, so the predecessor's settlement is already on its row.
    let predecessor = row(&fx, "dwfrun-live");
    assert_eq!(predecessor.status, DwfStatus::Stopped);
    assert_eq!(predecessor.stop_reason, Some(DwfStop::Superseded));
    assert_eq!(predecessor.superseded_by.as_deref(), Some(run_id.as_str()));

    let successor = row(&fx, run_id.as_str());
    assert_eq!(successor.resumed_from.as_deref(), Some("dwfrun-live"));
    wait_until("the successor to be live", || fx.service.run_count() == 1).await;
}

#[tokio::test]
async fn get_script_reads_the_stored_script_of_this_session_only() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-text", PARENT, "return 7\n"));
    let port = fx.service.for_session(&SessionId::new(PARENT));
    let own = port
        .get_script(&WorkflowRunId::new("dwfrun-text"))
        .await
        .expect("the read answers");
    assert_eq!(own.as_deref(), Some("return 7\n"));
    let unknown = port
        .get_script(&WorkflowRunId::new("dwfrun-none"))
        .await
        .expect("the read answers");
    assert_eq!(unknown, None);
    let other = fx
        .service
        .for_session(&SessionId::new(OTHER))
        .get_script(&WorkflowRunId::new("dwfrun-text"))
        .await
        .expect("the read answers");
    assert_eq!(other, None, "another session's run is unknown here");
}

#[tokio::test]
async fn an_amend_names_another_parent_than_its_port_is_refused_before_anything_is_read() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-named", PARENT, "return 1\n"));
    let mut request = amend_request("dwfrun-named", "return 2\n");
    request.parent_session_id = Some(SessionId::new(OTHER));
    let error = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .amend(request)
        .await
        .expect_err("a wiring fault is an error");
    assert!(error.message.contains("belongs to"), "{}", error.message);
    assert!(fx.fake.launches().is_empty());
}

#[tokio::test]
async fn a_non_finite_limit_is_refused_before_anything_is_stopped() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-inf", PARENT, "return 1\n"));
    for bad in [f64::INFINITY, f64::NAN] {
        let mut request = amend_request("dwfrun-inf", "return 2\n");
        request.max_concurrency = Some(bad);
        let error = fx
            .service
            .for_session(&SessionId::new(PARENT))
            .amend(request)
            .await
            .expect_err("a non-finite limit is a wiring fault");
        assert!(error.message.contains("finite"), "{}", error.message);
    }
    assert!(fx.fake.launches().is_empty(), "no successor is started");
    assert_eq!(
        row(&fx, "dwfrun-inf").stop_reason,
        Some(DwfStop::Interrupted)
    );
}

#[tokio::test]
async fn phase_routing_is_refused_not_dropped() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-phase", PARENT, "return 1\n"));
    let mut phases = amend_request("dwfrun-phase", "return 2\n");
    phases.phase_names = Some(vec!["main".to_owned()]);
    // Inherited arguments are carried since 9.50 (the settings route); see `workflow_run_settings_tests`.
    for request in [phases] {
        let error = fx
            .service
            .for_session(&SessionId::new(PARENT))
            .amend(request)
            .await
            .expect_err("an option this host cannot carry is refused");
        assert!(error.message.contains("cannot"), "{}", error.message);
    }
    assert!(fx.fake.launches().is_empty());
}

/// A fill request for `run_id`'s hole `hole#1` (9.45).
fn fill_request(run_id: &str) -> FillHoleRequest {
    FillHoleRequest {
        run_id: WorkflowRunId::new(run_id),
        hole_id: "hole#1".to_owned(),
        body: "return 1;".to_owned(),
        parent_session_id: None,
    }
}

async fn fill(service: &WorkflowRunService, request: FillHoleRequest) -> FillHoleOutcome {
    service
        .for_session(&SessionId::new(PARENT))
        .fill_hole(request)
        .await
        .expect("the fill answers")
}

/// W7-12 (9.45): a fill of a run that is not in the journal is refused as `run_not_found`, and nothing starts.
#[tokio::test]
async fn a_fill_of_an_unknown_run_is_refused_as_run_not_found() {
    let fx = fixture(|_| {});
    let answer = fill(&fx.service, fill_request("dwfrun-none")).await;
    assert!(matches!(
        answer,
        FillHoleOutcome::Refused {
            reason: FillRefusalReason::RunNotFound,
            ..
        }
    ));
    assert!(fx.fake.launches().is_empty(), "no child is started");
}

/// W7-12 (9.45): a fill that names another parent session than the port's is a wiring fault, and it changes nothing.
#[tokio::test]
async fn a_fill_that_names_another_parent_is_a_wiring_fault() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-named", PARENT, "return 1\n"));
    let mut request = fill_request("dwfrun-named");
    request.parent_session_id = Some(SessionId::new(OTHER));
    let answer = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .fill_hole(request)
        .await;
    assert!(answer.is_err(), "the mismatch is an error: {answer:?}");
}

/// W7-12 (9.45): a run of another session is unknown to this session's fill, as it is to amend.
#[tokio::test]
async fn a_fill_of_another_sessions_run_is_refused_as_run_not_found() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-other", OTHER, "return 1\n"));
    let answer = fill(&fx.service, fill_request("dwfrun-other")).await;
    assert!(matches!(
        answer,
        FillHoleOutcome::Refused {
            reason: FillRefusalReason::RunNotFound,
            ..
        }
    ));
}

/// A child runner whose helper answers every fill with `outcome` (9.45): a refusal, or the ready reply a fill applies.
struct ScriptedFill {
    fake: Arc<FakeChildRunner>,
    outcome: FillPrepareOutcome,
    /// Every preparation's input, in order (9.65, 906).
    inputs: Arc<std::sync::Mutex<Vec<FillPrepareInput>>>,
}

#[async_trait]
impl WorkflowChildRunner for ScriptedFill {
    async fn start(
        &self,
        input: LaunchInput,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<RunningChild, LaunchError> {
        let mut running = self.fake.start(input, handler).await?;
        running.compiled = compiled_facts();
        Ok(running)
    }

    async fn prepare_fill(
        &self,
        input: FillPrepareInput,
    ) -> Result<FillPrepareOutcome, LaunchError> {
        self.inputs.lock().unwrap().push(input);
        Ok(self.outcome.clone())
    }
}

/// A `compile_failed` refusal with one diagnostic, as the helper sends it.
fn compile_refusal() -> FillPrepareOutcome {
    FillPrepareOutcome::Refused {
        reason: "compile_failed".to_owned(),
        message: "The effective script does not compile (1 diagnostic); nothing was spliced and the hole is still waiting."
            .to_owned(),
        diagnostics: Some(json!([{"line": 3, "column": 5, "message": "bad", "code": 9001}])),
    }
}

/// A fixture whose helper answers every fill with `outcome` (the rest as `fixture`).
fn fixture_scripted_fills(
    seed: impl FnOnce(&rusqlite::Connection),
    outcome: FillPrepareOutcome,
) -> Fixture {
    fixture_recorded_fills(seed, outcome, Arc::default())
}

fn fixture_recorded_fills(
    seed: impl FnOnce(&rusqlite::Connection),
    outcome: FillPrepareOutcome,
    inputs: Arc<std::sync::Mutex<Vec<FillPrepareInput>>>,
) -> Fixture {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("session.db");
    let conn = open(&path);
    add_session(&conn, PARENT);
    add_session(&conn, OTHER);
    seed(&conn);
    let store = Arc::new(SqliteRunStore::new(conn, || 500));
    let fake = Arc::new(FakeChildRunner::new());
    let runner: Arc<dyn WorkflowChildRunner> = Arc::new(ScriptedFill {
        fake: fake.clone(),
        outcome,
        inputs,
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
    service.configure_bindings(Arc::new(Mode));
    Fixture {
        _dir: dir,
        path,
        service,
        fake,
    }
}

/// W7-12 (9.45): a fill the helper refuses as `compile_failed` on a live run is refused with the helper's text and its
/// diagnostics, and the run keeps its hole waiting (no fill is applied).
#[tokio::test]
async fn a_fill_the_helper_refuses_as_compile_failed_keeps_the_hole_waiting() {
    let fx = fixture_scripted_fills(
        |conn| interrupted(conn, "dwfrun-refused", PARENT, "return 1\n"),
        compile_refusal(),
    );
    fx.service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new("dwfrun-refused"))
        .await
        .expect("the resume answers");
    let answer = fill(&fx.service, fill_request("dwfrun-refused")).await;
    assert!(
        matches!(
            &answer,
            FillHoleOutcome::Refused {
                reason: FillRefusalReason::CompileFailed,
                diagnostics: Some(_),
                ..
            }
        ),
        "the helper's compile refusal is the answer: {answer:?}"
    );
    // Nothing is spliced: the stored script is the one the run had.
    let stored = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .get_script(&WorkflowRunId::new("dwfrun-refused"))
        .await
        .expect("the script reads");
    assert_eq!(stored.as_deref(), Some("return 1\n"));
}

/// 9.65 (closes 906 and 512): the fill carries the run's journaled model bindings to the helper (Node passes
/// `entry.modelBindings` to `unboundFillModelDiagnostics`), so a fill whose body names a model the run did not bind is
/// refused there; a run that named no model sends none.
#[tokio::test]
async fn a_fill_carries_the_runs_model_bindings_to_the_helper() {
    for (bindings, expected) in [
        (
            Some(json!({"poet": "deepseek/deepseek-v4-flash"})),
            Some(json!({"poet": "deepseek/deepseek-v4-flash"})),
        ),
        (None, None),
    ] {
        let inputs: Arc<std::sync::Mutex<Vec<FillPrepareInput>>> = Arc::default();
        let fx = fixture_recorded_fills(
            |conn| {
                interrupted(conn, "dwfrun-bound", PARENT, "return 1\n");
                if let Some(bindings) = &bindings {
                    dwf::append_event(
                        conn,
                        "dwfrun-bound",
                        &json!({"type": "run-launched", "modelBindings": bindings}),
                        2,
                    )
                    .expect("seed the launch event");
                }
            },
            compile_refusal(),
            inputs.clone(),
        );
        fx.service
            .for_session(&SessionId::new(PARENT))
            .resume(&WorkflowRunId::new("dwfrun-bound"))
            .await
            .expect("the resume answers");
        fill(&fx.service, fill_request("dwfrun-bound")).await;
        let seen = inputs.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "one preparation");
        assert_eq!(seen[0].model_bindings, expected, "{bindings:?}");
    }
}

/// W7-12 (9.45): a fill the helper prepares and the owner applies returns `Filled` with the phases it added and the
/// effective script; the parked hole's request resolves with the code; the stored script becomes the effective one.
#[tokio::test]
async fn a_fill_applies_the_helper_reply_and_releases_the_parked_hole() {
    let ready = FillPrepareOutcome::Ready(json!({
        "ok": true,
        "effectiveText": "return 'approved';\n",
        "scriptHash": "hash-2",
        "code": "return 'approved';",
        "askSpecs": {},
        "sitePhases": {},
        "phaseNames": ["main"],
        "phasesAdded": ["main"],
    }));
    let fx = fixture_scripted_fills(
        |conn| interrupted(conn, "dwfrun-fill", PARENT, "return 1\n"),
        ready,
    );
    fx.service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new("dwfrun-fill"))
        .await
        .expect("the resume answers");
    // The script parks a branch at the hole, as the child does: a `hole` request with no body.
    let handler = fx.fake.launches()[0].handler.clone();
    let parked = tokio::spawn(handler.request(
        ChildRequest {
            id: "req-hole".to_owned(),
            request_type: RequestType::Hole,
            site_id: "hole#1".to_owned(),
            actor: None,
            instructions: None,
            name: Some("decide".to_owned()),
            prompt: None,
            op: None,
            artifact_op: None,
            args: None,
        },
        None,
    ));
    // The fill may come before the branch parks; the helper's refusal then says it is not waiting yet, so retry.
    let mut answer = fill(&fx.service, fill_request("dwfrun-fill")).await;
    for _ in 0..400 {
        // Retry only while the hole is not waiting yet, matched by the reason, not the wording.
        if !matches!(
            &answer,
            FillHoleOutcome::Refused {
                reason: FillRefusalReason::HoleNotWaiting,
                ..
            }
        ) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
        answer = fill(&fx.service, fill_request("dwfrun-fill")).await;
    }
    assert_eq!(
        answer,
        FillHoleOutcome::Filled {
            phases_added: vec!["main".to_owned()],
            script_text: "return 'approved';\n".to_owned(),
        }
    );
    let released = tokio::time::timeout(Duration::from_secs(5), parked)
        .await
        .expect("the parked hole is released")
        .expect("the request task ends")
        .expect("the parked hole answers");
    assert_eq!(released, json!({"code": "return 'approved';"}));
    let stored = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .get_script(&WorkflowRunId::new("dwfrun-fill"))
        .await
        .expect("the script reads");
    assert_eq!(stored.as_deref(), Some("return 'approved';\n"));
}

/// W7-12 (9.45): a stopped run is not in flight, so its hole is not waiting; the text says to resume it first (Node's hint).
#[tokio::test]
async fn a_fill_of_a_stopped_run_is_refused_with_the_resume_hint() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-stopped", PARENT, "return 1\n"));
    let answer = fill(&fx.service, fill_request("dwfrun-stopped")).await;
    assert!(
        matches!(
            &answer,
            FillHoleOutcome::Refused {
                reason: FillRefusalReason::HoleNotWaiting,
                message,
                ..
            } if message.contains("ResumeWorkflowRun it first")
        ),
        "the stopped run's fill names the resume: {answer:?}"
    );
    assert!(fx.fake.launches().is_empty(), "no child is started");
}

#[tokio::test]
async fn a_failure_after_the_stop_names_the_superseded_predecessor() {
    let fx = fixture_with_bindings(
        |conn| interrupted(conn, "dwfrun-after", PARENT, "return 1\n"),
        Arc::new(FailingMode),
    );
    let resumed = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new("dwfrun-after"))
        .await
        .expect("the resume answers");
    assert_eq!(resumed, json!({ "ok": true, "runId": "dwfrun-after" }));

    let error = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .amend(amend_request("dwfrun-after", "return 2\n"))
        .await
        .expect_err("the parent mode cannot be read");
    assert!(
        error.message.contains("dwfrun-after") && error.message.contains("superseded"),
        "the caller learns the predecessor was already stopped: {}",
        error.message
    );
    assert_eq!(
        row(&fx, "dwfrun-after").stop_reason,
        Some(DwfStop::Superseded)
    );
}

#[tokio::test]
async fn a_failed_amend_can_be_retried_from_the_stopped_predecessor() {
    let fx = fixture_with_bindings(
        |conn| interrupted(conn, "dwfrun-retry", PARENT, "return 1\n"),
        Arc::new(FlakyMode(std::sync::atomic::AtomicBool::new(true))),
    );
    fx.service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new("dwfrun-retry"))
        .await
        .expect("the resume answers");
    let error = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .amend(amend_request("dwfrun-retry", "return 2\n"))
        .await
        .expect_err("the first mode read fails after the stop");
    assert!(
        error.message.contains("amend it again to retry"),
        "{}",
        error.message
    );
    assert_eq!(
        row(&fx, "dwfrun-retry").stop_reason,
        Some(DwfStop::Superseded)
    );

    // The retry: the predecessor is settled now, so it is not stopped again and its import reads the superseded row.
    let answer = amend(&fx.service, amend_request("dwfrun-retry", "return 2\n")).await;
    let AmendResult::Started {
        run_id,
        superseded_run_id,
    } = answer
    else {
        panic!("the retry starts a successor: {answer:?}");
    };
    assert_eq!(
        superseded_run_id, None,
        "the predecessor had already settled"
    );
    let launches = fx.fake.launches();
    let last = launches.last().expect("the retry launched a child");
    assert_eq!(last.input.run_id, run_id.as_str());
    assert_eq!(last.input.resumed_from.as_deref(), Some("dwfrun-retry"));
    // The resume, then a compile probe and a start for each amend. The failed amend's probe was stopped and registers no run.
    assert_eq!(
        launches.len(),
        4,
        "the resume, the failed amend's probe, the retry's probe and its start"
    );
}

#[tokio::test]
async fn the_successor_inherits_the_predecessor_limit_unless_one_is_given() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-limit", PARENT, "return 1\n"));
    let answer = amend(&fx.service, amend_request("dwfrun-limit", "return 2\n")).await;
    let AmendResult::Started { run_id, .. } = answer else {
        panic!("the amend starts a successor: {answer:?}");
    };
    assert_eq!(
        row(&fx, run_id.as_str()).max_concurrency,
        4,
        "the predecessor's limit"
    );

    let mut given = amend_request("dwfrun-limit", "return 3\n");
    given.max_concurrency = Some(2.0);
    let answer = amend(&fx.service, given).await;
    let AmendResult::Started { run_id, .. } = answer else {
        panic!("the amend starts a successor: {answer:?}");
    };
    assert_eq!(
        row(&fx, run_id.as_str()).max_concurrency,
        2,
        "the limit the call gave"
    );
}

// ---- 9.50 (W8c): the in-place retune, the GUI settings change and the settings turn's text.

use rust_cli_kernel_api::workflow_run::{RetuneOutcome, RetuneRefusal, RetuneRequest};
use std::sync::Mutex as TestMutex;

use rust_cli_kernel_api::workflow_run::{
    LaunchTurn, SettingsAmend, SettingsChange, SettingsOutcome, SettingsRefusal, SettingsRequest,
    SettingsTurn, WorkflowTurnSink,
};

use super::settings::settings_message_text;

/// The parent's side as a test sees it: the activations and the settings turns, in order.
#[derive(Default)]
struct Recorder {
    activations: TestMutex<usize>,
    turns: TestMutex<Vec<SettingsTurn>>,
}

#[async_trait::async_trait]
impl WorkflowTurnSink for Recorder {
    fn activate(&self) -> bool {
        *self.activations.lock().unwrap() += 1;
        true
    }

    fn settings_turn(&self, turn: SettingsTurn) {
        self.turns.lock().unwrap().push(turn);
    }

    fn launch_turn(&self, _turn: LaunchTurn) {}
}

/// A stopped run with its stored arguments, as an earlier process interrupted it.
fn interrupted_with_args(conn: &rusqlite::Connection, id: &str, parent: &str, args: Value) {
    let run = RunRecord {
        run_id: id.to_owned(),
        parent_session_id: Some(parent.to_owned()),
        cwd: Some("project".to_owned()),
        script_text: Some("return 1\n".to_owned()),
        args: Some(args),
        max_concurrency: 4,
        status: DwfStatus::Stopped,
        stop_reason: Some(DwfStop::Interrupted),
        failure: Some(json!({ "code": "Interrupted", "message": "the run was interrupted" })),
        ..RunRecord::default()
    };
    dwf::create_run(conn, &run, 1).expect("seed run row");
}

fn settings(run: &str, max: Option<Option<f64>>) -> SettingsRequest {
    SettingsRequest {
        run_id: WorkflowRunId::new(run),
        subagent_model: None,
        max_concurrency: max,
    }
}

/// A live run of the parent: resumed from its stopped row, so its owner keeps running in the fake child.
async fn live_run(fx: &Fixture, id: &str) {
    let resumed = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new(id))
        .await
        .expect("the resume answers");
    assert_eq!(resumed, json!({ "ok": true, "runId": id }));
}

#[tokio::test]
async fn a_concurrency_change_on_a_live_run_is_applied_in_place_with_one_settings_turn() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-live-cfg", PARENT, "return 1\n"));
    live_run(&fx, "dwfrun-live-cfg").await;
    let sink = Recorder::default();

    let answer = fx
        .service
        .amend_settings(PARENT, settings("dwfrun-live-cfg", Some(Some(2.0))), &sink)
        .await
        .expect("the change answers");
    let SettingsOutcome::Retuned {
        run_id,
        tool_call_id,
    } = answer
    else {
        panic!("a live run is retuned in place: {answer:?}");
    };
    assert_eq!(
        run_id,
        WorkflowRunId::new("dwfrun-live-cfg"),
        "the same run"
    );
    assert!(tool_call_id.starts_with("settings-"));
    assert_eq!(
        row(&fx, "dwfrun-live-cfg").max_concurrency,
        2,
        "the cap is written to the row"
    );
    assert_eq!(fx.fake.launches().len(), 1, "no successor was started");
    assert_eq!(*sink.activations.lock().unwrap(), 1);
    let turns = sink.turns.lock().unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].run_id, WorkflowRunId::new("dwfrun-live-cfg"));
    assert_eq!(
        turns[0].text,
        "Changed the settings of workflow run dwfrun-live-cfg from the GUI: at most 2 of its subagents run at once. \
         Run dwfrun-live-cfg keeps running under the new limit; nothing was stopped and no new run was started. \
         Progress and results arrive as background notifications; do not amend, resume or restart it."
    );
    assert_eq!(turns[0].amend.predecessor_run_id, None);
    assert_eq!(
        turns[0].amend.max_concurrency,
        Some(SettingsChange {
            from: Some(4.0),
            to: Some(2.0)
        })
    );
    assert_eq!(
        turns[0].title_input, "dwfrun-live-cfg",
        "an unnamed run seeds its title with its id"
    );
}

#[tokio::test]
async fn returning_a_live_run_to_the_default_keeps_it_with_no_limit() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-live-default", PARENT, "return 1\n"));
    live_run(&fx, "dwfrun-live-default").await;
    let sink = Recorder::default();

    let answer = fx
        .service
        .amend_settings(PARENT, settings("dwfrun-live-default", Some(None)), &sink)
        .await
        .expect("the change answers");
    assert!(
        matches!(answer, SettingsOutcome::Retuned { .. }),
        "{answer:?}"
    );
    assert_eq!(
        row(&fx, "dwfrun-live-default").max_concurrency,
        DEFAULT as i64
    );
    let turns = sink.turns.lock().unwrap();
    assert_eq!(
        turns[0].text,
        "Changed the settings of workflow run dwfrun-live-default from the GUI: the limit on subagents at once is back to the default. \
         Run dwfrun-live-default keeps running with no limit; nothing was stopped and no new run was started. \
         Progress and results arrive as background notifications; do not amend, resume or restart it."
    );
}

#[tokio::test]
async fn a_change_to_a_settled_run_amends_it_and_the_successor_inherits_the_arguments() {
    let fx = fixture(|conn| {
        interrupted_with_args(conn, "dwfrun-settled-cfg", PARENT, json!({ "topic": "x" }))
    });
    let sink = Recorder::default();

    let answer = fx
        .service
        .amend_settings(
            PARENT,
            settings("dwfrun-settled-cfg", Some(Some(2.0))),
            &sink,
        )
        .await
        .expect("the change answers");
    let SettingsOutcome::Amended {
        run_id,
        superseded_run_id,
        ..
    } = answer
    else {
        panic!("a settled run is amended: {answer:?}");
    };
    assert_eq!(
        superseded_run_id, None,
        "a settled predecessor is not superseded"
    );
    let successor = row(&fx, run_id.as_str());
    assert_eq!(
        successor.resumed_from.as_deref(),
        Some("dwfrun-settled-cfg")
    );
    assert_eq!(
        successor.args,
        Some(json!({ "topic": "x" })),
        "the arguments are inherited"
    );
    assert_eq!(successor.max_concurrency, 2);
    assert_eq!(*sink.activations.lock().unwrap(), 1);
    let turns = sink.turns.lock().unwrap();
    assert_eq!(turns[0].run_id, run_id);
    assert_eq!(
        turns[0]
            .amend
            .predecessor_run_id
            .as_ref()
            .map(WorkflowRunId::as_str),
        Some("dwfrun-settled-cfg")
    );
    assert_eq!(
        turns[0].text,
        format!(
            "Changed the settings of workflow run dwfrun-settled-cfg from the GUI: at most 2 of them run at once. \
             The same script continues as run {run_id}, which takes over from run dwfrun-settled-cfg and imports everything run dwfrun-settled-cfg finished as cache. \
             Progress and results arrive as background notifications; do not amend, resume or restart it."
        )
    );
}

#[tokio::test]
async fn an_unchanged_limit_changes_nothing_and_says_so() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-same", PARENT, "return 1\n"));
    let sink = Recorder::default();
    for max in [None, Some(Some(4.0))] {
        let answer = fx
            .service
            .amend_settings(PARENT, settings("dwfrun-same", max), &sink)
            .await
            .expect("the change answers");
        assert_eq!(answer, SettingsOutcome::Refused(SettingsRefusal::Unchanged));
    }
    assert!(fx.fake.launches().is_empty());
    assert!(sink.turns.lock().unwrap().is_empty());
    assert_eq!(row(&fx, "dwfrun-same").status, DwfStatus::Stopped);
}

#[tokio::test]
async fn a_completed_run_is_not_configurable_and_another_sessions_run_is_not_found() {
    let fx = fixture(|conn| {
        interrupted(conn, "dwfrun-other", OTHER, "return 1\n");
        let done = RunRecord {
            run_id: "dwfrun-done".to_owned(),
            parent_session_id: Some(PARENT.to_owned()),
            cwd: Some("project".to_owned()),
            script_text: Some("return 1\n".to_owned()),
            max_concurrency: 4,
            status: DwfStatus::Completed,
            ..RunRecord::default()
        };
        dwf::create_run(conn, &done, 1).expect("seed completed run");
    });
    let sink = Recorder::default();
    let done = fx
        .service
        .amend_settings(PARENT, settings("dwfrun-done", Some(Some(2.0))), &sink)
        .await
        .expect("answers");
    assert_eq!(
        done,
        SettingsOutcome::Refused(SettingsRefusal::NotConfigurable)
    );
    let other = fx
        .service
        .amend_settings(PARENT, settings("dwfrun-other", Some(Some(2.0))), &sink)
        .await
        .expect("answers");
    assert_eq!(other, SettingsOutcome::Refused(SettingsRefusal::NotFound));
    let unknown = fx
        .service
        .amend_settings(PARENT, settings("dwfrun-missing", Some(Some(2.0))), &sink)
        .await
        .expect("answers");
    assert_eq!(unknown, SettingsOutcome::Refused(SettingsRefusal::NotFound));
    assert!(fx.fake.launches().is_empty());
    assert!(sink.turns.lock().unwrap().is_empty());
}

/// 9.63: the fixture's catalog, two DeepSeek models with no levels.
struct Catalog;

#[async_trait]
impl rust_cli_kernel_api::provider::ModelDirectory for Catalog {
    async fn catalog(&self) -> rust_cli_kernel_api::provider::ModelCatalog {
        let model = |name: &str| rust_cli_kernel_api::provider::CatalogModel {
            provider: "deepseek".to_owned(),
            provider_name: "DeepSeek".to_owned(),
            model: name.to_owned(),
            protocol: rust_cli_kernel_api::provider::WireProtocol::AnthropicMessages,
            reasoning_levels: Vec::new(),
            default_reasoning_level: None,
            context_window: 1,
            max_output_tokens: 1,
            capabilities: Default::default(),
            connection: None,
            host: None,
        };
        rust_cli_kernel_api::provider::ModelCatalog {
            revision: 1,
            models: vec![model("deepseek-v4-flash"), model("deepseek-v4-pro")],
            default: None,
        }
    }
}

fn with_catalog(fx: &Fixture) {
    let models = Arc::new(rust_cli_kernel_api::provider::LateModelDirectory::default());
    assert!(models.set(Arc::new(Catalog)));
    assert!(fx.service.configure_models(models));
}

/// The successor's `run-launched` payload, once its owner wrote it.
async fn launch_of(fx: &Fixture, run: &str) -> Value {
    let path = fx.path.clone();
    let id = run.to_owned();
    wait_until("the successor's run-launched event", || {
        dwf::run_launched_payload(&open(&path), &id)
            .ok()
            .flatten()
            .is_some()
    })
    .await;
    dwf::run_launched_payload(&open(&fx.path), run)
        .expect("the read")
        .expect("the launch")
}

/// 9.63 (DWR-06, closes 663): a subagent-model change always amends (never in place). The successor runs on the
/// canonical model, the turn records the change, and its text says where the subagents now run.
#[tokio::test]
async fn a_subagent_model_change_amends_the_run_onto_the_new_model() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-model", PARENT, "return 1\n"));
    with_catalog(&fx);
    let sink = Recorder::default();
    let mut request = settings("dwfrun-model", None);
    request.subagent_model = Some(Some("deepseek/deepseek-v4-pro".to_owned()));
    let answer = fx
        .service
        .amend_settings(PARENT, request, &sink)
        .await
        .expect("answers");
    let SettingsOutcome::Amended { run_id, .. } = answer else {
        panic!("a model change amends: {answer:?}");
    };
    let launch = launch_of(&fx, run_id.as_str()).await;
    assert_eq!(launch["subagentModel"], json!("deepseek/deepseek-v4-pro"));
    let turns = sink.turns.lock().unwrap().clone();
    assert_eq!(
        turns[0].amend.subagent_model,
        Some(rust_cli_kernel_api::workflow_run::ModelChange {
            from: None,
            to: Some("deepseek/deepseek-v4-pro".to_owned()),
        })
    );
    assert_eq!(
        turns[0].amend.max_concurrency, None,
        "the limit did not change"
    );
    assert!(
        turns[0]
            .text
            .contains("from the GUI: its subagents now run on deepseek/deepseek-v4-pro."),
        "{}",
        turns[0].text
    );
}

/// 9.63: a model the catalog does not have, or any model with no catalog, is refused before anything changes.
#[tokio::test]
async fn an_unusable_subagent_model_is_refused_before_anything_changes() {
    for catalog in [true, false] {
        let fx = fixture(|conn| interrupted(conn, "dwfrun-model", PARENT, "return 1\n"));
        if catalog {
            with_catalog(&fx);
        }
        let sink = Recorder::default();
        let mut request = settings("dwfrun-model", Some(Some(2.0)));
        request.subagent_model = Some(Some("provider/model".to_owned()));
        let answer = fx
            .service
            .amend_settings(PARENT, request, &sink)
            .await
            .expect("answers");
        let SettingsOutcome::Refused(SettingsRefusal::ModelUnavailable { message }) = answer else {
            panic!("refused: {answer:?}");
        };
        // 9.65 (closes 921): Node sends the resolver's message only with a catalog; without one the GUI gets the
        // reason alone (the model-facing "omit subagent_model" text is not for people).
        assert_eq!(message.is_some(), catalog, "{message:?}");
        assert!(fx.fake.launches().is_empty());
        assert_eq!(row(&fx, "dwfrun-model").status, DwfStatus::Stopped);
        assert!(sink.turns.lock().unwrap().is_empty());
    }
}

/// 9.63 (closes 665): the models a run's script named are rebound from its launch, re-resolved, and carried to the
/// successor; one that no longer resolves refuses the change before the predecessor is touched.
#[tokio::test]
async fn a_run_whose_launch_names_models_is_rebound_or_refused_before_the_predecessor_is_stopped() {
    for (bound, usable) in [
        ("deepseek/deepseek-v4-flash", true),
        ("openai/gpt-x", false),
    ] {
        let fx = fixture(|conn| {
            interrupted(conn, "dwfrun-named", PARENT, "return 1\n");
            dwf::append_event(
                conn,
                "dwfrun-named",
                &json!({ "type": "run-launched", "modelBindings": { "poet": bound } }),
                2,
            )
            .expect("seed the launch event");
        });
        with_catalog(&fx);
        let sink = Recorder::default();
        let answer = fx
            .service
            .amend_settings(PARENT, settings("dwfrun-named", Some(Some(2.0))), &sink)
            .await
            .expect("answers");
        if usable {
            let SettingsOutcome::Amended { run_id, .. } = answer else {
                panic!("the bound models are kept: {answer:?}");
            };
            let launch = launch_of(&fx, run_id.as_str()).await;
            assert_eq!(launch["modelBindings"], json!({ "poet": bound }));
            continue;
        }
        let SettingsOutcome::Refused(SettingsRefusal::ModelUnavailable {
            message: Some(message),
        }) = answer
        else {
            panic!("a bound model that is gone refuses: {answer:?}");
        };
        assert!(
            message.starts_with(
                "The models named in the script of run dwfrun-named cannot be used now:"
            ),
            "{message}"
        );
        assert_eq!(row(&fx, "dwfrun-named").superseded_by, None);
        assert!(fx.fake.launches().is_empty());
        assert!(sink.turns.lock().unwrap().is_empty());
    }
}

/// 9.63 review: the refusal for many models that are gone is bounded as Node bounds compile diagnostics (2000 chars).
#[tokio::test]
async fn a_settings_refusal_for_many_unusable_models_is_bounded() {
    let bindings: serde_json::Map<String, Value> = (0..80)
        .map(|index| {
            (
                format!("persona-{index}"),
                json!(format!("openai/gpt-{index}")),
            )
        })
        .collect();
    let fx = fixture(|conn| {
        interrupted(conn, "dwfrun-many", PARENT, "return 1\n");
        dwf::append_event(
            conn,
            "dwfrun-many",
            &json!({ "type": "run-launched", "modelBindings": bindings }),
            2,
        )
        .expect("seed the launch event");
    });
    with_catalog(&fx);
    let answer = fx
        .service
        .amend_settings(
            PARENT,
            settings("dwfrun-many", Some(Some(2.0))),
            &Recorder::default(),
        )
        .await
        .expect("answers");
    let SettingsOutcome::Refused(SettingsRefusal::ModelUnavailable {
        message: Some(message),
    }) = answer
    else {
        panic!("the gone models refuse: {answer:?}");
    };
    assert!(
        message.chars().count() <= 2000,
        "{} chars",
        message.chars().count()
    );
    assert!(message.ends_with('…'), "{message}");
    assert!(
        message
            .starts_with("The models named in the script of run dwfrun-many cannot be used now:")
    );
}

/// 9.65 (918): the settings route's checker. A script containing `BROKEN` has one error at L1:C7; each line
/// `// model <name>` names `<name>` at that line, column 4 (a persona's model reference).
struct Checker;

#[async_trait]
impl rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer for Checker {
    async fn analyze(
        &self,
        script: &str,
    ) -> Result<
        rust_cli_kernel_api::workflow_analysis::WorkflowAnalysis,
        rust_cli_kernel_api::workflow_analysis::WorkflowAnalysisError,
    > {
        use rust_cli_kernel_api::workflow_analysis::{
            ModelReference, WorkflowAnalysis, WorkflowDiagnostic,
        };
        if script.contains("BROKEN") {
            return Ok(WorkflowAnalysis {
                ok: false,
                diagnostics: vec![WorkflowDiagnostic {
                    code: 2322,
                    line: 1,
                    column: 7,
                    message: "Type 'string' is not assignable to type 'number'.".to_owned(),
                }],
                model_references: Vec::new(),
                display: None,
            });
        }
        let model_references = script
            .lines()
            .enumerate()
            .filter_map(|(index, line)| {
                line.strip_prefix("// model ").map(|name| ModelReference {
                    name: name.to_owned(),
                    line: index as i64 + 1,
                    column: 4,
                })
            })
            .collect();
        Ok(WorkflowAnalysis {
            ok: true,
            diagnostics: Vec::new(),
            model_references,
            display: Some(
                json!({"kind": "create_workflow", "ok": true, "causalityGraph": {"steps": []}}),
            ),
        })
    }
}

fn with_checker(fx: &Fixture) {
    assert!(
        fx.service
            .configure_saved_start(fx.path.with_file_name("home"), Arc::new(Checker))
    );
}

/// 9.65 (closes 918): the settings route compiles the stored script first (Node step 8): a script that no longer
/// compiles is `compile_failed` with Node's bounded diagnostics, and nothing changes.
#[tokio::test]
async fn a_stored_script_that_no_longer_compiles_refuses_the_settings_change() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-broken", PARENT, "BROKEN\n"));
    with_checker(&fx);
    let sink = Recorder::default();
    let answer = fx
        .service
        .amend_settings(PARENT, settings("dwfrun-broken", Some(Some(2.0))), &sink)
        .await
        .expect("answers");
    assert_eq!(
        answer,
        SettingsOutcome::Refused(SettingsRefusal::CompileFailed {
            message: "The stored script of run dwfrun-broken has errors:\nL1:C7 Type 'string' is not assignable to type 'number'.".to_owned(),
        })
    );
    assert!(fx.fake.launches().is_empty());
    assert_eq!(row(&fx, "dwfrun-broken").superseded_by, None);
    assert!(sink.turns.lock().unwrap().is_empty());
}

/// 9.65 (closes 918): the models are bound over the compiled script's references (Node `bindScriptModels(analysis,
/// catalog, snapshot.modelBindings)`), not the launch table's keys: a name the launch did not bind is resolved fresh,
/// and a refusal names each reference at its line and column.
#[tokio::test]
async fn the_settings_route_binds_the_compiled_scripts_models_with_their_positions() {
    let fx = fixture(|conn| {
        interrupted(
            conn,
            "dwfrun-fresh",
            PARENT,
            "// model deepseek-v4-flash\nreturn 1\n",
        );
    });
    with_catalog(&fx);
    with_checker(&fx);
    let answer = fx
        .service
        .amend_settings(
            PARENT,
            settings("dwfrun-fresh", Some(Some(2.0))),
            &Recorder::default(),
        )
        .await
        .expect("answers");
    let SettingsOutcome::Amended { run_id, .. } = answer else {
        panic!("the fresh name binds: {answer:?}");
    };
    let launch = launch_of(&fx, run_id.as_str()).await;
    assert_eq!(
        launch["modelBindings"],
        json!({"deepseek-v4-flash": "deepseek/deepseek-v4-flash"})
    );

    let fx = fixture(|conn| {
        interrupted(conn, "dwfrun-gone", PARENT, "return 1\n// model gpt-x\n");
    });
    with_catalog(&fx);
    with_checker(&fx);
    let answer = fx
        .service
        .amend_settings(
            PARENT,
            settings("dwfrun-gone", Some(Some(2.0))),
            &Recorder::default(),
        )
        .await
        .expect("answers");
    let SettingsOutcome::Refused(SettingsRefusal::ModelUnavailable {
        message: Some(message),
    }) = answer
    else {
        panic!("an unknown name refuses: {answer:?}");
    };
    assert!(
        message.starts_with(
            "The models named in the script of run dwfrun-gone cannot be used now:\nL2:C4 "
        ),
        "{message}"
    );
    assert!(fx.fake.launches().is_empty());
}

/// 9.65 (919): two providers that both serve `shared`, and the parent's current model on the second.
struct TwoProviders;

#[async_trait]
impl rust_cli_kernel_api::provider::ModelDirectory for TwoProviders {
    async fn catalog(&self) -> rust_cli_kernel_api::provider::ModelCatalog {
        let model = |provider: &str, name: &str| rust_cli_kernel_api::provider::CatalogModel {
            provider: provider.to_owned(),
            provider_name: provider.to_owned(),
            model: name.to_owned(),
            protocol: rust_cli_kernel_api::provider::WireProtocol::AnthropicMessages,
            reasoning_levels: Vec::new(),
            default_reasoning_level: None,
            context_window: 1,
            max_output_tokens: 1,
            capabilities: Default::default(),
            connection: None,
            host: None,
        };
        rust_cli_kernel_api::provider::ModelCatalog {
            revision: 1,
            models: vec![
                model("alpha", "shared"),
                model("beta", "shared"),
                model("beta", "home"),
            ],
            default: None,
        }
    }
}

/// The parent session runs on `beta/home`.
struct OnBeta;

impl ActorBindingsPort for OnBeta {
    fn parent_bindings(&self, parent: &str) -> Result<Option<ParentBindings>, String> {
        Ok((parent == PARENT).then(|| ParentBindings {
            selection: Some(rust_cli_kernel_api::model::ModelSelection::new(
                "beta", "home",
            )),
            workspace: rust_cli_kernel_api::env::WorkspaceRef {
                environment: rust_cli_kernel_api::ids::EnvironmentId::new("local"),
                root: rust_cli_kernel_api::env::EnvPath::new("/work"),
            },
            interactions: None,
        }))
    }

    fn parent_permission_mode(&self, _parent: &str) -> Result<Option<PermissionMode>, String> {
        Ok(Some(PermissionMode::Default))
    }
}

/// 9.65 (closes 919): the settings route marks the parent session's model as current in the catalog (Node's
/// `currentSelection()` in `createModelCatalogPort`), so a bare name two providers serve resolves to the session's
/// provider instead of being refused as ambiguous.
#[tokio::test]
async fn a_bare_model_name_prefers_the_parent_sessions_provider() {
    let fx = fixture_with_bindings(
        |conn| interrupted(conn, "dwfrun-bare", PARENT, "return 1\n"),
        Arc::new(OnBeta),
    );
    let models = Arc::new(rust_cli_kernel_api::provider::LateModelDirectory::default());
    assert!(models.set(Arc::new(TwoProviders)));
    assert!(fx.service.configure_models(models));
    let mut request = settings("dwfrun-bare", None);
    request.subagent_model = Some(Some("shared".to_owned()));
    let answer = fx
        .service
        .amend_settings(PARENT, request, &Recorder::default())
        .await
        .expect("answers");
    let SettingsOutcome::Amended { run_id, .. } = answer else {
        panic!("the session's provider wins: {answer:?}");
    };
    let launch = launch_of(&fx, run_id.as_str()).await;
    assert_eq!(launch["subagentModel"], json!("beta/shared"));
}

/// 9.63: an amend carries the run's subagent model and the script's table to the successor's launch (Node).
#[tokio::test]
async fn an_amend_records_the_subagent_model_and_the_script_models_on_the_successor() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-a", PARENT, "return 1\n"));
    let mut request = amend_request("dwfrun-a", "return 2\n");
    request.subagent_model = Some(json!("deepseek/deepseek-v4-pro"));
    request.model_bindings = Some(json!({"checker": "deepseek/deepseek-v4-flash"}));
    let AmendResult::Started { run_id, .. } = amend(&fx.service, request).await else {
        panic!("the amend starts");
    };
    let launch = launch_of(&fx, run_id.as_str()).await;
    assert_eq!(launch["subagentModel"], json!("deepseek/deepseek-v4-pro"));
    assert_eq!(
        launch["modelBindings"],
        json!({"checker": "deepseek/deepseek-v4-flash"})
    );
}

#[tokio::test]
async fn the_port_retune_answers_not_live_for_a_settled_or_unknown_run() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-stopped", PARENT, "return 1\n"));
    let port = fx.service.for_session(&SessionId::new(PARENT));
    for id in ["dwfrun-stopped", "dwfrun-unknown"] {
        let answer = port
            .retune_concurrency(RetuneRequest {
                run_id: WorkflowRunId::new(id),
                max_concurrency: Some(2.0),
            })
            .await
            .expect("a refusal is an answer");
        assert_eq!(
            answer,
            RetuneOutcome::Refused(RetuneRefusal::NotLive),
            "{id}"
        );
    }
    assert_eq!(
        row(&fx, "dwfrun-stopped").max_concurrency,
        4,
        "nothing changed"
    );
}

#[test]
fn the_settings_text_names_the_successor_or_the_in_place_run_as_node_does() {
    let amendment = SettingsAmend {
        predecessor_run_id: Some(WorkflowRunId::new("run_a")),
        subagent_model: None,
        max_concurrency: Some(SettingsChange {
            from: Some(4.0),
            to: Some(2.0),
        }),
        default_concurrency: 6.0,
    };
    assert_eq!(
        settings_message_text(Some("Nightly"), "run_a", "run_b", true, &amendment),
        "Changed the settings of workflow run run_a (\"Nightly\") from the GUI: at most 2 of them run at once. \
         The same script continues as run run_b, which supersedes run run_a and imports everything run run_a finished as cache. \
         Progress and results arrive as background notifications; do not amend, resume or restart it."
    );
    let in_place = SettingsAmend {
        predecessor_run_id: None,
        subagent_model: None,
        max_concurrency: Some(SettingsChange {
            from: Some(2.0),
            to: None,
        }),
        default_concurrency: 6.0,
    };
    assert_eq!(
        settings_message_text(None, "run_a", "run_a", false, &in_place),
        "Changed the settings of workflow run run_a from the GUI: the limit on subagents at once is back to the default. \
         Run run_a keeps running with no limit; nothing was stopped and no new run was started. \
         Progress and results arrive as background notifications; do not amend, resume or restart it."
    );
}

/// 9.50, divergence 667 (closes 9.43's 450 for both callers): a successor script that does not compile refuses before the
/// live predecessor is stopped. The predecessor keeps running and nothing is superseded; the failure is the compile's text.
#[tokio::test]
async fn a_successor_script_that_does_not_compile_leaves_a_live_predecessor_running() {
    use rust_cli_kernel_api::workflow_child::LaunchError;
    let fx = fixture(|conn| interrupted(conn, "dwfrun-broken", PARENT, "return 1\n"));
    fx.service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new("dwfrun-broken"))
        .await
        .expect("the resume answers");
    assert_eq!(fx.service.run_count(), 1, "the predecessor is live");
    fx.fake.refuse_next(LaunchError::Rejected {
        diagnostics: Vec::new(),
        message: Some("unexpected token".to_owned()),
    });

    let error = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .amend(amend_request("dwfrun-broken", "return (\n"))
        .await
        .expect_err("a script that does not compile is refused");
    assert!(
        error.message.contains("unexpected token"),
        "{}",
        error.message
    );

    let predecessor = row(&fx, "dwfrun-broken");
    assert_eq!(
        predecessor.stop_reason, None,
        "the predecessor was not stopped"
    );
    assert_eq!(predecessor.superseded_by, None);
    assert_eq!(fx.service.run_count(), 1, "the predecessor is still live");
    assert_eq!(
        fx.fake.launches().len(),
        1,
        "only the resume launched a child"
    );
}

/// ocr finding (medium, 9.50): the compile probe compiles the successor's script with the same arguments the successor's start
/// receives, so a compile that depends on the arguments is judged the same way before the predecessor is stopped.
#[tokio::test]
async fn the_compile_probe_sees_the_arguments_the_successor_starts_with() {
    let fx = fixture(|conn| {
        interrupted_with_args(conn, "dwfrun-probe-args", PARENT, json!({ "topic": "x" }))
    });
    let mut request = amend_request("dwfrun-probe-args", "return 2\n");
    request.inherit_args = true;
    let answer = amend(&fx.service, request).await;
    assert!(matches!(answer, AmendResult::Started { .. }), "{answer:?}");

    let expected = json!({ "topic": "x" }).as_object().cloned();
    let launches = fx.fake.launches();
    assert_eq!(launches.len(), 2, "the probe, then the successor");
    assert_eq!(
        launches[0].input.args, expected,
        "the probe compiles with the inherited arguments"
    );
    assert_eq!(
        launches[1].input.args, expected,
        "the successor starts with them"
    );
}

/// ocr finding (low, 9.50): a closed service spawns no child, the probe included. An amend after close is refused before the
/// probe starts, and nothing is stopped.
#[tokio::test]
async fn an_amend_after_the_service_closed_starts_no_probe_child() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-closed", PARENT, "return 1\n"));
    fx.service.close().await;
    let result = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .amend(amend_request("dwfrun-closed", "return 2\n"))
        .await;
    assert!(
        result.is_err(),
        "a closed service refuses the amend: {result:?}"
    );
    assert!(fx.fake.launches().is_empty(), "no probe child was started");
    assert_eq!(row(&fx, "dwfrun-closed").superseded_by, None);
}
