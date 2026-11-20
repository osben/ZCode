//! Fork: the run service's host reads over the dwf journal (specs/fork-rust-workflow-engine.md, 9.29, W7-5a-4).
//!
//! `list_runs` is Node's `listRuns` (the `ListWorkflowRuns` surface, `{runs, truncated?}`): journal rows by project
//! and status, with the runs this session's registry holds but the journal has no row for yet. `session_runs` is
//! Node's `listRunsForSession` (the `v4/conversation/workflowRuns` read, `{runs}`). Both read the journal first and
//! consult the live entries of the same parent session only, as Node's per-session registry does
//! (`dynamic-workflow-run-observation.ts`). The summary rules are Node's: `label` from `name`, then the first script
//! line, then the run id; `resumable` is stopped and not superseded.
//!
//! Node's in-memory roster keeps 32 settled entries (divergence 128); a settled run is read from its row only.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::js::string::{trim, utf16_len, utf16_prefix};
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::QuestionId;
use rust_cli_kernel_api::ids::{SessionId, WorkflowRunId};
use rust_cli_kernel_api::workflow_child::LaunchInput;
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunPort, DynamicWorkflowRunSessions, LifecycleStatus,
    ListQuery, ResolveQuestionRefusalReason, ResolveQuestionResult, SubmitRequest,
};
use rust_cli_workflow::actor_mailbox::{ActorHandle, MailboxError};
use rust_cli_workflow::engine::EngineConfig;
use rust_cli_workflow::model::{RunRow, RunStatus, StopReason, js_number};
use rust_cli_workflow::run_store::{RunListQuery, RunListRow};
use serde_json::{Map, Value, json};

use super::WorkflowRunService;

/// Node `MAX_LIST_RUNS_LIMIT`: the session list clamps to it (the default, 16, is the protocol's).
pub const MAX_LIST_RUNS_LIMIT: usize = 64;

/// Node `DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS`, counted in UTF-16 units as JS counts it.
const LABEL_MAX_UNITS: usize = 80;

/// What a live run's entry keeps for the reads that synthesize a run with no row yet (Node's registry entry fields
/// used by `registryRunSummary`). The label is derived once, at launch, so a read copies no script text.
#[derive(Debug)]
pub(crate) struct RunMeta {
    pub cwd: Option<String>,
    pub label: String,
    pub label_source: &'static str,
    pub resumed_from: Option<String>,
    pub inherited_tokens: f64,
    pub started_at_ms: i64,
}

impl RunMeta {
    /// Captured at launch, before the config moves into the owner.
    pub(crate) fn at_launch(
        input: &LaunchInput,
        config: &EngineConfig,
        started_at_ms: i64,
    ) -> Self {
        let (label, label_source) = run_label(
            &input.run_id,
            config.name.as_deref(),
            Some(&input.script_text),
        );
        Self {
            cwd: config.cwd.clone(),
            label,
            label_source,
            resumed_from: input
                .resumed_from
                .clone()
                .or_else(|| config.resumed_from.clone()),
            inherited_tokens: config.inherited_tokens.unwrap_or(0.0),
            started_at_ms,
        }
    }
}

/// A live run of one parent session, as the reads see it: its id, its launch token (submit order), its meta, and the
/// handle its owner answers on (the answer to a parked question, 9.40).
pub(crate) struct LiveRun {
    pub run_id: String,
    pub token: u64,
    pub meta: Arc<RunMeta>,
    pub handle: ActorHandle,
}

