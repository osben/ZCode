//! Fork (9.51, W8d): the structured payload of a workflow run notice (Node's `workflowNotification` and `workflowBlocked`
//! keys of `BackgroundResultOriginMeta`, `packages/shared/src/zcode-protocol-v4/workflow-row-meta.ts`).
//!
//! Each builder mints one origin fragment at the point where its notice text is made. The fragment travels with the
//! notice (`AgentSignal::WorkflowNotice`, `UserMessage::workflow_meta`) and is merged into the message's `originMeta`
//! (`origin_meta_for`). It is never read back from the model-facing text: the text lacks fields the payload carries (a hole's
//! ordinal, an escalation's ask time, a result's form). Bounds are Node's, counted in UTF-16 code units.

use serde_json::{Value, json};

/// Node `WORKFLOW_NOTIFICATION_SUMMARY_MAX_CHARS`.
const SUMMARY_MAX_UNITS: usize = 500;
/// Node `WORKFLOW_NOTIFICATION_RESULT_MAX_CHARS`.
const RESULT_MAX_UNITS: usize = 4_000;
/// Node `WORKFLOW_NOTIFICATION_ERROR_MAX_CHARS`.
const ERROR_MAX_UNITS: usize = 2_000;
/// Node's escalation and hole text bounds (`question` and `context` at 4000).
const TEXT_MAX_UNITS: usize = 4_000;
/// The stall reason's bound (Node `reason.slice(0, 64)`).
const REASON_MAX_UNITS: usize = 64;

/// The terminal payload's inputs: what the notice's text says, bounded here as the emitter bounds it.
pub struct TerminalPayload<'a> {
    /// `completed`, `errored` or `stopped`.
    pub status: &'a str,
    /// Only for `stopped`: `user`, `model`, `provider`, `interrupted` or `superseded`.
    pub stop_reason: Option<&'a str>,
    /// The run's title (Node `buildWorkflowTerminalNotification`'s summary is the subject).
    pub subject: &'a str,
    /// The run's result as Node writes it (`serializeWorkflowArtifact`).
    pub result: Option<&'a str>,
    /// True when the script returned a string (`resultForm` `prose`), false for any other value (`json`).
    pub result_is_prose: bool,
    pub error: Option<&'a str>,
}

/// Node `buildWorkflowTerminalNotification`: the `terminal` branch of `workflowNotification`.
pub fn terminal(input: &TerminalPayload<'_>) -> Value {
    let mut meta = json!({
        "kind": "terminal",
        "status": input.status,
        "summary": bound_units(input.subject, SUMMARY_MAX_UNITS),
    });
    if let Some(reason) = input.stop_reason.filter(|_| input.status == "stopped") {
        meta["stopReason"] = json!(reason);
    }
    if let Some(result) = input.result {
        let truncated = units(result) > RESULT_MAX_UNITS;
        meta["result"] = json!(bound_units(result, RESULT_MAX_UNITS));
        meta["resultForm"] = json!(if input.result_is_prose {
            "prose"
        } else {
            "json"
        });
        if truncated {
            meta["resultTruncated"] = json!(true);
        }
    }
    if let Some(error) = input.error {
        meta["error"] = json!(bound_units(error, ERROR_MAX_UNITS));
    }
    json!({ "workflowNotification": meta })
}

/// The escalation branch: a parked question. `asked_at` is the ask's epoch milliseconds, an integer as Node writes it.
pub fn escalation(
    qid: &str,
    actor: &str,
    question: &str,
    context: Option<&str>,
    asked_at: Option<u64>,
) -> Value {
    let mut meta = json!({
        "kind": "escalation",
        "qid": qid,
        "actor": actor,
        "question": bound_units(question, TEXT_MAX_UNITS),
    });
    if let Some(context) = context {
        meta["context"] = json!(bound_units(context, TEXT_MAX_UNITS));
    }
    if let Some(asked_at) = asked_at {
        meta["askedAt"] = json!(asked_at);
    }
    json!({ "workflowNotification": meta })
}

/// The hole branch: a parked `hole<T>()` that the main agent fills. `prompt` is bounded by the caller as the text is.
pub struct HolePayload<'a> {
    pub site_id: &'a str,
    pub ordinal: u64,
    pub name: &'a str,
    pub type_name: &'a str,
    pub prompt: Option<&'a str>,
    pub draft_path: Option<&'a str>,
    pub line: Option<u64>,
    pub before: Option<&'a str>,
    pub after: Option<&'a str>,
}

/// Node `dynamic-workflow-run-hole-notification.ts`'s `workflowNotification` for a hole.
pub fn hole(input: &HolePayload<'_>) -> Value {
    let mut meta = json!({
        "kind": "hole",
        "siteId": input.site_id,
        "ordinal": input.ordinal,
        "name": input.name,
        "type": input.type_name,
    });
    if let Some(prompt) = input.prompt {
        meta["prompt"] = json!(bound_units(prompt, TEXT_MAX_UNITS));
    }
    if let Some(draft) = input.draft_path {
        meta["draftPath"] = json!(draft);
    }
    if let Some(line) = input.line {
        meta["line"] = json!(line);
    }
    if let Some(before) = input.before {
        meta["before"] = json!(before);
    }
    if let Some(after) = input.after {
        meta["after"] = json!(after);
    }
    json!({ "workflowNotification": meta })
}

/// The stall branch: the run has not completed a model request for `since_ms`. The caller floors the time and the cap (Node does too).
pub fn stall(since_ms: u64, reason: Option<&str>, cap: Option<u64>) -> Value {
    let mut meta = json!({"kind": "stall", "sinceMs": since_ms});
    if let Some(reason) = reason {
        meta["reason"] = json!(bound_units(reason, REASON_MAX_UNITS));
    }
    if let Some(cap) = cap {
        meta["cap"] = json!(cap);
    }
    json!({ "workflowNotification": meta })
}

/// Node `WorkflowBlockedMeta`: the reminder's counts and the longest wait. It has its own key, not a `kind` of the union.
pub fn blocked(questions: usize, holes: usize, since_ms: u64) -> Value {
    json!({
        "workflowBlocked": {
            "questions": questions,
            "holes": holes,
            "sinceMs": since_ms,
        }
    })
}

/// 9.56 (637, 716): what a stored notice's `originMeta` gives back on a cold open, as Node's cold read takes the stored meta
/// verbatim. Returns the stall execution (`subagentStall.executionId`) and the workflow fragment (`workflowNotification` and
/// `workflowBlocked`, whichever the meta carries; `None` when neither is there). Feeding both to `origin_meta_for` with the
/// notice's text gives the live meta again, so the cold row equals the live row.
pub fn replay_from_origin_meta(meta: &Value) -> (Option<String>, Option<Value>) {
    let execution = meta["subagentStall"]["executionId"]
        .as_str()
        .map(str::to_owned);
    let mut fragment = serde_json::Map::new();
    for key in ["workflowNotification", "workflowBlocked"] {
        if let Some(payload @ Value::Object(_)) = meta.get(key) {
            fragment.insert(key.to_owned(), payload.clone());
        }
    }
    let workflow = (!fragment.is_empty()).then_some(Value::Object(fragment));
    (execution, workflow)
}

/// Node `length` in UTF-16 code units, and the bound: the shared helpers keep a character whole (divergence 365 of 9.38).
fn units(value: &str) -> usize {
    rust_cli_base::js::string::utf16_len(value)
}

fn bound_units(value: &str, max: usize) -> String {
    rust_cli_base::js::string::utf16_prefix(value, max).to_owned()
}

#[cfg(test)]
#[path = "workflow_notice_meta_tests.rs"]
mod tests;
