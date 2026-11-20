//! Run progress fan-out (specs/fork-rust-workflow-engine.md, 9.31, W7-5b). Node's `dynamic-workflow-run-progress-sink.ts`
//! (the identity gate and the degradation paths) over `toProgressPayload` (`dynamic-workflow-run-progress-payload.ts`).
//!
//! The owner calls [`RunProgress::progress`] on the run's owner thread, right after each journal append, so events
//! reach the sink in journal order with no spawn. The envelope comes from the same builder cold replay uses
//! (`rust_cli_node_store::progress_envelope`), and the session's projection (`LiveProjection`) is updated under its
//! lock, so the deltas are in the order the events were journaled. Nothing here fails the run: a sink error is logged.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, PoisonError};

use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use rust_cli_node_store::{
    LiveProjection, RunProgressFields, WORKFLOW_RUN_LIMITS, WorkflowRunEnvelope, progress_envelope,
};
use serde_json::{Map, Value, json};

use crate::model::StoredEvent;

/// What the owner calls for each journal event of a run (the live half of Node's `onRunEvent`).
pub trait RunProgress: Send {
    fn progress(&mut self, stored: &StoredEvent);
}

/// One session's `workflowRuns` projection, shared by the session's runs (the run service keeps one per parent).
pub type SharedProjection = Arc<Mutex<LiveProjection>>;

/// A fresh, empty session projection, at the production limits.
pub fn shared_projection() -> SharedProjection {
    Arc::new(Mutex::new(LiveProjection::new(WORKFLOW_RUN_LIMITS)))
}

/// What the run service knows at launch, for one run's sink. Plain values, so the service does not name the
/// node-store types the progress path is built on.
pub struct LaunchProgress {
    pub owned_session: String,
    pub parent_session_id: Option<String>,
    pub run_id: String,
    pub tool_call_id: Option<String>,
    pub resumed_from: Option<String>,
    /// The run's subagent model (`run-launched` `subagentModel`).
    pub subagent_model: Option<String>,
    /// The run's model bindings (`run-launched` `modelBindings`), as the host gave them.
    pub model_bindings: Option<Map<String, Value>>,
    pub default_concurrency: f64,
    pub projection: SharedProjection,
    pub port: Arc<dyn WorkflowRunProgressPort>,
}

impl LaunchProgress {
    pub fn into_sink(self) -> Box<dyn RunProgress> {
        let fields = RunProgressFields {
            run_id: self.run_id,
            tool_call_id: self.tool_call_id,
            resumed_from: self.resumed_from,
            subagent_model: self.subagent_model.map(Value::String),
            model_bindings: self.model_bindings,
            default_concurrency: self.default_concurrency,
        };
        Box::new(ProgressSink::new(
            self.owned_session,
            self.parent_session_id,
            fields,
            self.projection,
            self.port,
        ))
    }
}

/// The progress sink of one run. Built by the run service at launch; one projection is shared by the runs of a session.
pub struct ProgressSink {
    /// The session this app owns (Node `deps.sessionId`): the only parent whose progress it records.
    owned_session: String,
    /// The run's parent session, when the run names one (Node `routing.parentSessionId`). Absence is valid.
    parent_session_id: Option<String>,
    fields: RunProgressFields,
    projection: Arc<Mutex<LiveProjection>>,
    port: Arc<dyn WorkflowRunProgressPort>,
}

impl ProgressSink {
    pub fn new(
        owned_session: String,
        parent_session_id: Option<String>,
        fields: RunProgressFields,
        projection: Arc<Mutex<LiveProjection>>,
        port: Arc<dyn WorkflowRunProgressPort>,
    ) -> Self {
        Self {
            owned_session,
            parent_session_id,
            fields,
            projection,
            port,
        }
    }

    /// The parent session the progress is recorded for: the run's own, or this app's when the run names none.
    fn recording_session(&self) -> &str {
        self.parent_session_id
            .as_deref()
            .unwrap_or(&self.owned_session)
    }

    /// Applies the envelope to the projection, then hands the progress and its deltas to the port.
    fn append(&self, stored: &StoredEvent) -> Result<(), String> {
        let envelope = envelope_of(&self.fields, stored)?;
        let deltas = {
            let mut projection = self
                .projection
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            projection.apply(&envelope).unwrap_or_default()
        };
        let progress = progress_payload(&envelope, stored.sequence);
        self.port
            .record(self.recording_session(), &progress, &deltas)
    }
}

impl RunProgress for ProgressSink {
    fn progress(&mut self, stored: &StoredEvent) {
        // The identity gate: an explicit parent that is not this app's session is never appended (Node's
        // `session_mismatch`). An absent parent is this session by construction.
        if let Some(parent) = self.parent_session_id.as_deref()
            && parent != self.owned_session
        {
            tracing::warn!(
                event = "dynamic_workflow.run_progress.session_mismatch",
                run_id = %self.fields.run_id,
                parent_session_id = %parent,
                "Dynamic workflow run progress dropped: parent session is not this app"
            );
            return;
        }
        // A sink error never fails the run (Node: every degradation path is a logged no-op). A panic inside the port is
        // caught for the same reason: the journal is the record, and the run goes on.
        match catch_unwind(AssertUnwindSafe(|| self.append(stored))) {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(
                event = "dynamic_workflow.run_progress.append_failed",
                run_id = %self.fields.run_id,
                reason = "append_rejected",
                error = %error,
                "Dynamic workflow run progress append failed"
            ),
            Err(_) => tracing::warn!(
                event = "dynamic_workflow.run_progress.append_failed",
                run_id = %self.fields.run_id,
                reason = "runtime_unavailable",
                "Dynamic workflow run progress append failed"
            ),
        }
    }
}

/// The Node `DynamicWorkflowRunProgressPayload` for one envelope: `runId`, `toolCallId`, `sequence`, `eventType`,
/// `payload`, and `actorSessionId` when the envelope names a sub-agent.
pub fn progress_payload(envelope: &WorkflowRunEnvelope, sequence: u64) -> Value {
    let mut out = Map::new();
    out.insert("runId".into(), json!(envelope.run_id));
    if let Some(tool_call_id) = &envelope.tool_call_id {
        out.insert("toolCallId".into(), json!(tool_call_id));
    }
    out.insert("sequence".into(), json!(sequence));
    out.insert("eventType".into(), json!(envelope.event_type));
    out.insert(
        "payload".into(),
        Value::Object(envelope.payload.clone().unwrap_or_default()),
    );
    if let Some(actor_session_id) = &envelope.actor_session_id {
        out.insert("actorSessionId".into(), json!(actor_session_id));
    }
    Value::Object(out)
}

/// Builds the envelope of one stored event for a run: the live call of the builder cold replay also uses.
pub fn envelope_of(
    fields: &RunProgressFields,
    stored: &StoredEvent,
) -> Result<WorkflowRunEnvelope, String> {
    let event: Value =
        serde_json::from_str(&stored.payload_json).map_err(|error| error.to_string())?;
    Ok(progress_envelope(
        fields,
        stored.sequence as f64,
        &event,
        None,
    ))
}

#[cfg(test)]
#[path = "run_progress_tests.rs"]
mod tests;