/// Picks the answer among the live runs' outcomes, in launch order. The first accepted answer wins. A run whose owner is
/// gone (`NotDelivered`: it settled after the snapshot) is skipped. An error is returned only when no run accepted and
/// some run failed for another reason.
///
pub(crate) fn first_answer<T>(
    outcomes: impl IntoIterator<Item = Result<Option<T>, MailboxError>>,
) -> Result<Option<T>, MailboxError> {
    let mut failure = None;
    for outcome in outcomes {
        match outcome {
            Ok(Some(answer)) => return Ok(Some(answer)),
            Ok(None) | Err(MailboxError::NotDelivered) => {}
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(None),
    }
}

/// Node `unknown_question`: the text the service gives a qid no live run of the session holds.
fn unknown_question_message(qid: &str) -> String {
    format!(
        "Unknown question id {qid}. It may be misspelled, or it may come from a process that is gone: parked questions are not persisted, so they vanish on restart (a resume makes the subagent ask again under a new id). Use GetWorkflowRun to read the run's pendingQuestions for the ids that are actually awaiting an answer."
    )
}

/// Node `resolveDynamicWorkflowRunLabel`: the name when it is not blank, else the first non-blank script line,
/// else the run id. The label source is `name` only for a user-given name.
pub(crate) fn run_label(
    run_id: &str,
    name: Option<&str>,
    script_text: Option<&str>,
) -> (String, &'static str) {
    if let Some(name) = name.map(trim).filter(|name| !name.is_empty()) {
        return (name.to_owned(), "name");
    }
    if let Some(script) = script_text {
        for line in script.split('\n') {
            let line = trim(line);
            if !line.is_empty() {
                return (bound(line), "script");
            }
        }
    }
    (run_id.to_owned(), "script")
}

/// Cuts a label to 80 UTF-16 units, never inside a character (Node drops a lone high surrogate).
fn bound(line: &str) -> String {
    if utf16_len(line) <= LABEL_MAX_UNITS {
        line.to_owned()
    } else {
        utf16_prefix(line, LABEL_MAX_UNITS).to_owned()
    }
}

/// The lifecycle name the wire uses for a status.
pub(crate) fn status_name(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Pending => "pending",
        RunStatus::Running => "running",
        RunStatus::Completed => "completed",
        RunStatus::Errored => "errored",
        RunStatus::Stopped => "stopped",
    }
}

fn stop_reason_name(reason: StopReason) -> &'static str {
    match reason {
        StopReason::User => "user",
        StopReason::Model => "model",
        StopReason::Provider => "provider",
        StopReason::Interrupted => "interrupted",
        StopReason::Superseded => "superseded",
    }
}

/// Node `TERMINAL_RUN_STATUSES`.
pub(crate) fn is_terminal(status: RunStatus) -> bool {
    matches!(
        status,
        RunStatus::Completed | RunStatus::Errored | RunStatus::Stopped
    )
}

/// Node `synthesizeRunStatus`: an active entry with a terminal row is an external write, so the run is reported
/// running. Otherwise the row's status stands; a run with no row is pending.
fn synthesized(live: bool, row_status: RunStatus) -> RunStatus {
    if live && is_terminal(row_status) {
        RunStatus::Running
    } else {
        row_status
    }
}

/// Node `stopReasonOf`: an active entry has no stop reason; a stopped row has one, `user` when it has none.
fn stop_reason_of(live: bool, run: &RunRow) -> Option<StopReason> {
    if live {
        return None;
    }
    (run.status == RunStatus::Stopped).then(|| run.stop_reason.unwrap_or(StopReason::User))
}

/// Node `supersededByOf` (`dynamic-workflow-run-lineage.ts`): only a terminal entry overrides the row, and an active
/// entry does not. So a live run whose row is stopped still reports the row's successor.
fn superseded_by_of(run: &RunRow) -> Option<&str> {
    if run.status != RunStatus::Stopped {
        return None;
    }
    run.superseded_by.as_deref()
}

/// Node `isResumableSettlement`: stopped, and not superseded (its successor is the one that runs).
fn resumable(status: RunStatus, reason: Option<StopReason>) -> bool {
    status == RunStatus::Stopped && reason != Some(StopReason::Superseded)
}

fn put_lineage(item: &mut Map<String, Value>, run: &RunRow) {
    if let Some(from) = &run.resumed_from {
        item.insert("resumedFrom".into(), json!(from));
    }
    if let Some(by) = superseded_by_of(run) {
        item.insert("supersededBy".into(), json!(by));
    }
}

