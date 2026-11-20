//! Fork: the composition of the workflow run service (specs/fork-rust-workflow-engine.md, 9.30, W7-5a-4). The composition
//! root builds the service over the process's real ports: the child runner the node helper composed, the process
//! governor, the kernel's residency ledger, and the production owner factory. Nothing calls `launch` yet (the gate is
//! off), so building the service opens no database and starts no child.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::Result;
use rust_cli_base::clock::SystemClock;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::dynamic_workflow::DynamicWorkflowGates;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::workflow_child::WorkflowChildRunner;
use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use rust_cli_node_store::{MIGRATION_LOCK_WAIT, open_session_database};
use rust_cli_runtime::actor_turns::ActorAgents;
use rust_cli_runtime::workflow_assembly::ActorSessionRelease;
use rust_cli_runtime::workflow_owner::{ActorBindingsPort, OwnerStores, bound_owner_factory};
use rust_cli_runtime::workflow_quota::StoreQuotaReads;
use rust_cli_runtime::workflow_run::WorkflowRunService;
use rust_cli_workflow::model::RunRow;
use rust_cli_workflow::model_failure::ThreadClock;
use rust_cli_workflow::residency::SessionResidency;
use rust_cli_workflow::run_store::{RunListQuery, RunListRow, RunStore, SqliteRunStore};

use super::workflow_governor::GovernorRunConcurrency;

/// Builds the run service over the process's ports, or none when there is no child runner (no helper configured).
/// `database` is the session database the app opened; `directory` is the workspace the runs write their rows under;
/// `progress` is where each run's progress goes (the parent session's entry and the Host's stream, 9.34). `agents`,
/// `bindings` and `handle` are the actor side (9.35): each actor's turn runs on the agents under its parent's bindings,
/// and `handle` is the runtime the bindings are awaited on (the caller passes its own).
#[expect(
    clippy::too_many_arguments,
    reason = "the composition root's build takes each port it wires (9.34, 9.35); a struct would only rename them"
)]
pub(crate) fn build<A: ActorAgents + ActorSessionRelease>(
    runner: Option<Arc<dyn WorkflowChildRunner>>,
    residency: Arc<SessionResidency>,
    database: &Path,
    directory: &str,
    agents: Arc<A>,
    bindings: Arc<dyn ActorBindingsPort>,
    handle: tokio::runtime::Handle,
    progress: Arc<dyn WorkflowRunProgressPort>,
    gates: Arc<dyn DynamicWorkflowGates>,
) -> Option<WorkflowRunService> {
    let runner = runner?;
    let resume_handle = handle.clone();
    let stores = OwnerStores {
        database: database.to_path_buf(),
        directory: directory.to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        clock: now_ms,
    };
    // Each actor's turn runs on the agents under its parent's bindings (9.35, `bound_owner_factory`, 9.33).
    let factory = bound_owner_factory(
        stores,
        agents,
        handle,
        bindings,
        Arc::new(SystemClock::utc()),
    );
    let concurrency = Arc::new(GovernorRunConcurrency::new(
        rust_cli_model::governor::process(),
    ));
    let service = WorkflowRunService::new(residency, concurrency, runner, factory);
    // W7-5e (9.34): the run progress port, with the real default concurrency (Node's `resolveWorkflowDefaultConcurrency`).
    // Nothing is recorded until a run launches, so the gate stays off for the user.
    let parallelism = std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get);
    service.configure_progress(
        progress,
        f64::from(rust_cli_model::governor::default_concurrency(parallelism)),
    );
    // The journal's run rows (reconcile, the run list and the quota scan) read through one store, opened on first use so
    // building the service still opens nothing (9.30).
    let store: Arc<dyn RunStore> = Arc::new(LazyRunStore::new(database.to_path_buf()));
    service.set_store(store.clone());
    service.set_clock(Arc::new(SystemClock::utc()));
    // Quota auto-resume resumes through this service (9.37), for a parent whose recorded gate is open (9.36). A parent with
    // the gate closed, or with no record, has its due quota runs refused, so nothing spends turns the user turned off.
    let allowed = Arc::new(move |parent: &str| {
        gates
            .gate(&SessionId::new(parent))
            .is_some_and(|gate| gate.enabled)
    });
    let quota_resumer = service.quota_resumer(resume_handle, allowed);
    service.configure_quota(
        Arc::new(StoreQuotaReads::new(store)),
        quota_resumer,
        Arc::new(ThreadClock),
    );
    Some(service)
}

/// The journal's `RunStore` over the session database, opened by its first call (W7-5c). The open runs the migration
/// check, so it runs on a blocking thread: every caller is one (the reconcile and the quota scan, 9.31; the run list).
struct LazyRunStore {
    database: PathBuf,
    store: Mutex<Option<Arc<SqliteRunStore>>>,
}

impl LazyRunStore {
    fn new(database: PathBuf) -> Self {
        Self {
            database,
            store: Mutex::new(None),
        }
    }

    /// The store, opened now if no call has opened it. A failed open is returned to the caller and retried next time.
    fn get(&self) -> Result<Arc<SqliteRunStore>> {
        let mut slot = self.store.lock_unpoisoned();
        if let Some(store) = slot.as_ref() {
            return Ok(store.clone());
        }
        let (conn, _) = open_session_database(&self.database, MIGRATION_LOCK_WAIT, now_ms_u64())
            .map_err(|error| anyhow::anyhow!("the session database did not open: {error}"))?;
        let store = Arc::new(SqliteRunStore::new(conn, now_ms));
        *slot = Some(store.clone());
        Ok(store)
    }
}

impl RunStore for LazyRunStore {
    fn non_terminal_runs(&self, parent_session_id: &str) -> Result<Vec<RunRow>> {
        self.get()?.non_terminal_runs(parent_session_id)
    }

    fn interrupt_run(&self, run_id: &str) -> Result<bool> {
        self.get()?.interrupt_run(run_id)
    }

    fn runs_of_session(&self, parent_session_id: &str, limit: usize) -> Result<Vec<RunListRow>> {
        self.get()?.runs_of_session(parent_session_id, limit)
    }

    fn list_runs(&self, query: &RunListQuery) -> Result<Vec<RunListRow>> {
        self.get()?.list_runs(query)
    }

    fn get_run(&self, run_id: &str) -> Result<Option<RunRow>> {
        self.get()?.get_run(run_id)
    }
}

/// The row timestamp, in milliseconds, from the process's one business clock.
fn now_ms() -> i64 {
    i64::try_from(SystemClock::utc().now_ms()).unwrap_or(i64::MAX)
}

/// The same reading as `now_ms`, for the database open's ledger stamp.
fn now_ms_u64() -> u64 {
    SystemClock::utc().now_ms()
}

#[cfg(test)]
#[path = "workflow_service_tests.rs"]
mod tests;
