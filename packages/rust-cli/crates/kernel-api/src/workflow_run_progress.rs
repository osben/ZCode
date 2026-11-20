//! Fork: the run progress port (specs/fork-rust-workflow-engine.md, 9.31, W7-5b; 9.34, W7-5e). Node's
//! `recordDynamicWorkflowRunProgress` fans a run's progress out to its parent session. The run service calls the port once
//! per journal event, on the run's owner thread, with the projection's deltas. The Host's implementation delivers the
//! deltas live to the parent session's open stream and persists nothing: the run's journal is the record. A missing
//! implementation means no progress is delivered.

/// Delivers one run's progress to its parent session.
pub trait WorkflowRunProgressPort: Send + Sync {
    /// Hands the projection `deltas` of one journal event to `parent_session_id`'s open stream. `progress` is the Node
    /// `DynamicWorkflowRunProgressPayload` shape of the same event; the delivery does not persist it. An error is logged
    /// by the caller and never fails the run.
    fn record(
        &self,
        parent_session_id: &str,
        progress: &serde_json::Value,
        deltas: &[serde_json::Value],
    ) -> Result<(), String>;
}
