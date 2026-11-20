//! Fork: EvalWorkflowSnippet's ports (Node `DynamicWorkflowSnippetPort` in `bootstrap/src/app/dynamic-workflow-snippet-service.ts`;
//! specs/fork-rust-workflow-engine.md, W7-8c, section 9.28).
//!
//! Two ports. [`WorkflowSnippetPort`] is what the tool reaches: it checks a snippet (the permission decision) and runs one
//! (the call). The runtime implements it on the Rust engine with an in-memory journal. [`WorkflowSnippetRunner`] is the
//! compile and launch step under it: the helper compiles the snippet under the snippet facade, the child's entry file is
//! written, and the child is started. `protocol-zcode` implements it over the helper link and the NDJSON host.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::future::BoxFuture;
use serde_json::Value;

use crate::workflow_analysis::WorkflowDiagnostic;
use crate::workflow_child::{ChildHandler, ChildStop, Outcome};

/// The snippet could not be checked or run (the helper is not running, or its reply does not match its contract). Nothing
/// is decided on a failed check, and the tool reports the message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct WorkflowSnippetError {
    pub message: String,
}

/// The compile of a snippet, as the permission decision reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnippetCheck {
    /// The snippet does not compile under the snippet facade, or a world.run command is not a literal.
    Diagnostics(Vec<WorkflowDiagnostic>),
    /// The snippet compiles. `world_run` is true when it carries a world.run command, which is what asks the user.
    Ready { world_run: bool },
}

/// One snippet to run: its source, the run id the child's identity carries, and the working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnippetLaunch {
    pub code: String,
    pub run_id: String,
    pub cwd: PathBuf,
}

/// A started snippet child: the entry file it runs from, a way to stop it, and its outcome.
pub struct RunningSnippet {
    pub entry_path: PathBuf,
    pub stop: ChildStop,
    /// Resolves once, with the child's outcome. Dropping it before it settles ends the child's process tree.
    pub outcome: BoxFuture<'static, Outcome>,
}

/// The answer of a start: the snippet did not compile (nothing was written or started), or the child is running.
pub enum SnippetStart {
    Rejected(Vec<WorkflowDiagnostic>),
    Started(RunningSnippet),
}

/// Compiles and starts snippets. Implemented over the helper and the NDJSON host by `protocol-zcode`.
#[async_trait]
pub trait WorkflowSnippetRunner: Send + Sync {
    /// Compiles `code` under the snippet facade. Writes nothing and starts nothing.
    async fn check(&self, code: &str) -> Result<SnippetCheck, WorkflowSnippetError>;

    /// Compiles `launch.code`, writes the entry file for `launch.run_id` under `launch.cwd`, and starts the child with
    /// `handler`. A snippet with diagnostics starts nothing.
    ///
    /// Dropping the returned future before it resolves stops any child it has already spawned: an implementation holds
    /// the child's guard from the moment of the spawn, so a drop at any await after it ends the child's process tree.
    /// The service relies on this when a snippet's deadline passes during the start.
    async fn start(
        &self,
        launch: SnippetLaunch,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<SnippetStart, WorkflowSnippetError>;
}

/// One run of a snippet, as the tool asks for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnippetRequest {
    pub code: String,
    pub cwd: PathBuf,
    /// The wall clock of the whole snippet, in milliseconds (the tool validates it: 1000 to 600000).
    pub timeout_ms: u64,
}

/// How a snippet run settled. The model text is built by the tool from these fields.
#[derive(Debug, Clone, PartialEq)]
pub enum SnippetOutcome {
    /// The snippet did not compile; nothing ran.
    Diagnostics(Vec<WorkflowDiagnostic>),
    /// The snippet returned. `value` is `None` when it returned nothing (JavaScript `undefined`).
    Completed {
        value: Option<Value>,
        logs: Vec<String>,
        logs_truncated: bool,
    },
    /// The snippet failed: a script error, a host failure, a timeout, a cancel or an oversize return value. `code` is the
    /// workflow error code (Node's `failed (<code>)` text).
    Failed {
        code: String,
        message: String,
        logs: Vec<String>,
        logs_truncated: bool,
    },
}

/// Runs snippets for the tools. The runtime implements it over [`WorkflowSnippetRunner`] and the Rust engine.
#[async_trait]
pub trait WorkflowSnippetPort: Send + Sync {
    /// The compile check of `code`, for the permission decision.
    async fn check(&self, code: &str) -> Result<SnippetCheck, WorkflowSnippetError>;

    /// Compiles and runs `request` to its settlement on an in-memory journal. A confirmed `world.run` command runs in
    /// `request.cwd`, the workspace, as a run's would; nothing is written to the run tables.
    async fn eval(&self, request: SnippetRequest) -> Result<SnippetOutcome, WorkflowSnippetError>;
}
