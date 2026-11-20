//! Fork: the workflow child's contract (specs/fork-rust-workflow-engine.md, 4.1 and 9.18 decision 1).
//!
//! The NDJSON wire is the sandbox child's message shape. `ChildHandler` is the engine side of Boundary A: the transport
//! in `protocol-zcode` (`workflow_host`) reads the child's lines and calls the handler. The handler moved here from
//! `protocol-zcode` in W7-5 so the run service in `runtime` can implement it without depending on the protocol crate.
//! The wire shapes moved unchanged from `protocol-zcode`'s `workflow_wire`.
//!
//! The shapes are those of `dynamic-workflow-runtime/src/protocol.ts`, which is the source of truth: a field added there is
//! added here. Unknown fields are ignored, so a newer child with extra fields still reads; a missing required field, or a
//! `kind`/`type` this module does not know, is a malformed line.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufRead, AsyncRead, AsyncWrite};
use tokio_util::sync::CancellationToken;

/// The child's three stdio ends, as the launcher hands them over.
pub struct ChildIo<R, W, E> {
    pub stdout: R,
    pub stdin: W,
    pub stderr: E,
}

/// How a run's stream ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// The child sent `complete`.
    Completed(Completion),
    /// The stream stopped before `complete`.
    Stopped { reason: StopReason, cause: String },
}

/// The only stop reason the transport produces; the engine maps the others (`user`, `model`, ...) itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Interrupted,
}

/// The boxed stdio of a started child, so the host is not generic over the launcher.
pub type ChildStreams = ChildIo<
    Box<dyn AsyncBufRead + Send + Unpin>,
    Box<dyn AsyncWrite + Send + Unpin>,
    Box<dyn AsyncRead + Send + Unpin>,
>;

/// A started child: its stdio, and a guard whose drop ends the process tree.
pub struct LaunchedChild {
    pub streams: ChildStreams,
    pub guard: Box<dyn Send>,
}

/// Starts sandbox children for an entry file (the W7-5 port the run service reaches through `kernel-api`). The
/// implementation owns the child's process tree. The protocol side builds the invocation.
#[async_trait]
pub trait ChildLauncher: Send + Sync {
    async fn launch(&self, entry: &Path) -> io::Result<LaunchedChild>;
}

/// The engine side of Boundary A. Methods are synchronous except the request's future, which runs while the host
/// keeps reading lines, so asks in flight do not hold up the child's next message.
pub trait ChildHandler: Send + Sync {
    /// Creates the actor in the engine and returns its engine id. An `Err` refuses the actor and carries the reason,
    /// which ends the run.
    fn create_actor(&self, actor: &CreateActor) -> Result<String, String>;

    /// Starts one request. `actor_id` is the engine id of the request's actor, resolved by the host.
    fn request(
        &self,
        request: ChildRequest,
        actor_id: Option<String>,
    ) -> BoxFuture<'static, Result<Value, WireError>>;

    /// Handles one event, in the order the child wrote it.
    fn event(&self, event: ChildEvent);
}

/// A child → host message. The tag is `kind`, as in `ChildMessage`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ChildMessage {
    CreateActor(CreateActor),
    Request(ChildRequest),
    Event(ChildEvent),
    Complete(Completion),
}

/// `create-actor`: no answer. `local_id` is the child's handle, mapped to the engine's id before any later request.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateActor {
    pub local_id: String,
    pub site_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub persona: Option<Value>,
}

/// The kinds of `request`: an ask, a world read, a content artifact publish, or a hole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RequestType {
    Ask,
    WorldRead,
    PublishArtifact,
    Hole,
}

/// `request`: answered by a `response` with the same `id`. `actor` is the child's handle; the host resolves it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildRequest {
    pub id: String,
    #[serde(rename = "type")]
    pub request_type: RequestType,
    pub site_id: String,
    #[serde(default)]
    pub actor: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub op: Option<String>,
    #[serde(default)]
    pub artifact_op: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<Value>>,
}

/// `event`: fire and forget, handled in line order. The `type` tag is the event kind.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ChildEvent {
    Log {
        message: String,
    },
    Report {
        site_id: String,
        #[serde(default)]
        item: Value,
        #[serde(default)]
        artifact_id: Option<String>,
    },
    DeclareArtifact {
        site_id: String,
        op: String,
        args: Vec<Value>,
    },
    PhaseEntered {
        name: String,
    },
}

/// `complete`: the script's end, a value or an error. The child sends nothing after it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub ok: bool,
    #[serde(default)]
    pub value: Option<Value>,
    #[serde(default)]
    pub error: Option<WireError>,
}

