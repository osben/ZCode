//! Fork (specs/fork-rust-workflow-engine.md 9.66, divergence 141): the two run settings a workflow confirmation window
//! lets the user adjust, shared by CreateWorkflow and AmendWorkflow (Node `workflow-settings-adjustment.ts` and the
//! contract `workflow-settings.ts`).
//!
//! Three jobs, as in Node: the `adjustable_settings` block the ask carries (it tells the window the agent applies what
//! is changed there), the parse of the reply's `content` into the changes, and the sentence that tells the model what the
//! user changed before approving. The model-facing wording is Node's, byte for byte.

use serde_json::{Map, Value, json};

/// Node `WORKFLOW_SETTINGS_MAX_MODEL_CHARS`.
const MAX_MODEL_CHARS: usize = 512;

/// The three-state of one setting, Node's: omitted is `None` (unchanged), `Some(None)` is back to the default (the
/// session model, the default concurrency), `Some(Some(value))` sets it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Settings {
    pub(crate) subagent_model: Option<Option<String>>,
    pub(crate) max_concurrency: Option<Option<u64>>,
}

impl Settings {
    pub(crate) fn is_empty(&self) -> bool {
        self.subagent_model.is_none() && self.max_concurrency.is_none()
    }
}

/// Node `workflowAdjustableSettings`: the facts the window reads. `catalog` is whether the host can resolve a model picked
/// in the window; `default_concurrency` is the run port's default, which only writes the stepper's hint. A host with no run
/// port has no run for a change to affect, so the caller leaves the block out.
pub(crate) fn adjustable_settings(catalog: bool, default_concurrency: Option<usize>) -> Value {
    let mut block = Map::new();
    block.insert("subagent_model".to_owned(), Value::Bool(catalog));
    if let Some(default) = default_concurrency {
        block.insert("concurrency_ceiling".to_owned(), json!(default));
    }
    Value::Object(block)
}

/// `input` with the block, always overwriting a value the model filled in (Node `withWorkflowAdjustableSettings`).
pub(crate) fn with_block(input: Option<Value>, raw: &Value, block: Value) -> Value {
    let mut shown = input
        .and_then(|input| input.as_object().cloned())
        .or_else(|| raw.as_object().cloned())
        .unwrap_or_default();
    shown.insert("adjustable_settings".to_owned(), block);
    Value::Object(shown)
}

/// Node `parseWorkflowSettingsAdjustment`: the changes a reply's `content` carries. The reply comes from a client, so a
/// key the parse does not know is dropped, a key of the wrong shape voids the whole reply (the input then runs as it was
/// approved), and a reply with no known key is no adjustment.
pub(crate) fn parse(content: &Map<String, Value>) -> Option<Settings> {
    let mut settings = Settings::default();
    match content.get("subagent_model") {
        None => {}
        Some(Value::Null) => settings.subagent_model = Some(None),
        Some(Value::String(requested)) => {
            let requested = requested.trim();
            if requested.is_empty() || requested.encode_utf16().count() > MAX_MODEL_CHARS {
                return None;
            }
            settings.subagent_model = Some(Some(requested.to_owned()));
        }
        Some(_) => return None,
    }
    match content.get("max_concurrency") {
        None => {}
        Some(Value::Null) => settings.max_concurrency = Some(None),
        Some(Value::Number(number)) => {
            // zod `int().positive()`: a whole number above zero, `5.0` included.
            let whole = number
                .as_u64()
                .or_else(|| {
                    number
                        .as_f64()
                        .filter(|value| value.fract() == 0.0 && *value > 0.0)
                        .map(|value| value as u64)
                })
                .filter(|value| *value > 0)?;
            settings.max_concurrency = Some(Some(whole));
        }
        Some(_) => return None,
    }
    (!settings.is_empty()).then_some(settings)
}

/// Node `adjustedModelFailure`: a model chosen in the window cannot be resolved now (deleted, disabled, or no catalog).
pub(crate) fn model_failure(detail: &str) -> String {
    format!(
        "workflow_subagent_model_unresolved: the subagent model the user chose in the confirmation window cannot be used now. {detail} Nothing was started; ask the user which model to use."
    )
}

/// Node `ADJUSTED_MODEL_WITHOUT_CATALOG`: guards a client that bypasses the block's `subagent_model: false`.
pub(crate) const MODEL_WITHOUT_CATALOG: &str = "This host cannot choose a subagent model.";

/// Node's text for a final input that no longer passes the tool's schema.
pub(crate) const INVALID_AFTER_ADJUSTMENT: &str = "workflow_settings_adjustment_invalid: the settings adjusted in the confirmation window did not produce a valid call. Nothing was started.";

/// Node `describeWorkflowSettingsAdjustment`: the sentence that follows the result's first sentence, naming only the side
/// that changed. Empty when nothing was applied.
pub(crate) fn describe_adjustment(
    applied: &Settings,
    default_concurrency: Option<usize>,
) -> String {
    let mut halves: Vec<String> = Vec::new();
    match &applied.subagent_model {
        Some(None) => halves.push("subagents are back on the session model".to_owned()),
        Some(Some(model)) => halves.push(format!(
            "subagents run on {model} (the main agent stays on the session model)"
        )),
        None => {}
    }
    match &applied.max_concurrency {
        Some(None) => {
            halves.push("the limit on subagents at once is back to the default".to_owned())
        }
        Some(Some(limit)) => {
            let subject = if *limit == 1 {
                "1 subagent runs".to_owned()
            } else {
                format!("{limit} subagents run")
            };
            let hint = default_concurrency
                .map(|default| format!(" (the default is {default})"))
                .unwrap_or_default();
            halves.push(format!("at most {subject} at once{hint}"));
        }
        None => {}
    }
    if halves.is_empty() {
        return String::new();
    }
    format!(
        " Before approving, the user adjusted the settings in the confirmation window: {}.",
        halves.join("; ")
    )
}

/// Node `describeWorkflowRunSettings`: the adjustment sentence first, then the usual sentence for a setting that was not
/// adjusted, then the script's models.
pub(crate) fn describe_run_settings(
    applied: &Settings,
    default_concurrency: Option<usize>,
    limit: impl FnOnce() -> String,
    model: impl FnOnce() -> String,
    script_models: impl FnOnce() -> String,
) -> String {
    format!(
        "{}{}{}{}",
        describe_adjustment(applied, default_concurrency),
        if applied.max_concurrency.is_none() {
            limit()
        } else {
            String::new()
        },
        if applied.subagent_model.is_none() {
            model()
        } else {
            String::new()
        },
        script_models()
    )
}

#[cfg(test)]
#[path = "workflow_settings_tests.rs"]
mod tests;
