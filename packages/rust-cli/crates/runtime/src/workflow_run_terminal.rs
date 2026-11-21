//! Fork (9.51, W8d): the terminal notice of a settled run (Node `formatLocalWorkflowTaskNotification`, minted when the
//! background tracker settles the run). The run service calls it once per settlement, on the owner's thread, and posts the
//! text and its payload to the parent session's model.
//!
//! A run that is not terminal posts nothing, and neither does a run superseded by an amendment: Node suppresses that one
//! (`workflow_run_superseded`), since the AmendWorkflow result is all the model needs.

use rust_cli_kernel_api::workflow_notice_meta::{self, TerminalPayload};
use rust_cli_prompts::workflow_terminal::{ErrorText, Terminal, terminal};
use rust_cli_workflow::model::{RunRow, RunStatus, StopReason};
use serde_json::Value;

/// A terminal notice ready to post: the parent session, the model text and the `workflowNotification` fragment.
#[derive(Debug, Clone, PartialEq)]
pub struct TerminalNotice {
    pub parent_session_id: String,
    pub text: String,
    pub workflow: Value,
}

/// Whether a run's status is one of its three terminal states (the states a settlement writes).
pub fn is_terminal(status: RunStatus) -> bool {
    matches!(
        status,
        RunStatus::Completed | RunStatus::Errored | RunStatus::Stopped
    )
}

/// The terminal notice of `row`, or `None` when the run is not terminal, has no parent session, or was superseded.
pub fn terminal_notice(row: &RunRow, auto_resumes: bool) -> Option<TerminalNotice> {
    if !is_terminal(row.status) {
        return None;
    }
    let status = row.status.as_str();
    if row.stop_reason == Some(StopReason::Superseded) {
        return None;
    }
    let stop_reason = row.stop_reason.map(StopReason::as_str);
    let parent_session_id = row.parent_session_id.clone()?;
    let run_id = row.run_id.as_str();
    let subject = row
        .name
        .as_deref()
        .filter(|name| !name.is_empty())
        .unwrap_or(run_id);
    let result = row.result.as_ref().map(artifact_text);
    let result_is_prose = matches!(row.result, Some(Value::String(_)));
    let failure = row.failure.as_ref();
    let message = failure
        .and_then(|failure| failure.get("message"))
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty());
    let provider_stop = failure
        .and_then(|failure| failure.get("providerStop"))
        .filter(|stop| stop.is_object());
    let provider_block = provider_stop.map(|stop| rust_cli_tools::provider_stop_text(stop, run_id));
    let error = match (&provider_block, message) {
        (Some(block), _) => Some(ErrorText::ProviderStop(block)),
        (None, Some(message)) => Some(ErrorText::Plain(message)),
        (None, None) => None,
    };
    // Fork (9.61): Node delivers the envelope as a `task_notification` input, which `formatIncomingMessage` opens with the
    // background-task preamble. Node's other preamble, for a notice delivered in the same turn as a user message, is not
    // chosen here (divergence 909).
    let envelope = terminal(&Terminal {
        run_id,
        subject,
        tool_use_id: row.tool_call_id.as_deref(),
        status,
        stop_reason,
        result: result.as_deref(),
        error,
        auto_resumes_after_reset: auto_resumes,
    });
    let text = format!(
        "{}{envelope}",
        rust_cli_prompts::agents::notification_preamble()
    );
    let workflow = workflow_notice_meta::terminal(&TerminalPayload {
        status,
        stop_reason,
        subject,
        result: result.as_deref(),
        result_is_prose,
        error: message,
    });
    Some(TerminalNotice {
        parent_session_id,
        text,
        workflow,
    })
}

/// Fork (9.61): `notice` with its payload's `durationMs` (Node `workflowNotificationDurationMs`). No duration leaves the
/// key out, so the card shows a dash, never 0.
pub fn with_duration(mut notice: TerminalNotice, duration_ms: Option<u64>) -> TerminalNotice {
    if let Some(ms) = duration_ms
        && let Some(meta) = notice.workflow.get_mut("workflowNotification")
    {
        meta["durationMs"] = Value::from(ms);
    }
    notice
}

