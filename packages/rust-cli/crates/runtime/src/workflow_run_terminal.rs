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
pub fn terminal_notice(row: &RunRow) -> Option<TerminalNotice> {
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
    let auto_resumes = provider_stop.is_some_and(|stop| {
        stop.get("kind").and_then(Value::as_str) == Some("quota")
            && stop.get("resetAt").is_some_and(|reset| !reset.is_null())
    });
    let error = match (&provider_block, message) {
        (Some(block), _) => Some(ErrorText::ProviderStop(block)),
        (None, Some(message)) => Some(ErrorText::Plain(message)),
        (None, None) => None,
    };
    let text = terminal(&Terminal {
        run_id,
        subject,
        tool_use_id: row.tool_call_id.as_deref(),
        status,
        stop_reason,
        result: result.as_deref(),
        error,
        auto_resumes_after_reset: auto_resumes,
    });
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
