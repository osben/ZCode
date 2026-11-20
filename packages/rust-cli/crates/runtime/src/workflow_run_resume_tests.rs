//! Tests of run-level resume and the quota resumer (specs/fork-rust-workflow-engine.md, 9.37, W7-7b). The journal is a
//! real session database in a temp directory; the owner is the production owner factory (`DwfJournal`), so the resume
//! takes the engine's resume branch over the row the test wrote. The child is `FakeChildRunner`, wrapped to answer with
//! the compile's tables.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_analysis::WorkflowDiagnostic;
use rust_cli_kernel_api::workflow_child::{
    ChildHandler, LaunchError, LaunchInput, Outcome, RunningChild, WorkflowChildRunner,
};
use rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions;
use rust_cli_node_store::dwf::{self, RunRecord, RunStatus as DwfStatus, StopReason as DwfStop};
use rust_cli_workflow::engine::{AskSpec, EngineConfig};
use rust_cli_workflow::quota_resume::ResumeAnswer;
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};
use rust_cli_workflow::run_store::SqliteRunStore;
use serde_json::{Map, Value, json};

use crate::workflow_owner::{OwnerStores, UnwiredRelease, UnwiredTurns, production_owner_factory};
use crate::workflow_quota::StoreQuotaReads;
use crate::workflow_run::WorkflowRunService;

const PARENT: &str = "ses_p";

/// The compile's tables a healthy script reports (the helper's `askSpecs` and `sitePhases`).
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

/// One journal row, as a test needs it: the given status, script, settlement and parent.
#[derive(Default)]
struct Row {
    id: &'static str,
    parent: Option<&'static str>,
    script: Option<&'static str>,
    status: Option<DwfStatus>,
    stop_reason: Option<DwfStop>,
    superseded_by: Option<&'static str>,
    failure: Option<Value>,
    script_hash: Option<&'static str>,
}

fn seed(conn: &rusqlite::Connection, row: Row) {
    let run = RunRecord {
        run_id: row.id.to_owned(),
        parent_session_id: row.parent.map(str::to_owned),
        cwd: Some("project".to_owned()),
        script_text: row.script.map(str::to_owned),
        script_hash: row.script_hash.map(str::to_owned),
        args: Some(json!({})),
        max_concurrency: 4,
        status: row.status.unwrap_or(DwfStatus::Stopped),
        stop_reason: row.stop_reason,
        superseded_by: row.superseded_by.map(str::to_owned),
        failure: row.failure,
        ..RunRecord::default()
    };
    dwf::create_run(conn, &run, 1).expect("seed run row");
}

/// A stopped run, interrupted by process death: the row a previous process left (9.29's orphan, settled).
fn interrupted(id: &'static str, script: &'static str) -> Row {
    Row {
        id,
        parent: Some(PARENT),
        script: Some(script),
        status: Some(DwfStatus::Stopped),
        stop_reason: Some(DwfStop::Interrupted),
        failure: Some(json!({ "code": "Interrupted", "message": "the run was interrupted" })),
        ..Row::default()
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    service: WorkflowRunService,
    fake: Arc<FakeChildRunner>,
    store: Arc<SqliteRunStore>,
}

/// A service over a temp session database that `seed_rows` has filled. The child compiles to `compiled`.
fn fixture(compiled: Value, seed_rows: impl FnOnce(&rusqlite::Connection)) -> Fixture {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("session.db");
    let conn = open(&path);
    add_session(&conn, PARENT);
    seed_rows(&conn);
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
    service.set_store(store.clone());
    Fixture {
        _dir: dir,
        path,
        service,
        fake,
        store,
    }
}

async fn resume(service: &WorkflowRunService, run: &str) -> Value {
    service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new(run))
        .await
        .expect("the resume answers")
}

