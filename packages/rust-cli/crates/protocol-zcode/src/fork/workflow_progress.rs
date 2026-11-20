//! Fork: the run progress port's live half (specs/fork-rust-workflow-engine.md, 9.34, W7-5e). Node's sink appends each
//! run's progress to the parent session's in-memory event store and the Host hears it. Here the progress is not written
//! anywhere: the durable record is the run's journal, and cold reads replay it (`v4-bridge` `replayDynamicWorkflowRunEvents`).
//! The port hands the projection's deltas to the parent session's open stream, if one is open.

use std::sync::Arc;

use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use serde_json::Value;

/// Where a run's live deltas go: the parent session's open stream.
pub trait ProgressDelivery: Send + Sync {
    fn deliver(&self, parent_session_id: &str, deltas: Vec<Value>);
}

/// The run progress port. Its delivery is the only effect: nothing is persisted.
pub struct WorkflowProgressHost {
    delivery: Arc<dyn ProgressDelivery>,
}

impl WorkflowProgressHost {
    pub fn new(delivery: Arc<dyn ProgressDelivery>) -> Self {
        Self { delivery }
    }
}

impl WorkflowRunProgressPort for WorkflowProgressHost {
    fn record(
        &self,
        parent_session_id: &str,
        progress: &Value,
        deltas: &[Value],
    ) -> Result<(), String> {
        let _ = progress;
        if !deltas.is_empty() {
            self.delivery.deliver(parent_session_id, deltas.to_vec());
        }
        Ok(())
    }
}

/// The production delivery: the parent session's open stream gets the deltas in its pump, as the helper's plugin UI
/// deltas do. A session with no open stream has nobody to show them to, so they are dropped.
pub struct BridgeDelivery {
    context: Arc<crate::context::Context>,
}

impl BridgeDelivery {
    pub fn new(context: Arc<crate::context::Context>) -> Self {
        Self { context }
    }
}

impl ProgressDelivery for BridgeDelivery {
    fn deliver(&self, parent_session_id: &str, deltas: Vec<Value>) {
        let Some(bridge) = self.context.live_bridge() else {
            return;
        };
        let Some(live) = bridge.get(&rust_cli_kernel_api::ids::SessionId::new(parent_session_id))
        else {
            return;
        };
        let sink = live.sink.clone();
        live.run(Box::pin(async move {
            sink.workflow_runs_changed(deltas).await;
        }));
    }
}

#[cfg(test)]
#[path = "workflow_progress_tests.rs"]
mod tests;
