//! Tests of the run service's composition (9.30). The gate is off: with no child runner there is no service, and with one
//! the service holds no run and opens nothing until a run is launched.

use std::sync::Arc;

use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_run::WorkflowRunHost;
use rust_cli_workflow::residency::SessionResidency;

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
    let service = build(None, Arc::new(SessionResidency::new()), &database, "/work");
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
