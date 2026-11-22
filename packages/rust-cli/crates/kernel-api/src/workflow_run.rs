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

/// Node `DynamicWorkflowRunSubmitRequest`, for the fields CreateWorkflow (W7-8a) can fill. The trace, the launch input
/// and the model selections are not here yet: the run service (W7-5) and the model catalog own them, and
/// each adds its field with its own PR. The phase table is here: `phase_names` and `phase_alongside` (from the window graph).
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
    /// The script's named phases in declaration order (Node `phaseNames`, from the window graph). `None` when it names none.
    pub phase_names: Option<Vec<String>>,
    /// Per named phase, the indexes of the phases that run alongside it (Node `phaseAlongside`). `None` when none does.
    pub phase_alongside: Option<Vec<Vec<usize>>>,
    /// Fork (9.63): the run's subagent model, canonical `provider/model[$level]` (Node `subagentModel`). `None` runs the
    /// subagents on the parent's model.
    pub subagent_model: Option<String>,
    /// Fork (9.63): the script's model table, name to canonical model (Node `modelBindings`). `None` when it names none.
    pub model_bindings: Option<Map<String, Value>>,
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

    /// Node `replayProgressForSession` (9.62, DWP-02): this session's journaled runs that are not live in this process,
    /// replayed into the `workflowRuns` deltas a cold open folds into its snapshot. Empty when the host keeps no journal.
    async fn replay_progress_for_session(&self) -> Result<Vec<Value>, DynamicWorkflowRunError> {
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

    /// Node `amendWorkflowRunSettings` (9.53, W9a): the GUI "Configure" change of a run, in place or by amendment. The
    /// settings turn and the activation go through `sink`. A refusal is a result; a failed amend is a refusal too.
    async fn amend_settings(
        &self,
        request: SettingsRequest,
        sink: Arc<dyn WorkflowTurnSink>,
    ) -> Result<SettingsOutcome, DynamicWorkflowRunError> {
        let _ = (request, sink);
        Err(DynamicWorkflowRunError::unsupported(
            "amendWorkflowRunSettings",
        ))
    }

    /// Node `startSavedWorkflowRun` (9.53, W9a): the hub's direct start of a saved workflow in this session. The session
    /// busy check is the caller's (it reads the session); the saved resolution, arguments, compile, activation, submit
    /// and launch turn are the port's. A refusal is a result, not an error.
    async fn start_saved(
        &self,
        request: StartSavedRequest,
        sink: Arc<dyn WorkflowTurnSink>,
    ) -> Result<StartSavedOutcome, DynamicWorkflowRunError> {
        let _ = (request, sink);
        Err(DynamicWorkflowRunError::unsupported("startSavedWorkflow"))
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

/// Fork (W9a, 9.53): the GUI "Configure" change (Node `AmendWorkflowRunSettingsInput`). An omitted field keeps the run's
/// setting. Inside a `Some`, `None` returns the setting to the default (Node's `null`) and a value sets it.
#[derive(Debug, Clone, PartialEq)]
pub struct SettingsRequest {
    pub run_id: WorkflowRunId,
    /// Fork (9.63, closes 663): `None` keeps the run's subagent model, `Some(None)` puts its subagents back on the session
    /// model, and `Some(Some(name))` is resolved against the catalog (a name that does not resolve refuses the change). A
    /// model change always amends the run.
    pub subagent_model: Option<Option<String>>,
    pub max_concurrency: Option<Option<f64>>,
}

/// One side of a limit change. `None` is the default, which Node leaves absent from its metadata.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SettingsChange {
    pub from: Option<f64>,
    pub to: Option<f64>,
}

/// Fork (9.63): one side pair of a subagent-model change (Node `fromTo` of canonical strings).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelChange {
    pub from: Option<String>,
    pub to: Option<String>,
}

/// What the settings turn records of the change (the parts of Node's `WorkflowSettingsAmendMeta` this host builds).
#[derive(Debug, Clone, PartialEq)]
pub struct SettingsAmend {
    /// Absent for an in-place change: its absence means "applied in place" (Node).
    pub predecessor_run_id: Option<WorkflowRunId>,
    /// Fork (9.63, closes 663): a subagent-model change, canonical sides; `None` on a side is the session model.
    pub subagent_model: Option<ModelChange>,
    pub max_concurrency: Option<SettingsChange>,
    /// Node's `ceiling`: the default concurrency at the change.
    pub default_concurrency: f64,
}

/// A settings turn, as the parent receives it: the model-facing text and the card's metadata.
#[derive(Debug, Clone, PartialEq)]
pub struct SettingsTurn {
    pub text: String,
    /// The run the card is about: the successor for an amendment, the run itself for an in-place change.
    pub run_id: WorkflowRunId,
    pub tool_call_id: String,
    pub name: Option<String>,
    /// The title seed (Node `titleInput`): the run's name, else the run id the change started from.
    pub title_input: String,
    pub amend: SettingsAmend,
    /// Fork (9.63): the kept script's `create_workflow` display for an amendment (Node `displayOfAnalysis`), which the
    /// successor's card draws its graph from. `None` in place, or when the checker gave none.
    pub display: Option<Value>,
}