fn completed(value: Value) -> Outcome {
    Outcome::Completed(rust_cli_kernel_api::workflow_child::Completion {
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

fn refusal(answer: &Value) -> (&str, Option<&str>) {
    assert_eq!(answer["ok"], json!(false), "refused: {answer}");
    (
        answer["reason"].as_str().expect("a reason"),
        answer["message"].as_str(),
    )
}

// ---- The happy path, over the real journal and the production owner.

#[tokio::test]
async fn a_stopped_interrupted_run_resumes_on_its_row_and_settles() {
    let fx = fixture(compiled_facts(), |conn| {
        seed(conn, interrupted("dwfrun-r1", "return 1\n"));
    });

    let answer = resume(&fx.service, "dwfrun-r1").await;
    assert_eq!(answer, json!({ "ok": true, "runId": "dwfrun-r1" }));

    let launches = fx.fake.launches();
    assert_eq!(launches.len(), 1, "the child started once");
    let input = &launches[0].input;
    assert_eq!(
        input.script_text, "return 1\n",
        "the child compiles the row's script"
    );
    assert_eq!(input.run_id, "dwfrun-r1");
    assert_eq!(input.args, Some(Map::new()), "the row's args");
    assert_eq!(
        input.resumed_from, None,
        "Node's resumed launch passes no resumedFrom"
    );
    assert_eq!(input.cwd, PathBuf::from("project"));

    fx.fake.finish(0, completed(json!("done")));
    wait_until("the resumed run to settle", || fx.service.run_count() == 0).await;
    let conn = open(&fx.path);
    let row = dwf::get_run(&conn, "dwfrun-r1")
        .expect("the row read")
        .expect("the row exists");
    assert_eq!(
        row.status,
        DwfStatus::Completed,
        "the engine settled the resumed run"
    );
    let launched = dwf::list_events(&conn, "dwfrun-r1")
        .expect("the events")
        .iter()
        .filter(|event| event.event["type"] == json!("run-launched"))
        .count();
    assert_eq!(
        launched, 0,
        "the resume took the engine's resume branch: no run is created"
    );
}

/// A reply the fixed helper sent for a script with a phase and one ask (9.37, 333), recorded as the helper answers it.
const RECORDED_REPLY: &str = include_str!("../fixtures/compile-reply-ask.json");

#[test]
fn a_recorded_compile_reply_decodes_into_the_resume_tables() {
    let reply: Value = serde_json::from_str(RECORDED_REPLY).expect("the recorded reply is JSON");
    assert_eq!(reply["ok"], json!(true));
    let (asks, phases) = crate::workflow_run::resume::compiled_tables(&reply["compiled"])
        .expect("the tables decode");
    let ask = asks.get("ask#1").expect("the ask site of the script");
    assert!(!ask.typed);
    assert!(ask.schema.is_none());
    assert_eq!(phases.get("ask#1").map(String::as_str), Some("Work"));
    assert_eq!(phases.get("actor#1").map(String::as_str), Some("Work"));
}

#[tokio::test]
async fn a_run_resumes_on_the_tables_of_a_recorded_compile_reply() {
    let reply: Value = serde_json::from_str(RECORDED_REPLY).expect("the recorded reply is JSON");
    let fx = fixture(reply["compiled"].clone(), |conn| {
        seed(conn, interrupted("dwfrun-recorded", "return 1\n"));
    });
    let answer = resume(&fx.service, "dwfrun-recorded").await;
    assert_eq!(answer, json!({ "ok": true, "runId": "dwfrun-recorded" }));
    fx.fake.finish(0, completed(json!("done")));
}

// ---- Review (ocr on #595): the messages, the throw path, and the quota resumer's bounded wait.

#[tokio::test]
async fn a_compile_missing_only_its_phase_table_names_that_table() {
    let fx = fixture(
        json!({ "askSpecs": { "plain": { "typed": false } } }),
        |conn| {
            seed(conn, interrupted("dwfrun-no-phases", "return 1\n"));
        },
    );
    let error = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new("dwfrun-no-phases"))
        .await
        .expect_err("a resume without the phase table is a wiring failure");
    assert!(error.message.contains("sitePhases"), "{}", error.message);
    assert!(!error.message.contains("askSpecs"), "{}", error.message);
    assert!(fx.fake.stop_requested(0));
}

#[tokio::test]
async fn a_script_that_throws_while_compiling_fails_the_resume_with_its_message() {
    let fx = fixture(compiled_facts(), |conn| {
        seed(conn, interrupted("dwfrun-throws", "return 1\n"));
    });
    fx.fake.refuse_next(LaunchError::Rejected {
        diagnostics: vec![],
        message: Some("the compile threw: boom".to_owned()),
    });
    let error = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new("dwfrun-throws"))
        .await
        .expect_err("a compile that throws is a failure, as Node throws");
    assert!(error.message.contains("boom"), "{}", error.message);
}

#[test]
fn a_quota_resume_that_does_not_answer_in_time_is_an_error_not_a_wait() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let handle = runtime.handle().clone();
    let fx = fixture(compiled_facts(), |conn| {
        seed(conn, interrupted("dwfrun-slow", "return 1\n"));
    });
    let resumer = fx.service.quota_resumer_with_timeout(
        handle,
        Arc::new(|_: &str| true),
        Duration::from_millis(100),
    );
    // The runtime's only thread is busy, so the resume cannot start inside the timeout.
    let busy = std::thread::spawn(move || {
        runtime.block_on(async {
            std::thread::sleep(Duration::from_millis(1500));
        });
    });
    let started = Instant::now();
    let answer = resumer.resume("dwfrun-slow");
    assert!(answer.is_err(), "the wait is bounded: {answer:?}");
    assert!(
        started.elapsed() < Duration::from_millis(1000),
        "waited {:?}",
        started.elapsed()
    );
    busy.join().expect("the busy thread");
}

