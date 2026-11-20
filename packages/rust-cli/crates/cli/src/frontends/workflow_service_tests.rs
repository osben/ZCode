//! Tests of the run service's composition (9.30). The gate is off: with no child runner there is no service, and with one
//! the service holds no run and opens nothing until a run is launched.

use std::sync::Arc;

use rust_cli_kernel_api::testing::FakeChildRunner;
use rust_cli_kernel_api::workflow_run::WorkflowRunHost;
use rust_cli_workflow::residency::SessionResidency;

use super::build;

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
