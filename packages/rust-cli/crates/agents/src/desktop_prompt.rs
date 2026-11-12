//! Fork (node_desktop): the Agent tool tells the model what the desktop agent does. Node runs an
//! Agent call in the foreground unless it passes `run_in_background: true`, so the zcode-rs
//! "background by default" guidance is replaced by Node's text (core `tool/handlers/agent.ts`,
//! contracts `tools/agent.ts`; specs/fork-rust-agent-parity.md).

use serde_json::{Value, json};

/// The zcode-rs description line about the default (prompts/tools/Agent.json).
const BACKGROUND_DEFAULT_LINE: &str = "- Subagents run in the background by default;";

/// Node's description line (core `tool/handlers/agent.ts`).
const NODE_BACKGROUND_LINE: &str = "- `run_in_background: true` runs the agent asynchronously; you'll be notified when it completes. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running.";

/// Node's `run_in_background` parameter description (contracts `tools/agent.ts`).
const NODE_PARAMETER: &str =
    "Set to true to run this agent in the background. You will be notified when it completes.";

/// The description with Node's background line in place of the zcode-rs one.
pub(crate) fn description(description: &str) -> String {
    description
        .split('\n')
        .map(|line| {
            if line.starts_with(BACKGROUND_DEFAULT_LINE) {
                NODE_BACKGROUND_LINE
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The input schema with Node's `run_in_background` description.
pub(crate) fn input_schema(schema: &Value) -> Value {
    let mut schema = schema.clone();
    if let Some(parameter) = schema
        .pointer_mut("/properties/run_in_background")
        .and_then(Value::as_object_mut)
    {
        parameter.insert("description".into(), json!(NODE_PARAMETER));
    }
    schema
}

#[cfg(test)]
#[path = "desktop_prompt_tests.rs"]
mod tests;
