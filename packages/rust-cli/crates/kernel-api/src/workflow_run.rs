//! Fork: the dynamic-workflow run port (Node `contracts/src/interfaces/dynamic-workflow-run.port.ts`;
//! specs/fork-rust-workflow-engine.md, W7-1). Trait and types only: the run service (W7-5) implements it, and the tools
//! (W7-7..10) call it. The optional members follow Node's optional-member rule: a default method answers
//! [`DynamicWorkflowRunError::unsupported`], which a tool reports as "this session does not support the capability".
//!
//! Shapes not needed by the scaffold (snapshots, details, list items, fill results) travel as JSON values; each
//! PR that owns a tool types its own fields (the spec's W7 split).

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{Map, Value};

use crate::ids::{QuestionId, SessionId, WorkflowRunId};

/// The Host's view of the run service: one run port per parent session (Node's run service is one object per
/// session). Set once by the composition root; the protocol answers a session's run reads through it.
pub trait DynamicWorkflowRunSessions: Send + Sync {
    fn for_session(&self, session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort>;
}

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

/// Node `fillHole`'s refusal reasons (`DynamicWorkflowRunFillHoleRefusalReason`), as the tool reports them (W7-12, 9.45).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillRefusalReason {
    RunNotFound,
    HoleNotWaiting,
    CompileFailed,
    FillIdsUnstable,
}

impl FillRefusalReason {
    /// Node's wire literal for a refusal reason the compile helper sends. The one table of literals: `None` for any other
    /// text. `RunNotFound` has no literal here on purpose: the helper never sends it, and the run service builds it from its
    /// own journal lookup. A tool-level adapter that decodes Node's `run_not_found` result must map that text itself.
    pub fn from_code(code: &str) -> Option<Self> {
        match code {
            "hole_not_waiting" => Some(Self::HoleNotWaiting),
            "compile_failed" => Some(Self::CompileFailed),
            "fill_ids_unstable" => Some(Self::FillIdsUnstable),
            _ => None,
        }
    }
}

/// Node `DynamicWorkflowRunFillHoleRequest`: the waiting run, the hole's site id, and the body's statements.
#[derive(Debug, Clone, PartialEq)]
pub struct FillHoleRequest {
    pub run_id: WorkflowRunId,
    pub hole_id: String,
    pub body: String,
    pub parent_session_id: Option<SessionId>,
}

/// Node `FillWorkflowHoleResult`, the port's part: a fill (with the phases it added and the effective script) or a
/// refusal with its text and diagnostics. A refusal has no side effects.
#[derive(Debug, Clone, PartialEq)]
pub enum FillHoleOutcome {
    Filled {
        phases_added: Vec<String>,
        script_text: String,
    },
    Refused {
        reason: FillRefusalReason,
        message: String,
        diagnostics: Option<Value>,
    },
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

/// Node `retuneConcurrency` (9.50, divergence 455): a concurrency-only change to a run in flight, applied in place. `None` is
/// the default concurrency (Node's `null`); a value is floored and kept at least 1 by the run service.
#[derive(Debug, Clone, PartialEq)]
pub struct RetuneRequest {
    pub run_id: WorkflowRunId,
    pub max_concurrency: Option<f64>,
}

/// Node `DynamicWorkflowRunRetuneResult`. A refusal is an answer (the caller then amends the run); a failure is an error.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RetuneOutcome {
    Retuned {
        previous: f64,
        max_concurrency: f64,
        default_concurrency: f64,
    },
    Refused(RetuneRefusal),
}

/// Why a retune is refused: the run is not live here (unknown, settled, starting or being stopped), or the limit is already
/// the one asked for (with the limit in effect).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RetuneRefusal {
    NotLive,
    Unchanged { current: f64 },
}

/// A live run of one session, as the background list shows it (Node's background tracker entry for a dynamic workflow run,
/// 9.52, divergence 609). `title` is the run's name, else its id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackgroundRunWork {
    pub run_id: WorkflowRunId,
    pub title: String,
    pub started_at_ms: i64,
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

/// The text of an optional-member fallback. The tools tell a missing capability from a failed call by it.
const UNSUPPORTED_PREFIX: &str = "dynamic workflow port does not support ";

impl DynamicWorkflowRunError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// The optional-member fallback: this session does not provide the capability.
    pub fn unsupported(method: &str) -> Self {
        Self::new(format!("{UNSUPPORTED_PREFIX}{method}"))
    }

    /// Whether this is the optional-member fallback (the capability is absent), not a failed call.
    pub fn is_unsupported(&self) -> bool {
        self.message.starts_with(UNSUPPORTED_PREFIX)
    }
}

