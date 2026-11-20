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
        Arc::new(RecordingPort::default()),
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
#[test]
#[expect(
    clippy::disallowed_methods,
    reason = "the test checks that no database file was created, which is a file-system fact"
)]
fn without_a_child_runner_no_run_service_is_built() {
    let dir = tempfile::tempdir().expect("temp dir");
    let database = dir.path().join("sessions.db");
    let service = build(
        None,
        Arc::new(SessionResidency::new()),
        &database,
        "/work",
        Arc::new(RecordingPort::default()),
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
        Arc::new(RecordingPort::default()),
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

/// W7-5e (9.34): a run launched through the composed service records its progress to its parent session, through the
/// port the composition was given. Node's sink appends each run event to the parent; the first is `run-started`.
#[tokio::test]
async fn a_run_launched_in_the_composed_service_records_its_progress_to_its_parent() {
    let dir = tempfile::tempdir().expect("temp dir");
    let database = dir.path().join("sessions.db");
    {
        let (conn, _) =
            open_session_database(&database, MIGRATION_LOCK_WAIT, 1).expect("session database");
        add_session(&conn, "ses_parent");
    }
    let runner = Arc::new(FakeChildRunner::new());
    let port = Arc::new(RecordingPort::default());
    let service = build(
        Some(runner.clone()),
        Arc::new(SessionResidency::new()),
        &database,
        "/work",
        port.clone(),
    )
    .expect("the service is built over the runner");

    let mut config = EngineConfig {
        run_id: "dwfrun-progress".to_owned(),
        parent_session_id: Some("ses_parent".to_owned()),
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
        assert!(calls.iter().all(|(parent, _)| parent == "ses_parent"));
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