/// `WireError`: a structured error that crosses the boundary (ask refusals keep `code`, `violations` and `finalText`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireError {
    pub name: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub violations: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
}

/// The host → child line that answers one request.
pub fn response_line(id: &str, answer: &Result<Value, WireError>) -> String {
    let line = match answer {
        Ok(value) => json!({"kind": "response", "id": id, "ok": true, "value": value}),
        Err(error) => json!({"kind": "response", "id": id, "ok": false, "error": error}),
    };
    format!("{line}\n")
}

/// A positioned compile diagnostic, in the author's script (1-based). The helper's compile answers them. It is the same
/// type as the checker's diagnostic in `workflow_analysis` (one shape, one serde-capable definition).
pub use crate::workflow_analysis::WorkflowDiagnostic as Diagnostic;

/// What a launch needs from the run: the script and the run it starts, its frozen args and resume origin, and the
/// directory the entry file goes into (the session's cwd). Nothing else reaches the compile, the entry file or the host.
#[derive(Debug, Clone, PartialEq)]
pub struct LaunchInput {
    pub script_text: String,
    pub run_id: String,
    pub args: Option<Map<String, Value>>,
    pub resumed_from: Option<String>,
    pub cwd: PathBuf,
}

/// Why a launch did not start a child. Nothing was spawned in either case.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LaunchError {
    /// The script did not compile. `message` is set when the compile threw after its diagnostics passed.
    #[error("the workflow script did not compile")]
    Rejected {
        diagnostics: Vec<Diagnostic>,
        message: Option<String>,
    },
    /// The compile helper, the entry file or the process failed. The text names the step and the reason.
    #[error("{0}")]
    Failed(String),
}

/// Stops a running child. Cheap to clone, so the run's owner can keep it while another task awaits the outcome.
#[derive(Debug, Clone)]
pub struct ChildStop(CancellationToken);

impl ChildStop {
    pub fn new(token: CancellationToken) -> Self {
        Self(token)
    }

    /// Ends the child's process tree. The outcome then settles as `Stopped(Interrupted)`. Calling it again is a no-op.
    pub fn stop(&self) {
        self.0.cancel();
    }

    /// Whether `stop` has been called.
    pub fn is_stopped(&self) -> bool {
        self.0.is_cancelled()
    }
}

/// A started child: what the compile produced, where the entry file is, a way to stop the child, and its outcome.
///
/// The implementation drives the child's lines while the outcome is unpolled, so the child is not blocked on a full
/// pipe. Dropping the outcome future before it settles ends the child's process tree, as `stop` does.
pub struct RunningChild {
    /// The compiled script's hash, as the helper computed it.
    pub script_hash: String,
    /// The compiled facts without the lowered body, as the helper returned them.
    pub compiled: Value,
    /// The entry file the child started from.
    pub entry_path: PathBuf,
    /// Whether the entry file went to the fallback directory, because the project directory was not writable.
    pub entry_fallback: bool,
    pub stop: ChildStop,
    /// Resolves once, with the run's outcome.
    pub outcome: BoxFuture<'static, Outcome>,
}

/// Starts workflow runs: compile the script, write its entry file, launch the child and hand the child's messages to
/// the handler. The runtime reaches this port through `kernel-api`; the implementation lives where the helper client and
/// the NDJSON host are (`protocol-zcode`), so the runtime crate does not depend on the protocol crate.
#[async_trait]
pub trait WorkflowChildRunner: Send + Sync {
    async fn start(
        &self,
        input: LaunchInput,
        handler: Arc<dyn ChildHandler>,
    ) -> Result<RunningChild, LaunchError>;
}

#[cfg(test)]
mod tests {
    use std::error::Error as _;

    use super::*;

    #[test]
    fn a_failed_launch_reads_as_its_text() {
        let error = LaunchError::Failed("the compile helper failed: the helper is down".to_owned());
        assert_eq!(
            error.to_string(),
            "the compile helper failed: the helper is down"
        );
        assert!(error.source().is_none());
    }

    #[test]
    fn a_rejected_launch_reads_as_a_compile_failure() {
        let error = LaunchError::Rejected {
            diagnostics: Vec::new(),
            message: None,
        };
        assert_eq!(error.to_string(), "the workflow script did not compile");
    }

    #[test]
    fn launch_errors_compare_for_equality() {
        fn assert_eq_impl<T: Eq>() {}
        assert_eq_impl::<LaunchError>();
    }
}
