//! Fork: the run service's host reads over the dwf journal (specs/fork-rust-workflow-engine.md, 9.29, W7-5a-4).
//!
//! `list_runs` is Node's `listRuns` (the `ListWorkflowRuns` surface, `{runs, truncated?}`): journal rows by project
//! and status, with the runs this process holds but the journal has no row for yet. `session_runs` is Node's
//! `listRunsForSession` (the `v4/conversation/workflowRuns` read, `{runs}`). Both read the journal first and consult
//! the live map only for the runs it holds, as Node's `dynamic-workflow-run-observation.ts` does. The summary rules
//! are Node's: `label` from `name`, then the first script line, then the run id; `resumable` is stopped and not
//! superseded.
//!
//! Node's in-memory roster keeps 32 settled entries (divergence 128); a settled run is read from its row only.

use std::collections::HashMap;

use async_trait::async_trait;
use rust_cli_base::js::string::{trim, utf16_len, utf16_prefix};
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::workflow_child::LaunchInput;
use rust_cli_kernel_api::workflow_run::{
    DynamicWorkflowRunError, DynamicWorkflowRunPort, DynamicWorkflowRunSessions, LifecycleStatus,
    ListQuery,
};
use rust_cli_workflow::engine::EngineConfig;
use rust_cli_workflow::model::{RunStatus, StopReason};
use rust_cli_workflow::run_store::{RunListQuery, RunListRow};
use serde_json::{Map, Value, json};

use super::WorkflowRunService;

/// Node `MAX_LIST_RUNS_LIMIT`: the session list clamps to it (the default, 16, is the protocol's).
pub const MAX_LIST_RUNS_LIMIT: usize = 64;

/// Node `DYNAMIC_WORKFLOW_RUN_LABEL_MAX_CHARS`, counted in UTF-16 units as JS counts it.
const LABEL_MAX_UNITS: usize = 80;

/// What a live run's map entry keeps for the reads that synthesize a run that has no row yet (Node's registry
/// entry fields used by `registryRunSummary` and the gap items).
#[derive(Debug, Clone)]
pub(crate) struct RunMeta {
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub script_text: String,
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
        Self {
            cwd: config.cwd.clone(),
            name: config.name.clone(),
            script_text: input.script_text.clone(),
            resumed_from: input
                .resumed_from
                .clone()
                .or_else(|| config.resumed_from.clone()),
            inherited_tokens: config.inherited_tokens.unwrap_or(0.0),
            started_at_ms,
        }
    }
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

/// Node `isResumableSettlement` inputs: the lifecycle names the wire uses.
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
fn stop_reason_of(live: bool, run: &rust_cli_workflow::model::RunRow) -> Option<StopReason> {
    if live {
        return None;
    }
    (run.status == RunStatus::Stopped).then(|| run.stop_reason.unwrap_or(StopReason::User))
}

/// Node `supersededByOf` for a run with no terminal entry: only a stopped row carries a successor.
fn superseded_by_of(live: bool, run: &rust_cli_workflow::model::RunRow) -> Option<&str> {
    if live || run.status != RunStatus::Stopped {
        return None;
    }
    run.superseded_by.as_deref()
}

/// Node `isResumableSettlement`: stopped, and not superseded (its successor is the one that runs).
fn resumable(status: RunStatus, reason: Option<StopReason>) -> bool {
    status == RunStatus::Stopped && reason != Some(StopReason::Superseded)
}

