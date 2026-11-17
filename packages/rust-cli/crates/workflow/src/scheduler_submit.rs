//! Boundary B reports for a live ask (Node `engine/scheduler-submit.ts`): a `submit_result` and a turn
//! that ended without one. Each either settles the ask, or spends a repair or a nudge in the same turn,
//! or fails the ask when its budget is gone.
use crate::engine::{SubmitVerdict, WorkflowDriver, WorkflowEngine};
use crate::error::{ErrorCode, WorkflowError};
use crate::event::RunEvent;
use crate::journal::JournalPort;
use crate::model::{Ref, Violation};
use crate::scheduler::REPAIR_ATTEMPTS;
use anyhow::Result;
use serde_json::Value;

impl<J: JournalPort, D: WorkflowDriver> WorkflowEngine<J, D> {
    /// Node `normalizeSubmit`. The value is checked as given first. A string that fails is parsed once as
    /// JSON and checked again; the parsed value is then the value, whether or not it passes (its
    /// violations describe the object the model can edit). Anything else keeps the original violations.
    fn normalize_submit(&self, schema: &Value, payload: Value) -> (Value, Vec<Violation>) {
        let direct = self.validate_value(schema, &payload);
        if direct.is_empty() {
            return (payload, Vec::new());
        }
        if let Value::String(text) = &payload
            && let Ok(parsed) = serde_json::from_str::<Value>(text)
        {
            let after = self.validate_value(schema, &parsed);
            return (parsed, after);
        }
        (payload, direct)
    }

    /// Node `handleSubmitAttempted`: accept, repair in place, or fail once the repair budget is spent.
    pub(crate) fn handle_submit_attempted(&mut self, instance: &Ref, payload: Value) -> Result<()> {
        let Some(node_id) = self.live_node_id(instance) else {
            return Ok(());
        };
        let Some(node) = self.live.get(&node_id) else {
            return Ok(());
        };
        if !node.spec.typed {
            return Ok(());
        }
        let schema = node.spec.schema.clone().unwrap_or(Value::Null);
        let (value, violations) = self.normalize_submit(&schema, payload);
        if violations.is_empty() {
            self.driver
                .respond_to_submit(instance, &SubmitVerdict::Accept);
            return self.settle_ok(node_id, value);
        }
        let Some(node) = self.live.get_mut(&node_id) else {
            return Ok(());
        };
        if node.repairs_remaining > 0 {
            node.repairs_remaining -= 1;
            let attempt = REPAIR_ATTEMPTS - node.repairs_remaining;
            self.driver.respond_to_submit(
                instance,
                &SubmitVerdict::Reject {
                    violations: violations.clone(),
                },
            );
            return self.record(RunEvent::NodeRepairing {
                instance: instance.clone(),
                attempt: u64::from(attempt),
                violations,
            });
        }
        self.driver.cancel_ask(instance);
        self.settle_failed(
            node_id,
            WorkflowError::new(
                ErrorCode::ValidationFailed,
                "submit_result failed schema validation repeatedly and the repair budget is exhausted.",
            )
            .with_violations(&violations),
        )
    }

    /// Node `handleTurnEnded`: an untyped ask settles on its final text; a typed one is nudged once, then
    /// fails with `ResultNotSubmitted`.
    pub(crate) fn handle_turn_ended(&mut self, instance: &Ref, final_text: &str) -> Result<()> {
        let Some(node_id) = self.live_node_id(instance) else {
            return Ok(());
        };
        let Some(node) = self.live.get_mut(&node_id) else {
            return Ok(());
        };
        if !node.spec.typed {
            return self.settle_ok(node_id, Value::String(final_text.to_owned()));
        }
        if node.nudges_remaining > 0 {
            node.nudges_remaining -= 1;
            self.driver
                .respond_to_submit(instance, &SubmitVerdict::Nudge);
            return self.record(RunEvent::NodeNudged {
                instance: instance.clone(),
            });
        }
        self.driver.cancel_ask(instance);
        self.settle_failed(
            node_id,
            WorkflowError::new(
                ErrorCode::ResultNotSubmitted,
                "The typed ask ended without a submit_result call, so there is no result.",
            )
            .with_final_text(final_text),
        )
    }
}
