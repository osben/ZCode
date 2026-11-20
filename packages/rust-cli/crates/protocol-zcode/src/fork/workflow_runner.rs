//! Fork: the protocol side of the workflow child runner port (specs/fork-rust-workflow-engine.md, 9.22, W7-5a-1).
//!
//! `kernel-api` defines the port, so the runtime can start a run without depending on this crate. This module implements
//! it over the pieces the protocol crate already owns: the compile client (`workflow_compile`), the entry writer
//! (`workflow_entry`), the injected child launcher and the NDJSON host (`workflow_host::run`). Nothing starts a run yet;
//! the gate is off and the composition root only installs the runner.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::future::BoxFuture;
use rust_cli_base::{Spawner, Task};
use rust_cli_kernel_api::workflow_child::{
    ChildStop, LaunchError, LaunchInput, RunningChild, WorkflowChildRunner,
};
use tokio_util::sync::CancellationToken;

use super::node_helper::NodeHelper;
use super::workflow_child::{ChildLauncher, LaunchedChild};
use super::workflow_compile::{self, CompileRequest, Compiled};
use super::workflow_entry::{EntryLocation, write_entry};
use super::workflow_host::{ChildHandler, ChildIo, Outcome, StopReason, run};

/// The task that reads one child's lines. Its name is what a panic report names.
const HOST_TASK: &str = "workflow-child-host";

/// Starts runs over the Node helper's compile, the entry writer and the child launcher.
pub struct ProtocolChildRunner {
    helper: Arc<NodeHelper>,
    launcher: Arc<dyn ChildLauncher>,
    spawner: Spawner,
    fallback_dir: PathBuf,
}

impl ProtocolChildRunner {
    /// `fallback_dir` receives the entry file when the project's `.zcode/workflow-runs` is not writable.
    pub fn new(
        helper: Arc<NodeHelper>,
        launcher: Arc<dyn ChildLauncher>,
        spawner: Spawner,
        fallback_dir: PathBuf,
    ) -> Self {
        Self {
            helper,
            launcher,
            spawner,
            fallback_dir,
        }
    }
}

#[async_trait]
impl WorkflowChildRunner for ProtocolChildRunner {
    async fn start(
        &self,
        input: LaunchInput,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<RunningChild, LaunchError> {
        let request = CompileRequest {
            script_text: &input.script_text,
            run_id: &input.run_id,
            args: input.args.as_ref(),
            resumed_from: input.resumed_from.as_deref(),
        };
        let compiled = workflow_compile::compile(&self.helper, request)
            .await
            .map_err(|error| {
                LaunchError::Failed(format!("the compile helper failed: {}", error.message))
            })?;
        launch_compiled(
            compiled,
            &input,
            handler,
            self.launcher.as_ref(),
            &self.spawner,
            &self.fallback_dir,
        )
        .await
    }
}

/// The launch after the compile: refuses a rejected script, writes the entry, starts the child and its host.
/// Nothing is written or started for a rejected script.
pub(crate) async fn launch_compiled(
    compiled: Compiled,
    input: &LaunchInput,
    handler: Arc<dyn ChildHandler>,
    launcher: &dyn ChildLauncher,
    spawner: &Spawner,
    fallback_dir: &Path,
) -> Result<RunningChild, LaunchError> {
    let (script_hash, compiled, entry_source) = match compiled {
        Compiled::Ready {
            script_hash,
            compiled,
            entry_source,
        } => (script_hash, compiled, entry_source),
        Compiled::Rejected {
            diagnostics,
            message,
        } => {
            return Err(LaunchError::Rejected {
                diagnostics,
                message,
            });
        }
    };
    // The fallback is logged with the error kind only, never the paths: the project directory can hold the user's name.
    let mut warn = |kind: std::io::ErrorKind| {
        tracing::warn!(
            event = "workflow.entry_fallback",
            kind = ?kind,
            "the project's workflow-runs directory is not writable; the entry file falls back to the temp directory"
        );
    };
    let entry = write_entry(
        &input.cwd,
        &input.run_id,
        &entry_source,
        fallback_dir,
        &mut warn,
    )
    .await
    .map_err(|error| {
        LaunchError::Failed(format!(
            "the entry file could not be written ({})",
            error.kind()
        ))
    })?;
    let launched = launcher
        .launch(&entry.path)
        .await
        .map_err(|error| LaunchError::Failed(error.to_string()))?;
    let stop = CancellationToken::new();
    let outcome = host_outcome(launched, handler, spawner, stop.clone());
    Ok(RunningChild {
        script_hash,
        compiled,
        entry_path: entry.path,
        entry_fallback: entry.location == EntryLocation::Fallback,
        stop: ChildStop::new(stop),
        outcome,
    })
}

/// Drives one child's host on its own task and returns the outcome. The task ends with the host, so the child's
/// guard drops then: a complete child, a stopped child and a child whose outcome was dropped all end the tree.
fn host_outcome(
    launched: LaunchedChild,
    handler: Arc<dyn ChildHandler>,
    spawner: &Spawner,
    stop: CancellationToken,
) -> BoxFuture<'static, Outcome> {
    let LaunchedChild { streams, guard } = launched;
    let task = spawner.spawn(HOST_TASK, async move {
        // Held until the host ends, however it ends: its drop is what ends the child's process tree.
        let _guard = guard;
        let io = ChildIo {
            stdout: streams.stdout,
            stdin: streams.stdin,
            stderr: streams.stderr,
        };
        tokio::select! {
            biased;
            _ = stop.cancelled() => Outcome::Stopped {
                reason: StopReason::Interrupted,
                cause: "the run was stopped".to_owned(),
            },
            outcome = run(io, handler) => outcome,
        }
    });
    // The guard is captured now, not on the first poll: an outcome dropped before it is ever polled still aborts.
    let mut task = AbortOnDrop(task);
    Box::pin(async move {
        match (&mut task.0).await {
            Ok(outcome) => outcome,
            Err(error) => Outcome::Stopped {
                reason: StopReason::Interrupted,
                cause: format!("the child's host ended without an outcome ({error})"),
            },
        }
    })
}

/// Aborts its task when dropped, so an outcome dropped before it settles ends the child's host, and with it the tree.
struct AbortOnDrop<T>(Task<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
#[path = "workflow_runner_tests.rs"]
mod tests;
