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
    ChildHandler, LaunchError, LaunchInput, RunningChild, WorkflowChildRunner,
};
use rust_cli_kernel_api::workflow_run::{
    AmendRefusalReason, AmendRequest, AmendResult, DynamicWorkflowRunSessions,
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

#[tokio::test]
async fn a_predecessor_of_another_session_is_unknown_to_this_one() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-other", OTHER, "return 1\n"));
    let answer = amend(&fx.service, amend_request("dwfrun-other", "return 2\n")).await;
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

    let launches = fx.fake.launches();
    assert_eq!(launches.len(), 1, "the successor's child started once");
    assert_eq!(
        launches[0].input.script_text, "return 2\n",
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
async fn phase_routing_and_inherited_arguments_are_refused_not_dropped() {
    let fx = fixture(|conn| interrupted(conn, "dwfrun-phase", PARENT, "return 1\n"));
    let mut phases = amend_request("dwfrun-phase", "return 2\n");
    phases.phase_names = Some(vec!["main".to_owned()]);
    let mut args = amend_request("dwfrun-phase", "return 2\n");
    args.inherit_args = true;
    for request in [phases, args] {
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