#[test]
fn a_quota_resume_on_a_shut_down_runtime_answers_an_error() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let handle = runtime.handle().clone();
    drop(runtime);
    let fx = fixture(compiled_facts(), |conn| {
        seed(conn, interrupted("dwfrun-gone", "return 1\n"));
    });
    let resumer = fx.service.quota_resumer(handle, Arc::new(|_: &str| true));
    let answer = resumer.resume("dwfrun-gone");
    assert!(
        answer.is_err(),
        "a resume with no runtime is a failure: {answer:?}"
    );
    assert!(fx.fake.launches().is_empty());
}

// ---- Refusals, in Node's order.

#[tokio::test]
async fn an_unknown_run_is_not_found_and_starts_nothing() {
    let fx = fixture(compiled_facts(), |_| {});
    let answer = resume(&fx.service, "dwfrun-missing").await;
    assert_eq!(refusal(&answer), ("not_found", None));
    assert!(fx.fake.launches().is_empty());
}

#[tokio::test]
async fn a_run_in_flight_is_already_running_and_its_child_is_not_started_twice() {
    let fx = fixture(compiled_facts(), |_| {});
    let mut config = EngineConfig {
        run_id: "dwfrun-live".to_owned(),
        parent_session_id: Some(PARENT.to_owned()),
        cwd: Some("project".to_owned()),
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
    fx.service
        .launch(
            LaunchInput {
                script_text: "return 1\n".to_owned(),
                run_id: "dwfrun-live".to_owned(),
                args: Some(Map::new()),
                resumed_from: None,
                cwd: PathBuf::from("project"),
            },
            config,
        )
        .await
        .expect("launched");

    let answer = resume(&fx.service, "dwfrun-live").await;
    assert_eq!(refusal(&answer), ("already_running", None));
    assert_eq!(fx.fake.launches().len(), 1, "only the live run's child");
    fx.fake.finish(0, completed(json!("done")));
}

#[tokio::test]
async fn two_concurrent_resumes_start_one_child() {
    let fx = fixture(compiled_facts(), |conn| {
        seed(conn, interrupted("dwfrun-race", "return 1\n"));
    });
    let port = fx.service.for_session(&SessionId::new(PARENT));
    let (a, b) = (
        WorkflowRunId::new("dwfrun-race"),
        WorkflowRunId::new("dwfrun-race"),
    );
    let first = port.resume(&a);
    let second = port.resume(&b);
    let (first, second) = tokio::join!(first, second);
    let answers = [first.expect("first"), second.expect("second")];
    let resumed = answers.iter().filter(|a| a["ok"] == json!(true)).count();
    assert_eq!(resumed, 1, "exactly one resume starts: {answers:?}");
    assert_eq!(fx.fake.launches().len(), 1, "one child for the run");
    fx.fake.finish(0, completed(json!("done")));
}

#[tokio::test]
async fn a_superseded_run_is_refused_before_anything_starts() {
    let fx = fixture(compiled_facts(), |conn| {
        seed(
            conn,
            Row {
                stop_reason: Some(DwfStop::Superseded),
                superseded_by: Some("dwfrun-next"),
                ..interrupted("dwfrun-old", "return 1\n")
            },
        );
    });
    let answer = resume(&fx.service, "dwfrun-old").await;
    assert_eq!(refusal(&answer), ("superseded", None));
    assert!(fx.fake.launches().is_empty());
}

#[tokio::test]
async fn a_run_that_is_not_stopped_is_not_resumable() {
    let fx = fixture(compiled_facts(), |conn| {
        seed(
            conn,
            Row {
                status: Some(DwfStatus::Completed),
                stop_reason: None,
                failure: None,
                ..interrupted("dwfrun-done", "return 1\n")
            },
        );
    });
    let answer = resume(&fx.service, "dwfrun-done").await;
    assert_eq!(refusal(&answer), ("not_resumable", None));
    assert!(fx.fake.launches().is_empty());
}

#[tokio::test]
async fn a_row_without_its_script_is_script_missing() {
    let fx = fixture(compiled_facts(), |conn| {
        seed(
            conn,
            Row {
                script: None,
                ..interrupted("dwfrun-old-format", "unused")
            },
        );
    });
    let answer = resume(&fx.service, "dwfrun-old-format").await;
    assert_eq!(refusal(&answer), ("script_missing", None));
    assert!(fx.fake.launches().is_empty());
}

#[tokio::test]
async fn a_script_that_no_longer_compiles_is_refused_with_its_diagnostics() {
    let fx = fixture(compiled_facts(), |conn| {
        seed(conn, interrupted("dwfrun-stale", "return 1\n"));
    });
    fx.fake.refuse_next(LaunchError::Rejected {
        diagnostics: vec![WorkflowDiagnostic {
            code: 2304,
            line: 2,
            column: 3,
            message: "Cannot find name 'agnt'.".to_owned(),
        }],
        message: None,
    });
    let answer = resume(&fx.service, "dwfrun-stale").await;
    let (reason, message) = refusal(&answer);
    assert_eq!(reason, "compile_failed");
    assert_eq!(
        message,
        Some(
            "The stored script of run dwfrun-stale no longer compiles against the current workflow facade:\nL2:C3 Cannot find name 'agnt'."
        )
    );
}

#[tokio::test]
async fn a_script_whose_hash_differs_from_the_row_is_refused_and_its_child_stopped() {
    let fx = fixture(compiled_facts(), |conn| {
        seed(
            conn,
            Row {
                script_hash: Some("hash-recorded-at-launch"),
                ..interrupted("dwfrun-edited", "return 1\n")
            },
        );
    });
    let answer = resume(&fx.service, "dwfrun-edited").await;
    assert_eq!(refusal(&answer), ("script_mismatch", None));
    assert!(
        fx.fake.stop_requested(0),
        "the child compiled for the refused resume is stopped"
    );
    assert_eq!(fx.service.run_count(), 0, "nothing is kept");
}

#[tokio::test]
async fn a_compile_without_its_ask_table_refuses_the_resume_and_stops_the_child() {
    let fx = fixture(json!({ "askSpecs": {}, "sitePhases": {} }), |conn| {
        seed(conn, interrupted("dwfrun-no-table", "return 1\n"));
    });
    let error = fx
        .service
        .for_session(&SessionId::new(PARENT))
        .resume(&WorkflowRunId::new("dwfrun-no-table"))
        .await
        .expect_err("a resume without the ask table is a wiring failure");
    assert!(error.message.contains("no ask table"), "{}", error.message);
    assert!(fx.fake.stop_requested(0));
    assert_eq!(fx.service.run_count(), 0);
}

// ---- The quota resumer: a due quota stop is resumed through the service, or refused while the parent is closed.

fn quota_stop(id: &'static str, reset_at: u64) -> Row {
    Row {
        failure: Some(json!({
            "code": "ProviderStop",
            "providerStop": { "kind": "quota", "reason": "rate_limited", "resetAt": reset_at },
        })),
        stop_reason: Some(DwfStop::Provider),
        ..interrupted(id, "return 1\n")
    }
}

fn now_ms() -> u64 {
    rust_cli_base::clock::SystemClock::utc().now_ms()
}

#[tokio::test]
async fn a_due_quota_stop_is_resumed_by_the_timer_through_the_store() {
    let reset = now_ms() - 60 * 60_000;
    let fx = fixture(compiled_facts(), |conn| {
        seed(conn, quota_stop("dwfrun-quota", reset));
    });
    fx.service.configure_quota(
        Arc::new(StoreQuotaReads::new(fx.store.clone())),
        fx.service
            .quota_resumer(tokio::runtime::Handle::current(), Arc::new(|_: &str| true)),
        Arc::new(rust_cli_workflow::model_failure::ThreadClock),
    );
    // The scan runs on a blocking thread, as the session-open hook does; the timer's resume then runs on the runtime.
    let service = fx.service.clone();
    tokio::task::spawn_blocking(move || service.open_session(PARENT))
        .await
        .expect("the scan");

    wait_until("the quota timer to resume the run", || {
        !fx.fake.launches().is_empty()
    })
    .await;
    assert_eq!(fx.fake.launches()[0].input.run_id, "dwfrun-quota");
    fx.fake.finish(0, completed(json!("done")));
}

#[tokio::test]
async fn a_closed_parent_refuses_the_quota_resume_and_starts_no_child() {
    let reset = now_ms() - 60 * 60_000;
    let fx = fixture(compiled_facts(), |conn| {
        seed(conn, quota_stop("dwfrun-closed", reset));
    });
    let resumer = fx
        .service
        .quota_resumer(tokio::runtime::Handle::current(), Arc::new(|_: &str| false));
    let answer = tokio::task::spawn_blocking(move || resumer.resume("dwfrun-closed"))
        .await
        .expect("the resume")
        .expect("the answer");
    assert_eq!(
        answer,
        ResumeAnswer::Refused(rust_cli_workflow::quota_resume::Refusal::Other(
            crate::workflow_quota::RESUME_NOT_WIRED.to_owned()
        ))
    );
    assert!(
        fx.fake.launches().is_empty(),
        "the closed predicate starts no child"
    );
}

#[tokio::test]
async fn a_quota_resume_of_a_run_in_flight_is_transient() {
    let fx = fixture(compiled_facts(), |conn| {
        seed(conn, interrupted("dwfrun-busy", "return 1\n"));
    });
    let resumer = fx
        .service
        .quota_resumer(tokio::runtime::Handle::current(), Arc::new(|_: &str| true));
    let first = {
        let resumer = resumer.clone();
        tokio::task::spawn_blocking(move || resumer.resume("dwfrun-busy"))
    };
    let first = first.await.expect("join").expect("answer");
    assert_eq!(first, ResumeAnswer::Resumed);
    let second = tokio::task::spawn_blocking(move || resumer.resume("dwfrun-busy"))
        .await
        .expect("join")
        .expect("answer");
    assert_eq!(
        second,
        ResumeAnswer::Refused(rust_cli_workflow::quota_resume::Refusal::AlreadyRunning)
    );
    fx.fake.finish(0, completed(json!("done")));
}
