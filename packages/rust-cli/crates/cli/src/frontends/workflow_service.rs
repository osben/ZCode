//! Fork: the composition of the workflow run service (specs/fork-rust-workflow-engine.md, 9.30, W7-5a-4). The composition
//! root builds the service over the process's real ports: the child runner the node helper composed, the process
//! governor, the kernel's residency ledger, and the production owner factory. Nothing calls `launch` yet (the gate is
//! off), so building the service opens no database and starts no child.

use std::path::Path;
use std::sync::Arc;

use rust_cli_base::clock::SystemClock;
use rust_cli_kernel_api::workflow_child::WorkflowChildRunner;
use rust_cli_runtime::workflow_owner::{
    OwnerStores, UnwiredRelease, UnwiredTurns, production_owner_factory,
};
use rust_cli_runtime::workflow_run::WorkflowRunService;
use rust_cli_workflow::residency::SessionResidency;

use super::workflow_governor::GovernorRunConcurrency;

/// Builds the run service over the process's ports, or none when there is no child runner (no helper configured).
/// `database` is the session database the app opened; `directory` is the workspace the runs write their rows under.
pub(crate) fn build(
    runner: Option<Arc<dyn WorkflowChildRunner>>,
    residency: Arc<SessionResidency>,
    database: &Path,
    directory: &str,
) -> Option<WorkflowRunService> {
    let runner = runner?;
    let stores = OwnerStores {
        database: database.to_path_buf(),
        directory: directory.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        clock: now_ms,
    };
    // The turn side and the release are refused until the agents' bindings exist (9.30); see `workflow_owner`.
    let factory =
        production_owner_factory(stores, Arc::new(UnwiredTurns), Arc::new(UnwiredRelease));
    let concurrency = Arc::new(GovernorRunConcurrency::new(
        rust_cli_model::governor::process(),
    ));
    Some(WorkflowRunService::new(
        residency,
        concurrency,
        runner,
        factory,
    ))
}

/// The row timestamp, in milliseconds, from the process's one business clock.
fn now_ms() -> i64 {
    i64::try_from(SystemClock::utc().now_ms()).unwrap_or(i64::MAX)
}

#[cfg(test)]
#[path = "workflow_service_tests.rs"]
mod tests;
