//! Fork: the run progress port (specs/fork-rust-workflow-engine.md, 9.31, W7-5b). Node's `recordDynamicWorkflowRunProgress`
//! and the `dynamic_workflow_run_progress` fan-out: the run's progress goes to the parent session, and the projection's
//! deltas go to the Host. The run service calls it once per journal event, on the run's owner thread. Implementations
//! are the Host's (the notification and the session event); a missing implementation means no progress is recorded.

/// Records one run's progress event for its parent session.
pub trait WorkflowRunProgressPort: Send + Sync {
    /// Appends `progress` (the Node `DynamicWorkflowRunProgressPayload` shape) to `parent_session_id` and publishes the
    /// projection `deltas` it produced. An error is logged by the caller and never fails the run.
    fn record(
        &self,
        parent_session_id: &str,
        progress: &serde_json::Value,
        deltas: &[serde_json::Value],
    ) -> Result<(), String>;
}
