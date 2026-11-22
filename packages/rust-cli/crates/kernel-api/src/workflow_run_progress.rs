//! Fork: the run progress port (specs/fork-rust-workflow-engine.md, 9.31, W7-5b; 9.34, W7-5e). Node's
//! `recordDynamicWorkflowRunProgress` fans a run's progress out to its parent session. The run service calls the port once
//! per journal event, on the run's owner thread, with the projection's deltas. The Host's implementation delivers the
//! deltas live to the parent session's open stream and persists nothing: the run's journal is the record. A missing
//! implementation means no progress is delivered.

/// Delivers one run's progress to its parent session.
/// Fork (9.61): the key the run's progress sink adds to `progress` for a named run, so the host's notices call the run by
/// its name (Node's registry description). Not part of Node's payload; the delivery never sends `progress` on.
pub const RUN_NAME_KEY: &str = "runName";

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

    /// Fork (W9h, 9.64): an event journaled before this sink was attached (a resumed run's earlier lifetimes, the
    /// `run-started` of this one). Its deltas rebuild the projection; it was already told to the model when it happened,
    /// so a host posts no model notice for it (Node's progress port only sees live events). The default is `record`.
    fn record_backlog(
        &self,
        parent_session_id: &str,
        progress: &serde_json::Value,
        deltas: &[serde_json::Value],
    ) -> Result<(), String> {
        self.record(parent_session_id, progress, deltas)
    }
}
