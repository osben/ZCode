//! Fork: the run progress port's live half (specs/fork-rust-workflow-engine.md, 9.34, W7-5e). Node's sink appends each
//! run's progress to the parent session's in-memory event store and the Host hears it. Here the progress is not written
//! anywhere: the durable record is the run's journal. The port hands the projection's deltas to the parent session's
//! open stream, if one is open. Rust's cold read does not yet replay the journal into progress events (9.34, 298).

use std::sync::{Arc, Weak};

use rust_cli_kernel_api::workflow_run_progress::WorkflowRunProgressPort;
use serde_json::Value;

/// Where a run's live deltas go: the parent session's open stream.
pub trait ProgressDelivery: Send + Sync {
    fn deliver(&self, parent_session_id: &str, deltas: Vec<Value>);
}

/// The run progress port. Its only effect is the live delivery of the deltas; nothing is persisted, and the payload is
/// not written anywhere (it is the journal's row, which the run service keeps).
pub struct WorkflowProgressHost {
    delivery: Arc<dyn ProgressDelivery>,
}

impl WorkflowProgressHost {
    pub fn new(delivery: Arc<dyn ProgressDelivery>) -> Self {
        Self { delivery }
    }
}

impl WorkflowRunProgressPort for WorkflowProgressHost {
    /// Delivers the deltas to the parent's open stream. The progress payload is not used here: it is the Node-shaped
    /// event that the model-visible notifications of divergence 295 would read, and those are not built yet.
    fn record(
        &self,
        parent_session_id: &str,
        _progress: &Value,
        deltas: &[Value],
    ) -> Result<(), String> {
        if !deltas.is_empty() {
            self.delivery.deliver(parent_session_id, deltas.to_vec());
        }
        Ok(())
    }
}

/// The production delivery: the parent session's open stream gets the deltas in its pump, as the helper's plugin UI
/// deltas do. A session with no open stream has nobody to show them to, so they are dropped. The context is held weakly:
/// the run service reaches this delivery through the context, so a strong reference here would be a cycle.
pub struct BridgeDelivery {
    context: Weak<crate::context::Context>,
}

impl BridgeDelivery {
    pub fn new(context: Weak<crate::context::Context>) -> Self {
        Self { context }
    }
}

impl ProgressDelivery for BridgeDelivery {
    fn deliver(&self, parent_session_id: &str, deltas: Vec<Value>) {
        let Some(context) = self.context.upgrade() else {
            return;
        };
        let Some(bridge) = context.live_bridge() else {
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