/// Node `journalRunSummary` plus `spentTokens`: one `listRuns` item.
fn list_item(row: &RunListRow, live: bool, owner: &str) -> Value {
    let run = &row.run;
    let owned = live || run.parent_session_id.as_deref() == Some(owner);
    let (label, source) = run_label(&run.run_id, run.name.as_deref(), run.script_text.as_deref());
    let mut item = Map::new();
    item.insert("runId".into(), json!(run.run_id));
    item.insert("label".into(), json!(label));
    item.insert("labelSource".into(), json!(source));
    item.insert(
        "status".into(),
        json!(status_name(synthesized(live, run.status))),
    );
    if let Some(reason) = stop_reason_of(live, run) {
        item.insert("stopReason".into(), json!(stop_reason_name(reason)));
    }
    put_lineage(&mut item, run);
    item.insert("ownedByThisSession".into(), json!(owned));
    if !is_terminal(run.status) && !owned {
        item.insert("possiblyInterrupted".into(), json!(true));
    }
    item.insert("createdAt".into(), json!(row.time_created));
    item.insert("updatedAt".into(), json!(row.time_updated));
    item.insert("spentTokens".into(), js_number(run.spent_tokens));
    Value::Object(item)
}

/// Node `registryRunSummary` plus `spentTokens`: a live run of this session with no row yet.
fn gap_item(run_id: &str, meta: &RunMeta) -> Value {
    let mut item = Map::new();
    item.insert("runId".into(), json!(run_id));
    item.insert("label".into(), json!(meta.label));
    item.insert("labelSource".into(), json!(meta.label_source));
    item.insert("status".into(), json!(status_name(RunStatus::Pending)));
    if let Some(from) = &meta.resumed_from {
        item.insert("resumedFrom".into(), json!(from));
    }
    item.insert("ownedByThisSession".into(), json!(true));
    item.insert("createdAt".into(), json!(meta.started_at_ms));
    item.insert("updatedAt".into(), json!(meta.started_at_ms));
    item.insert("spentTokens".into(), js_number(meta.inherited_tokens));
    Value::Object(item)
}

/// Node `toSessionSummary`: one `listRunsForSession` item (the V4 summary shape).
fn session_item(row: &RunListRow, live: bool) -> Value {
    let run = &row.run;
    let (label, _) = run_label(&run.run_id, run.name.as_deref(), run.script_text.as_deref());
    let status = synthesized(live, run.status);
    let reason = stop_reason_of(live, run);
    let mut item = Map::new();
    item.insert("runId".into(), json!(run.run_id));
    if let Some(tool_call) = &run.tool_call_id {
        item.insert("toolCallId".into(), json!(tool_call));
    }
    item.insert("label".into(), json!(label));
    item.insert("updatedAt".into(), json!(row.time_updated));
    item.insert("status".into(), json!(status_name(status)));
    if let Some(reason) = reason {
        item.insert("stopReason".into(), json!(stop_reason_name(reason)));
    }
    put_lineage(&mut item, run);
    if !live && let Some(failure) = &run.failure {
        if let Some(code) = failure.get("code").and_then(Value::as_str) {
            item.insert("failureCode".into(), json!(code));
        }
        if let Some(message) = failure.get("message").and_then(Value::as_str) {
            item.insert("failureMessage".into(), json!(message));
        }
    }
    item.insert("resumable".into(), json!(resumable(status, reason)));
    Value::Object(item)
}

fn to_run_status(status: LifecycleStatus) -> RunStatus {
    match status {
        LifecycleStatus::Pending => RunStatus::Pending,
        LifecycleStatus::Running => RunStatus::Running,
        LifecycleStatus::Completed => RunStatus::Completed,
        LifecycleStatus::Errored => RunStatus::Errored,
        LifecycleStatus::Stopped => RunStatus::Stopped,
    }
}

fn store_error(error: anyhow::Error) -> DynamicWorkflowRunError {
    DynamicWorkflowRunError::new(format!("{error:#}"))
}

/// One session's view of the run service: the port the protocol answers the session's run reads through. Its reads
/// run on the blocking pool, since the journal is a synchronous SQLite connection.
pub(crate) struct SessionRuns {
    service: WorkflowRunService,
    parent: String,
}