/// This incarnation's wall-clock life: `settled_at_ms - started_at_ms`. A start of 0 (no clock at launch), no settle
/// reading, or a negative difference is unknown. Node takes the larger of this and the lineage's journaled active
/// duration; Rust has no lineage sum (divergence 907).
pub fn run_duration_ms(started_at_ms: i64, settled_at_ms: Option<u64>) -> Option<u64> {
    let started = u64::try_from(started_at_ms)
        .ok()
        .filter(|started| *started > 0)?;
    settled_at_ms?.checked_sub(started)
}

/// Fork (9.61): `notice` with the run's user-facing artifact chips (Node `buildWorkflowArtifactsManifestSection`): the
/// deliverable first, at most 8, and `artifactsTruncated` when any published artifact is not shown (cut by the limit or
/// dropped for an unknown kind, an empty or overlong id, or a bad version). `artifacts` is the projected run's list; none,
/// or no valid entry, leaves both keys out.
pub fn with_artifacts(mut notice: TerminalNotice, artifacts: Option<&Value>) -> TerminalNotice {
    let Some(published) = artifacts
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
    else {
        return notice;
    };
    let is_primary = |artifact: &&Value| artifact.get("primary") == Some(&Value::Bool(true));
    let ordered = published
        .iter()
        .filter(is_primary)
        .chain(published.iter().filter(|artifact| !is_primary(artifact)));
    let mut chips = Vec::new();
    for artifact in ordered {
        if chips.len() >= MANIFEST_MAX_ARTIFACTS {
            break;
        }
        if let Some(chip) = manifest_chip(artifact) {
            chips.push(chip);
        }
    }
    if chips.is_empty() {
        return notice;
    }
    let truncated = chips.len() < published.len();
    if let Some(meta) = notice.workflow.get_mut("workflowNotification") {
        meta["artifacts"] = Value::Array(chips);
        if truncated {
            meta["artifactsTruncated"] = Value::Bool(true);
        }
    }
    notice
}

const MANIFEST_MAX_ARTIFACTS: usize = 8;
const MANIFEST_KINDS: [&str; 6] = ["file", "markdown", "chart", "table", "metrics", "board"];

/// One chip, or `None` for an entry the manifest drops whole (Node keeps zod from rejecting the payload).
fn manifest_chip(artifact: &Value) -> Option<Value> {
    let id = artifact.get("id").and_then(Value::as_str)?;
    let kind = artifact
        .get("kind")
        .and_then(Value::as_str)
        .filter(|kind| MANIFEST_KINDS.contains(kind))?;
    if id.is_empty() || id.encode_utf16().count() > 64 {
        return None;
    }
    let version = artifact
        .get("version")
        .and_then(Value::as_f64)
        .filter(|version| version.fract() == 0.0 && *version >= 1.0)?;
    let mut chip = serde_json::Map::new();
    chip.insert("id".into(), Value::from(id));
    chip.insert("kind".into(), Value::from(kind));
    let text = |key: &str, max: usize| {
        artifact
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| text.chars().take(max).collect::<String>())
    };
    if let Some(title) = text("title", 120) {
        chip.insert("title".into(), Value::from(title));
    }
    chip.insert("version".into(), Value::from(version as u64));
    if let Some(content_type) = artifact
        .get("contentType")
        .and_then(Value::as_str)
        .filter(|content_type| content_type.encode_utf16().count() <= 255)
    {
        chip.insert("contentType".into(), Value::from(content_type));
    }
    if artifact.get("primary") == Some(&Value::Bool(true)) {
        chip.insert("primary".into(), Value::Bool(true));
        if let Some(description) = text("description", 500) {
            chip.insert("description".into(), Value::from(description));
        }
    }
    Some(Value::Object(chip))
}

/// Node `serializeWorkflowArtifact`: a string is the text itself, anything else its JSON.
fn artifact_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

#[cfg(test)]
#[path = "workflow_run_terminal_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "workflow_run_terminal_service_tests.rs"]
mod service_tests;