impl SettingsTurn {
    /// Fork (9.63): Node's `boundWorkflowLaunchMeta` of a settings turn, the `workflowLaunch` metadata its rows carry.
    pub fn workflow_launch_meta(&self) -> Value {
        let mut meta = Map::new();
        meta.insert("runId".into(), Value::from(self.run_id.as_str()));
        meta.insert("toolCallId".into(), Value::from(self.tool_call_id.as_str()));
        if let Some(name) = &self.name {
            meta.insert("name".into(), Value::from(name.as_str()));
        }
        if let Some(display) = &self.display {
            meta.insert("display".into(), display.clone());
        }
        let mut amend = Map::new();
        if let Some(predecessor) = &self.amend.predecessor_run_id {
            amend.insert("predecessorRunId".into(), Value::from(predecessor.as_str()));
        }
        if let Some(change) = &self.amend.subagent_model {
            let mut sides = Map::new();
            if let Some(from) = &change.from {
                sides.insert("from".into(), Value::from(from.as_str()));
            }
            if let Some(to) = &change.to {
                sides.insert("to".into(), Value::from(to.as_str()));
            }
            amend.insert("subagentModel".into(), Value::Object(sides));
        }
        if let Some(change) = self.amend.max_concurrency {
            let mut sides = Map::new();
            if let Some(from) = change.from {
                sides.insert("from".into(), Value::from(from));
            }
            if let Some(to) = change.to {
                sides.insert("to".into(), Value::from(to));
            }
            amend.insert("maxConcurrency".into(), Value::Object(sides));
        }
        amend.insert(
            "ceiling".into(),
            Value::from(self.amend.default_concurrency),
        );
        meta.insert("amend".into(), Value::Object(amend));
        Value::Object(meta)
    }
}

/// Fork (W9a, 9.53): a launch turn of the hub start (Node `emitControlOnlyUserTurn` with origin `workflowLaunch`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchTurn {
    pub text: String,
    pub run_id: WorkflowRunId,
    pub tool_call_id: String,
    pub name: String,
    /// Fork (W9h, 9.64): the rest of Node's launch metadata (`startSavedWorkflowRun`): `project` or `global`.
    pub scope: String,
    /// The saved file the run started from (Node `found.path`).
    pub path: Option<String>,
    /// The validated arguments; empty when the workflow declares none (Node sends no `args` then).
    pub args: Map<String, Value>,
    /// The definition's description line (Node `found.meta.description`).
    pub description: Option<String>,
    /// The `create_workflow` display of the compiled script (Node `displayOfAnalysis`), when the checker gave one.
    pub display: Option<Value>,
    /// The script body that runs (Node `found.script`).
    pub script: String,
}

/// Node `WORKFLOW_LAUNCH_ARGS_MAX_BYTES`, `WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS` and `WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS`
/// (contracts `events/session.events.ts`); the two character bounds count UTF-16 units, as JavaScript strings do.
const LAUNCH_ARGS_MAX_BYTES: usize = 4_096;
const LAUNCH_DESCRIPTION_MAX_UNITS: usize = 500;
const LAUNCH_SCRIPT_MAX_UNITS: usize = 256_000;

impl LaunchTurn {
    /// Fork (W9h, 9.64; closes 916): Node's `boundWorkflowLaunchMeta` of a hub launch, the `workflowLaunch` metadata its
    /// rows carry. Arguments over the byte bound become one `…` marker, a long description is cut with an ellipsis, and a
    /// script over its bound is left out.
    pub fn workflow_launch_meta(&self) -> Value {
        let mut meta = Map::new();
        meta.insert("runId".into(), Value::from(self.run_id.as_str()));
        meta.insert("toolCallId".into(), Value::from(self.tool_call_id.as_str()));
        meta.insert("name".into(), Value::from(self.name.as_str()));
        meta.insert("scope".into(), Value::from(self.scope.as_str()));
        if let Some(path) = &self.path {
            meta.insert("path".into(), Value::from(path.as_str()));
        }
        if !self.args.is_empty() {
            let bytes = Value::Object(self.args.clone()).to_string().len();
            let args = if bytes > LAUNCH_ARGS_MAX_BYTES {
                let mut marker = Map::new();
                marker.insert(
                    "…".into(),
                    Value::from(format!("arguments omitted ({bytes} bytes)")),
                );
                marker
            } else {
                self.args.clone()
            };
            meta.insert("args".into(), Value::Object(args));
        }
        if let Some(description) = &self.description {
            meta.insert(
                "description".into(),
                Value::from(bound_units(description, LAUNCH_DESCRIPTION_MAX_UNITS)),
            );
        }
        if let Some(display) = &self.display {
            meta.insert("display".into(), display.clone());
        }
        if self.script.encode_utf16().count() <= LAUNCH_SCRIPT_MAX_UNITS {
            meta.insert("script".into(), Value::from(self.script.as_str()));
        }
        Value::Object(meta)
    }
}