async fn on_blocking_pool<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, DynamicWorkflowRunError> + Send + 'static,
) -> Result<T, DynamicWorkflowRunError> {
    tokio::task::spawn_blocking(work).await.map_err(|error| {
        DynamicWorkflowRunError::new(format!("the run read did not finish: {error}"))
    })?
}

#[async_trait]
impl DynamicWorkflowRunPort for SessionRuns {
    async fn list_runs(&self, query: ListQuery) -> Result<Value, DynamicWorkflowRunError> {
        let service = self.service.clone();
        let parent = self.parent.clone();
        on_blocking_pool(move || service.list_runs_of(&parent, query)).await
    }

    async fn list_runs_for_session(&self, limit: usize) -> Result<Value, DynamicWorkflowRunError> {
        let service = self.service.clone();
        let parent = self.parent.clone();
        on_blocking_pool(move || service.session_runs_of(&parent, limit)).await
    }

    /// Node `resolveQuestion` (9.40): the answer goes to the live run that parks the question, and it is refused as
    /// `unknown_question` when no live run of this session holds it. Node's `already_resolved` and `run_not_in_flight`
    /// need a retired-question table this port does not keep (divergence 391).
    async fn resolve_question(
        &self,
        qid: &QuestionId,
        answer: &str,
    ) -> Result<ResolveQuestionResult, DynamicWorkflowRunError> {
        let service = self.service.clone();
        let parent = self.parent.clone();
        let qid = qid.clone();
        let answer = answer.to_owned();
        on_blocking_pool(move || service.resolve_question_of(&parent, &qid, &answer)).await
    }

    /// Node `resume` (9.37): the refusals are answers, and the run is resumed on this service.
    async fn resume(&self, run_id: &WorkflowRunId) -> Result<Value, DynamicWorkflowRunError> {
        self.service.resume_port(run_id.as_str()).await
    }

    /// Node `defaultConcurrency` (9.39): the service's default, whole runs (the port's type is a count).
    fn default_concurrency(&self) -> Option<usize> {
        self.service
            .default_concurrency_value()
            .map(|value| value as usize)
    }

    /// Node `submit` (9.39): a new run under this session, the parent Node names (`parentSessionId`).
    async fn submit(
        &self,
        request: SubmitRequest,
    ) -> Result<WorkflowRunId, DynamicWorkflowRunError> {
        self.service.submit_run(&self.parent, request).await
    }
}

impl DynamicWorkflowRunSessions for WorkflowRunService {
    fn for_session(&self, session: &SessionId) -> Arc<dyn DynamicWorkflowRunPort> {
        Arc::new(SessionRuns {
            service: self.clone(),
            parent: session.as_str().to_owned(),
        })
    }
}

impl WorkflowRunService {
    /// The live runs of one parent session. Taken under the lock; the lock is released before any journal read.
    pub(crate) fn live_runs_of(&self, parent: &str) -> Vec<LiveRun> {
        let state = self.inner.state.lock_unpoisoned();
        state
            .runs
            .iter()
            .filter(|(_, entry)| entry.parent == parent)
            .map(|(run_id, entry)| LiveRun {
                run_id: run_id.clone(),
                token: entry.token,
                meta: entry.meta.clone(),
                handle: entry.handle.clone(),
            })
            .collect()
    }