/// Fork (W7-9, specs/fork-rust-workflow-engine.md 9.40): the run sessions the workflow tools reach. The gate is built
/// before the kernel and the run service (9.36), so the tools hold this slot, and the composition root sets it once the
/// service exists. Until then, and in a build with no run service, every session's port answers each member with the
/// optional-member fallback, which the tools report as "this session cannot ...".
#[derive(Default)]
pub struct LateRunSessions {
    sessions: std::sync::OnceLock<Arc<dyn DynamicWorkflowRunSessions>>,
}

impl LateRunSessions {
    /// Sets the run sessions. A second set is refused and keeps the first.
    pub fn set(&self, sessions: Arc<dyn DynamicWorkflowRunSessions>) -> bool {
        self.sessions.set(sessions).is_ok()
    }
}

impl DynamicWorkflowRunSessions for LateRunSessions {
    fn for_session(&self, session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        match self.sessions.get() {
            Some(sessions) => sessions.for_session(session),
            None => Arc::new(NoRunPort),
        }
    }
}

/// The port of a build with no run service: every member is the optional-member fallback.
struct NoRunPort;

#[async_trait]
impl DynamicWorkflowRunPort for NoRunPort {}

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

    /// Node `fillHole` (W7-12, 9.45): fills one waiting hole of a run in flight. A refusal is a result, not an error.
    async fn fill_hole(
        &self,
        request: FillHoleRequest,
    ) -> Result<FillHoleOutcome, DynamicWorkflowRunError> {
        let _ = request;
        Err(DynamicWorkflowRunError::unsupported("fillHole"))
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

    /// Node `listRuns`, the `ListWorkflowRuns` surface: `{runs, truncated?}` in Node's item shape. Items are JSON until W7-8b types them.
    async fn list_runs(&self, query: ListQuery) -> Result<Value, DynamicWorkflowRunError> {
        let _ = query;
        Err(DynamicWorkflowRunError::unsupported("listRuns"))
    }

    /// Node `listRunsForSession(limit)`, the `v4/conversation/workflowRuns` read: `{runs}` in the V4 summary shape,
    /// most recently updated first. `limit` is already clamped by the caller to [1, 64].
    async fn list_runs_for_session(&self, limit: usize) -> Result<Value, DynamicWorkflowRunError> {
        let _ = limit;
        Err(DynamicWorkflowRunError::unsupported("listRunsForSession"))
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

    /// Node's background tracker for runs (9.52, divergence 609): this session's live runs, in start order. Empty when the
    /// host keeps no run service.
    async fn background_runs(&self) -> Result<Vec<BackgroundRunWork>, DynamicWorkflowRunError> {
        Ok(Vec::new())
    }

    /// Fork (9.52): ticks whenever the host's live run set changes (a run started or settled on its own), so the session
    /// re-reads its background works without a kernel event. `None` when the host keeps no run service.
    fn background_changes(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        None
    }

    /// Node `retuneConcurrency` (9.50): changes a live run's limit in place, with no successor and no stop. A refusal is a
    /// result; the GUI settings route amends the run when the retune is refused as not live.
    async fn retune_concurrency(
        &self,
        request: RetuneRequest,
    ) -> Result<RetuneOutcome, DynamicWorkflowRunError> {
        let _ = request;
        Err(DynamicWorkflowRunError::unsupported("retuneConcurrency"))
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

/// The run service's lifecycle as the composition root holds it (specs/fork-rust-workflow-engine.md, 9.30). The
/// composition root keeps it on the protocol context, so the shutdown can close the live runs before the sessions drain.
/// The tools reach the run service through [`DynamicWorkflowRunPort`], not this trait.
pub trait WorkflowRunHost: Send + Sync {
    /// The runs the service holds: live, or settled and not yet collected.
    fn held_runs(&self) -> usize;

    /// Stops the live runs and waits for their parent sessions to close. Each returned line names a run or a session
    /// that did not close cleanly; an empty result is a clean close.
    fn close(&self) -> futures_util::future::BoxFuture<'static, Vec<String>>;

    /// A parent session opened (cold): settles its orphaned runs (Node's start-up sweep, 9.30 item 212) and then scans
    /// its quota-stopped runs (9.31, divergence 233). The work reads the journal, so it runs off the async workers.
    /// The default does nothing, which is what a composition without a run service gets.
    fn session_opened(
        &self,
        parent_session_id: &str,
    ) -> futures_util::future::BoxFuture<'static, ()> {
        let _ = parent_session_id;
        Box::pin(async {})
    }
}