/// Node's `slice(0, max - 1) + "…"` for a text over `max` UTF-16 units; the cut never splits a character.
fn bound_units(text: &str, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text.to_owned();
    }
    let mut units = 0;
    let mut out = String::new();
    for character in text.chars() {
        units += character.len_utf16();
        if units > max - 1 {
            break;
        }
        out.push(character);
    }
    out.push('…');
    out
}

/// The origin a workflow control record carries on the parent's transcript: a closed set, so a producer names one of these
/// and the session's record filter (`is_record_source`) recognizes exactly these. `Launch` is a hub start's record (Node's
/// `workflowLaunch` origin); `Settings` is a GUI settings change's record (Node's settings turn).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowRecordSource {
    Launch,
    Settings,
}

impl WorkflowRecordSource {
    /// The stored origin text: the meta user message's `source`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launch => "workflow_launch",
            Self::Settings => "workflow_settings",
        }
    }

    /// Whether a stored meta `source` is a workflow control record's. The one place the recognized set is listed.
    pub fn is_record_source(source: &str) -> bool {
        [Self::Launch, Self::Settings]
            .into_iter()
            .any(|record| record.as_str() == source)
    }
}

/// The parent's side of a run's turns (Node `activateDynamicWorkflowTools`, `enqueueSettingsTurn` and the launch turn).
/// The sink belongs to one parent session: the port that receives it is that session's, so no method names the session.
///
/// The records are handed over once, before the port's answer: a record offered after the answer is not sent (the protocol logs
/// it). A port must push each record before it resolves its start or change.
///
/// The records are best effort and are not acknowledged to the caller: a record that the session cannot store is logged
/// by the sink, and the start or the change still answers as it did (divergence 773 in the W9a spec section).
#[async_trait]
pub trait WorkflowTurnSink: Send + Sync {
    /// A successful start or configuration activates the workflow tools (Node, `source: "run_control"`). `false` when the
    /// session has no gate record to activate in.
    fn activate(&self) -> bool;
    /// Fork (W9h, 9.64; closes 766): Node `ensureSessionPersisted(name)` of a hub start, after the compile and before the
    /// submit. A fresh new-task draft has no session row yet, and the run's parent bindings read that row, so the start
    /// gives the draft its row (titled with the workflow's name) first. A refused start persists nothing. The default
    /// has nothing to persist.
    async fn persist_parent(&self, _title: &str) -> Result<(), String> {
        Ok(())
    }
    /// Queues the settings turn to the parent as a control-only turn, after the work in flight.
    fn settings_turn(&self, turn: SettingsTurn);
    /// Records the launch turn of a hub start as a control-only turn, after the work in flight.
    fn launch_turn(&self, turn: LaunchTurn);
}

/// Node's answer of a settings change. A refusal changes nothing, with one exception: `Refused(StartFailed)` can follow an
/// amend that already stopped and superseded a live predecessor (the amend's message says so).
#[derive(Debug, Clone, PartialEq)]
pub enum SettingsOutcome {
    /// Applied in place: the same run, with no stop and no successor.
    Retuned {
        run_id: WorkflowRunId,
        tool_call_id: String,
    },
    /// The run was amended: a successor started, and the predecessor it superseded if it was live.
    Amended {
        run_id: WorkflowRunId,
        tool_call_id: String,
        superseded_run_id: Option<WorkflowRunId>,
    },
    Refused(SettingsRefusal),
}

/// Why a settings change is refused, in Node's vocabulary minus `compile_failed` (divergence 674). Node's shared schema
/// also lists `compile_failed`: it answers a stored script that no longer compiles at the step-8 pre-compile. This host
/// has no such pre-compile; a script that fails inside the amend's probe is `start_failed` (divergence 675).
/// Serialized reasons: `not_found`, `not_configurable`, `unchanged`, `script_missing`, `model_unavailable`,
/// `missing_boundaries`, `start_failed`.
#[derive(Debug, Clone, PartialEq)]
pub enum SettingsRefusal {
    NotFound,
    NotConfigurable,
    Unchanged,
    ScriptMissing,
    ModelUnavailable { message: String },
    MissingBoundaries,
    StartFailed { message: String },
}

/// Fork (W9a, 9.53): the hub's direct start (Node `startSavedWorkflowRun`'s input). `scope` is `project` or `global` when
/// given. The session's working directory is the one the saved workflow is resolved in.
#[derive(Debug, Clone, PartialEq)]
pub struct StartSavedRequest {
    pub cwd: String,
    pub name: String,
    pub scope: Option<String>,
    pub args: Option<Map<String, Value>>,
}

/// The answer of a hub start. The busy refusal is the caller's (the session has work in flight, Node `session_busy`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartSavedOutcome {
    Started {
        run_id: WorkflowRunId,
        tool_call_id: String,
    },
    Refused(StartRefusal),
}

/// Why a hub start is refused, in Node's vocabulary (`invalid_name`, `not_found`, `invalid_args`, `compile_failed`,
/// `start_failed`). Each message is the text Node sends in the ack.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartRefusal {
    InvalidName { message: String },
    NotFound { message: String },
    InvalidArgs { message: String },
    CompileFailed { message: String },
    StartFailed { message: String },
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
