//! Fork: the dynamic-workflow run port (Node `contracts/src/interfaces/dynamic-workflow-run.port.ts`;
//! specs/fork-rust-workflow-engine.md, W7-1). Trait and types only: the run service (W7-5) implements it, and the tools
//! (W7-7..10) call it. The optional members follow Node's optional-member rule: a default method answers
//! [`DynamicWorkflowRunError::unsupported`], which a tool reports as "this session does not support the capability".
//!
//! Shapes not needed by the scaffold (snapshots, details, list items, fill results) travel as JSON values; each
//! PR that owns a tool types its own fields (the spec's W7 split).

use async_trait::async_trait;
use serde_json::{Map, Value};

use crate::ids::{QuestionId, SessionId, WorkflowRunId};

/// Node `DynamicWorkflowRunAmendRefusalReason`. The two cases need different next steps, so both are kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmendRefusalReason {
    /// The predecessor run does not exist in the journal.
    RunNotFound,
    /// The predecessor has a completed ask without message-boundary accounting: reject the whole amendment.
    MissingBoundaries,
}

impl AmendRefusalReason {
    /// Node's wire literal.
    pub fn code(self) -> &'static str {
        match self {
            Self::RunNotFound => "run_not_found",
            Self::MissingBoundaries => "missing_boundaries",
        }
    }
}

/// Node `DynamicWorkflowResolveQuestionRefusalReason`: three different next steps for the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveQuestionRefusalReason {
    /// The qid is absent from the registry (misspelled, or stale from a dead process).
    UnknownQuestion,
    /// The question was already answered; the actor continued with that answer.
    AlreadyResolved,
    /// The run or ask is no longer in flight; nobody waits for this answer.
    RunNotInFlight,
}

impl ResolveQuestionRefusalReason {
    /// Node's wire literal.
    pub fn code(self) -> &'static str {
        match self {
            Self::UnknownQuestion => "unknown_question",
            Self::AlreadyResolved => "already_resolved",
            Self::RunNotInFlight => "run_not_in_flight",
        }
    }
}

/// Node `DynamicWorkflowRunLifecycleStatus`. Introspection keeps `pending`, which the snapshot folds into `running`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecycleStatus {
    Completed,
    Errored,
    Pending,
    Running,
    Stopped,
}

impl LifecycleStatus {
    pub fn code(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Errored => "errored",
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Stopped => "stopped",
        }
    }
}

/// Node `DynamicWorkflowRunStopReason`. `superseded` and `errored` cannot be resumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    User,
    Model,
    Provider,
    Interrupted,
    Superseded,
}

impl StopReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Model => "model",
            Self::Provider => "provider",
            Self::Interrupted => "interrupted",
            Self::Superseded => "superseded",
        }
    }
}

/// Node `DynamicWorkflowRunCancelInitiator`: the amend path passes `Superseded` with the new run id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelInitiator {
    User,
    Model,
    Superseded(WorkflowRunId),
}

/// Node `DynamicWorkflowRunAmendRequest`. Model selections and script-named bindings stay JSON until W7-8a types them.
#[derive(Debug, Clone, PartialEq)]
pub struct AmendRequest {
    pub script_text: String,
    pub cwd: String,
    /// The run being amended, in any state.
    pub predecessor_run_id: WorkflowRunId,
    pub name: Option<String>,
    pub parent_session_id: Option<SessionId>,
    pub tool_call_id: Option<String>,
    pub phase_names: Option<Vec<String>>,
    pub max_concurrency: Option<f64>,
    pub subagent_model: Option<Value>,
    pub model_bindings: Option<Value>,
    pub script_path: Option<String>,
    pub phase_alongside: Option<Vec<Vec<usize>>>,
    /// Only the GUI "Configure" flow sets it: reuse the predecessor's stored arguments.
    pub inherit_args: bool,
}

/// Node `DynamicWorkflowRunAmendResult`. A refusal has no side effects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AmendResult {
    Started {
        run_id: WorkflowRunId,
        /// Present when this amendment stopped a running predecessor.
        superseded_run_id: Option<WorkflowRunId>,
    },
    Refused(AmendRefusalReason),
}

/// Node `DynamicWorkflowRunListQuery`: `cwd` and `limit` are required, the tool clamps `limit` to [1, 50].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListQuery {
    pub cwd: String,
    pub limit: usize,
    /// `None` means no filter; `Some(empty)` matches nothing.
    pub statuses: Option<Vec<LifecycleStatus>>,
}