    /// Node `listRuns`, for one parent session's owner view.
    pub(crate) fn list_runs_of(
        &self,
        parent: &str,
        query: ListQuery,
    ) -> Result<Value, DynamicWorkflowRunError> {
        let Some(store) = self.inner.store.get() else {
            return Err(DynamicWorkflowRunError::unsupported("listRuns"));
        };
        let live = self.live_runs_of(parent);
        let statuses: Option<Vec<RunStatus>> = query
            .statuses
            .as_ref()
            .map(|statuses| statuses.iter().copied().map(to_run_status).collect());
        // One extra row only detects truncation; it is not returned.
        let rows = store
            .list_runs(&RunListQuery {
                cwd: Some(query.cwd.clone()),
                limit: query.limit.saturating_add(1),
                statuses: statuses.clone(),
            })
            .map_err(store_error)?;
        let listed: HashSet<&str> = rows.iter().map(|row| row.run.run_id.as_str()).collect();
        let live_ids: HashSet<&str> = live.iter().map(|run| run.run_id.as_str()).collect();
        // Gap items: this session's live runs with no row. Ties on the start time keep the launch order (Node's
        // stable sort over its submit-ordered registry).
        let mut gap: Vec<(i64, u64, Value)> = Vec::new();
        for run in &live {
            if listed.contains(run.run_id.as_str())
                || run.meta.cwd.as_deref() != Some(query.cwd.as_str())
            {
                continue;
            }
            if statuses
                .as_ref()
                .is_some_and(|set| !set.contains(&RunStatus::Pending))
            {
                continue;
            }
            // A row the query did not select stays out: the complement must not undo an explicit filter.
            if store.get_run(&run.run_id).map_err(store_error)?.is_some() {
                continue;
            }
            gap.push((
                run.meta.started_at_ms,
                run.token,
                gap_item(&run.run_id, &run.meta),
            ));
        }
        gap.sort_by_key(|(started_at, token, _)| (std::cmp::Reverse(*started_at), *token));
        let mut runs: Vec<Value> = gap.into_iter().map(|(_, _, item)| item).collect();
        runs.extend(
            rows.iter()
                .map(|row| list_item(row, live_ids.contains(row.run.run_id.as_str()), parent)),
        );
        let truncated = runs.len() > query.limit;
        runs.truncate(query.limit);
        let mut page = json!({ "runs": runs });
        if truncated {
            page["truncated"] = json!(true);
        }
        Ok(page)
    }

    /// Node `resolveQuestion` for one parent session (9.40). The live runs are asked in launch order; the first that holds
    /// the question answers it. The owner's answer is a mailbox call, so this runs on the blocking pool.
    pub(crate) fn resolve_question_of(
        &self,
        parent: &str,
        qid: &QuestionId,
        answer: &str,
    ) -> Result<ResolveQuestionResult, DynamicWorkflowRunError> {
        let mut live = self.live_runs_of(parent);
        live.sort_by_key(|run| run.token);
        let outcomes = live
            .iter()
            .map(|run| run.handle.answer(qid.as_str(), answer));
        match first_answer(outcomes) {
            Ok(Some(_)) => Ok(ResolveQuestionResult::Resolved { qid: qid.clone() }),
            Ok(None) => Ok(ResolveQuestionResult::Refused {
                reason: ResolveQuestionRefusalReason::UnknownQuestion,
                message: unknown_question_message(qid.as_str()),
            }),
            Err(error) => Err(DynamicWorkflowRunError::new(format!(
                "the answer to question {qid} did not reach its run: {error}"
            ))),
        }
    }

    /// Node `listRunsForSession`: the session's newest rows, each summarized with the session's live precedence.
    /// A failed read logs and answers an empty list, as Node does.
    pub(crate) fn session_runs_of(
        &self,
        parent: &str,
        limit: usize,
    ) -> Result<Value, DynamicWorkflowRunError> {
        let Some(store) = self.inner.store.get() else {
            return Ok(json!({ "runs": [] }));
        };
        let capped = limit.clamp(1, MAX_LIST_RUNS_LIMIT);
        let rows = match store.runs_of_session(parent, capped) {
            Ok(rows) => rows,
            Err(error) => {
                tracing::warn!(
                    event = "workflow.run.list_failed",
                    session = %parent,
                    error = %format!("{error:#}"),
                    "the session's workflow runs could not be listed"
                );
                return Ok(json!({ "runs": [] }));
            }
        };
        let live: HashSet<String> = self
            .live_runs_of(parent)
            .into_iter()
            .map(|run| run.run_id)
            .collect();
        let runs: Vec<Value> = rows
            .iter()
            .map(|row| session_item(row, live.contains(&row.run.run_id)))
            .collect();
        Ok(json!({ "runs": runs }))
    }
}