fn put_lineage(item: &mut Map<String, Value>, run: &rust_cli_workflow::model::RunRow, live: bool) {
    if let Some(from) = &run.resumed_from {
        item.insert("resumedFrom".into(), json!(from));
    }
    if let Some(by) = superseded_by_of(live, run) {
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
    put_lineage(&mut item, run, live);
    item.insert("ownedByThisSession".into(), json!(owned));
    if !is_terminal(run.status) && !owned {
        item.insert("possiblyInterrupted".into(), json!(true));
    }
    item.insert("createdAt".into(), json!(row.time_created));
    item.insert("updatedAt".into(), json!(row.time_updated));
    item.insert("spentTokens".into(), json!(run.spent_tokens as i64));
    Value::Object(item)
}

/// Node `registryRunSummary` plus `spentTokens`: a run this process holds with no row yet.
fn gap_item(run_id: &str, meta: &RunMeta) -> Value {
    let (label, source) = run_label(run_id, meta.name.as_deref(), Some(&meta.script_text));
    let mut item = Map::new();
    item.insert("runId".into(), json!(run_id));
    item.insert("label".into(), json!(label));
    item.insert("labelSource".into(), json!(source));
    item.insert("status".into(), json!(status_name(RunStatus::Pending)));
    if let Some(from) = &meta.resumed_from {
        item.insert("resumedFrom".into(), json!(from));
    }
    item.insert("ownedByThisSession".into(), json!(true));
    item.insert("createdAt".into(), json!(meta.started_at_ms));
    item.insert("updatedAt".into(), json!(meta.started_at_ms));
    item.insert("spentTokens".into(), json!(meta.inherited_tokens as i64));
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
    put_lineage(&mut item, run, live);
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

/// One session's view of the run service: the port the protocol answers the session's run reads through.
pub(crate) struct SessionRuns {
    service: WorkflowRunService,
    parent: String,
}

#[async_trait]
impl DynamicWorkflowRunPort for SessionRuns {
    async fn list_runs(&self, query: ListQuery) -> Result<Value, DynamicWorkflowRunError> {
        self.service.list_runs_of(&self.parent, query)
    }

    async fn list_runs_for_session(&self, limit: usize) -> Result<Value, DynamicWorkflowRunError> {
        self.service.session_runs_of(&self.parent, limit)
    }
}

impl DynamicWorkflowRunSessions for WorkflowRunService {
    fn for_session(&self, session: &SessionId) -> std::sync::Arc<dyn DynamicWorkflowRunPort> {
        std::sync::Arc::new(SessionRuns {
            service: self.clone(),
            parent: session.as_str().to_owned(),
        })
    }
}

impl WorkflowRunService {
    /// The runs this process holds, with what their map entries keep. Taken under the lock and released before any
    /// journal read.
    pub(crate) fn live_runs(&self) -> HashMap<String, RunMeta> {
        let state = self.inner.state.lock_unpoisoned();
        state
            .runs
            .iter()
            .map(|(run_id, entry)| (run_id.clone(), entry.meta.clone()))
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
        let live = self.live_runs();
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
        let listed: std::collections::HashSet<&str> =
            rows.iter().map(|row| row.run.run_id.as_str()).collect();
        let mut merged: Vec<(i64, Value)> = Vec::new();
        for (run_id, meta) in &live {
            if listed.contains(run_id.as_str()) || meta.cwd.as_deref() != Some(query.cwd.as_str()) {
                continue;
            }
            if statuses
                .as_ref()
                .is_some_and(|set| !set.contains(&RunStatus::Pending))
            {
                continue;
            }
            // A row the query did not select stays out: the complement must not undo an explicit filter.
            if store.get_run(run_id).map_err(store_error)?.is_some() {
                continue;
            }
            merged.push((meta.started_at_ms, gap_item(run_id, meta)));
        }
        merged.sort_by_key(|(started_at, _)| std::cmp::Reverse(*started_at));
        let mut runs: Vec<Value> = merged.into_iter().map(|(_, item)| item).collect();
        runs.extend(
            rows.iter()
                .map(|row| list_item(row, live.contains_key(&row.run.run_id), parent)),
        );
        let truncated = runs.len() > query.limit;
        runs.truncate(query.limit);
        let mut page = json!({ "runs": runs });
        if truncated {
            page["truncated"] = json!(true);
        }
        Ok(page)
    }

    /// Node `listRunsForSession`: the session's newest rows, each summarized with the live map's precedence.
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
        let live = self.live_runs();
        let runs: Vec<Value> = rows
            .iter()
            .map(|row| session_item(row, live.contains_key(&row.run.run_id)))
            .collect();
        Ok(json!({ "runs": runs }))
    }
}