/// Node `DynamicWorkflowResolveQuestionResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveQuestionResult {
    Resolved {
        qid: QuestionId,
    },
    Refused {
        reason: ResolveQuestionRefusalReason,
        message: String,
    },
}

/// Node `DynamicWorkflowRunSubmitRequest`, for the fields CreateWorkflow (W7-8a) can fill. The trace, the launch input,
/// the phase table and the model selections are not here yet: the run service (W7-5) and the model catalog own them, and
/// each adds its field with its own PR.
#[derive(Debug, Clone, PartialEq)]
pub struct SubmitRequest {
    /// The script body that runs (the metadata block of a saved file is not part of it).
    pub script_text: String,
    pub cwd: String,
    /// Display label only; omitted means unnamed.
    pub name: Option<String>,
    /// Declared arguments, already validated and filled with defaults. Inline scripts pass none.
    pub args: Option<Map<String, Value>>,
    pub parent_session_id: Option<SessionId>,
    /// The CreateWorkflow tool call that started the run.
    pub tool_call_id: Option<String>,
    pub max_concurrency: Option<u64>,
    /// Absolute path of the file the script came from (a draft or a `path` source), when there is one.
    pub script_path: Option<String>,
}

/// A failed port call that is not a business refusal (a wiring fault, or a missing optional member).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct DynamicWorkflowRunError {
    pub message: String,
}

impl DynamicWorkflowRunError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// The optional-member fallback: this session does not provide the capability.
    pub fn unsupported(method: &str) -> Self {
        Self::new(format!("dynamic workflow port does not support {method}"))
    }
}

/// Node `DynamicWorkflowRunPort`. `submit` (W7-8a) is the start; the run service (W7-5) implements it.
#[async_trait]
pub trait DynamicWorkflowRunPort: Send + Sync {
    /// Node `defaultConcurrency`: the starting point, not a cap. `None` when the port cannot report it.
    fn default_concurrency(&self) -> Option<usize> {
        None
    }

    /// Node `amend`. A refusal is a result, not an error.
    async fn amend(&self, request: AmendRequest) -> Result<AmendResult, DynamicWorkflowRunError> {
        let _ = request;
        Err(DynamicWorkflowRunError::unsupported("amend"))
    }

    /// Node `submit`: starts a new run in the background and returns its run id (also its background task id). A
    /// wiring failure is an error; a new run has no business refusal.
    async fn submit(
        &self,
        request: SubmitRequest,
    ) -> Result<WorkflowRunId, DynamicWorkflowRunError> {
        let _ = request;
        Err(DynamicWorkflowRunError::unsupported("submit"))
    }

    /// Node `cancel`: `false` for an unknown run id.
    async fn cancel(
        &self,
        run_id: &WorkflowRunId,
        initiator: CancelInitiator,
    ) -> Result<bool, DynamicWorkflowRunError> {
        let _ = (run_id, initiator);
        Err(DynamicWorkflowRunError::unsupported("cancel"))
    }

    /// Node `listRuns`, the `ListWorkflowRuns` surface. Items are JSON until W7-8b types them.
    async fn list_runs(&self, query: ListQuery) -> Result<Value, DynamicWorkflowRunError> {
        let _ = query;
        Err(DynamicWorkflowRunError::unsupported("listRuns"))
    }

    /// Node `getRunDetail`: `None` for an unknown run id.
    async fn get_run_detail(
        &self,
        run_id: &WorkflowRunId,
    ) -> Result<Option<Value>, DynamicWorkflowRunError> {
        let _ = run_id;
        Err(DynamicWorkflowRunError::unsupported("getRunDetail"))
    }

    /// Node `getScript`: the exact saved bytes, `None` when the run has none.
    async fn get_script(
        &self,
        run_id: &WorkflowRunId,
    ) -> Result<Option<String>, DynamicWorkflowRunError> {
        let _ = run_id;
        Err(DynamicWorkflowRunError::unsupported("getScript"))
    }

    /// Node `resume`: rerun a cancelled run, or one interrupted by process death, under the same run id.
    async fn resume(&self, run_id: &WorkflowRunId) -> Result<Value, DynamicWorkflowRunError> {
        let _ = run_id;
        Err(DynamicWorkflowRunError::unsupported("resume"))
    }

    /// Node `resolveQuestion`: answer an escalated question by its qid.
    async fn resolve_question(
        &self,
        qid: &QuestionId,
        answer: &str,
    ) -> Result<ResolveQuestionResult, DynamicWorkflowRunError> {
        let _ = (qid, answer);
        Err(DynamicWorkflowRunError::unsupported("resolveQuestion"))
    }
}
