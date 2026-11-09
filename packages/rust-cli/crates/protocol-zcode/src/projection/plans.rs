//! Fork: the `v4/conversation/plans` catalog, like Node's `ConversationTopicPublisher.getPlans` (bootstrap
//! `zcode-protocol-v4/conversation-topic-publisher.ts`; specs/fork-rust-agent-parity.md): the settled ExitPlanMode
//! tool rows with a non-blank plan on the whole branch (not only the snapshot window), newest first.

use serde_json::Value;

use super::Projection;

const SETTLED: [&str; 3] = ["success", "error", "cancelled"];

/// Node's `hasPlanMarkdown`: `input.plan`, else `plan` in the input text, is non-blank.
fn has_plan(row: &serde_json::Map<String, Value>) -> bool {
    let blank = |plan: &Value| plan.as_str().is_none_or(|plan| plan.trim().is_empty());
    if let Some(plan) = row.get("input").and_then(|input| input.get("plan")) {
        return !blank(plan);
    }
    row.get("inputText")
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .is_some_and(|input| !blank(&input["plan"]))
}

impl Projection {
    pub fn plans(&self) -> Vec<Value> {
        let mut plans: Vec<Value> = self
            .rows
            .iter()
            .filter(|row| {
                row.get("kind").and_then(Value::as_str) == Some("toolCall")
                    && row.get("toolName").and_then(Value::as_str) == Some("ExitPlanMode")
                    && row
                        .get("status")
                        .and_then(Value::as_str)
                        .is_some_and(|status| SETTLED.contains(&status))
                    && has_plan(row)
            })
            .map(|row| Value::Object(row.clone()))
            .collect();
        plans.sort_by_key(|row| std::cmp::Reverse(row["rowId"].as_u64().unwrap_or_default()));
        plans
    }
}

#[cfg(test)]
#[path = "plans_tests.rs"]
mod tests;
