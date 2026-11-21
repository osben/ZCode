//! Fork: the snippet runner of EvalWorkflowSnippet (specs/fork-rust-workflow-engine.md, 9.28, W7-8c).
//!
//! `kernel-api` defines the port ([`WorkflowSnippetRunner`]), so the runtime's snippet service can run a snippet without
//! depending on this crate. This module implements it over the pieces the protocol crate owns: the helper's snippet compile
//! (`workflow_compile::eval_snippet`), the entry writer and the child launcher (`workflow_runner::launch_compiled`). A snippet
//! has no run row: its entry file carries the run id the caller gives, and nothing is journalled here. A snippet starts only
//! through the gate, when the helper exists (9.54).

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::Spawner;
use rust_cli_kernel_api::workflow_child::{ChildHandler, LaunchError, LaunchInput};
use rust_cli_kernel_api::workflow_snippet::{
    RunningSnippet, SnippetCheck, SnippetLaunch, SnippetStart, WorkflowSnippetError,
    WorkflowSnippetRunner,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::Value;

use super::node_helper::NodeHelper;
use super::workflow_child::ChildLauncher;
use super::workflow_compile::{Compiled, SnippetCompiled, eval_snippet};
use super::workflow_runner::launch_compiled;

/// The run id a check sends. A check writes no entry, so the id only satisfies the helper's schema.
const CHECK_RUN_ID: &str = "dwfcheck";

/// Compiles and starts snippets over the Node helper, the entry writer and the child launcher.
pub struct ProtocolSnippetRunner {
    helper: Arc<NodeHelper>,
    launcher: Arc<dyn ChildLauncher>,
    spawner: Spawner,
    fallback_dir: PathBuf,
}

impl ProtocolSnippetRunner {
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

/// The check's answer from the helper's reply.
pub(crate) fn check_of(
    compiled: Result<SnippetCompiled, RpcError>,
) -> Result<SnippetCheck, WorkflowSnippetError> {
    match compiled.map_err(compile_failure)? {
        SnippetCompiled::Ready { world_run, .. } => Ok(SnippetCheck::Ready { world_run }),
        SnippetCompiled::Rejected { diagnostics } => Ok(SnippetCheck::Diagnostics(diagnostics)),
    }
}

fn compile_failure(error: RpcError) -> WorkflowSnippetError {
    WorkflowSnippetError {
        message: format!("the compile helper failed: {}", error.message),
    }
}

fn launch_failure(error: LaunchError) -> WorkflowSnippetError {
    WorkflowSnippetError {
        message: error.to_string(),
    }
}

#[async_trait]
impl WorkflowSnippetRunner for ProtocolSnippetRunner {
    async fn check(&self, code: &str) -> Result<SnippetCheck, WorkflowSnippetError> {
        check_of(eval_snippet(&self.helper, code, CHECK_RUN_ID).await)
    }

    async fn start(
        &self,
        launch: SnippetLaunch,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<SnippetStart, WorkflowSnippetError> {
        let compiled = eval_snippet(&self.helper, &launch.code, &launch.run_id)
            .await
            .map_err(compile_failure)?;
        let entry_source = match compiled {
            SnippetCompiled::Rejected { diagnostics } => {
                return Ok(SnippetStart::Rejected(diagnostics));
            }
            SnippetCompiled::Ready { entry_source, .. } => entry_source,
        };
        // A snippet has no script hash and no compiled facts: the launch reads neither, so they are empty.
        let compiled = Compiled::Ready {
            script_hash: String::new(),
            compiled: Value::Null,
            entry_source,
        };
        let input = LaunchInput {
            script_text: launch.code,
            run_id: launch.run_id,
            args: None,
            resumed_from: None,
            cwd: launch.cwd,
        };
        let running = launch_compiled(
            compiled,
            &input,
            handler,
            self.launcher.as_ref(),
            &self.spawner,
            &self.fallback_dir,
        )
        .await
        .map_err(launch_failure)?;
        Ok(SnippetStart::Started(RunningSnippet {
            entry_path: running.entry_path,
            stop: running.stop,
            outcome: running.outcome,
        }))
    }
}

#[cfg(test)]
#[path = "workflow_snippet_tests.rs"]
mod tests;
