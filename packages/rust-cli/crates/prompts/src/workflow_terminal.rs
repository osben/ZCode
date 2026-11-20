//! The terminal notice of a dynamic workflow run (Node `formatLocalWorkflowTaskNotification` in
//! `runtime-task/notification.ts`, its summary `buildWorkflowTaskSummary` in `tool/executor/workflow-artifact.ts`, and
//! the presentation guidance `workflowDeliveryGuidance`). Posted once when the run settles (9.51, W8d).
//!
//! Not built here: the `<reports>` and `<artifacts>` sections, `<output-file>`, `scriptPath` (the run has no file this
//! port names) and the usage block. The guidance takes the "no artifacts, no script file" branches (divergence 720).

use crate::workflow_notice::{escape_xml, truncate_task_notification};

/// The `<error>` text of the run. A plain message is escaped in full; a provider stop is the copy table's multi-line block,
/// escaped for `<>&` only, as Node writes it.
pub enum ErrorText<'a> {
    Plain(&'a str),
    ProviderStop(&'a str),
}

/// What the terminal notice says about a settled run.
pub struct Terminal<'a> {
    pub run_id: &'a str,
    /// The run's title (Node `workflowTaskSubject`): the description, else the run id.
    pub subject: &'a str,
    /// The tool call that started the run (`<tool-use-id>`), when it has one.
    pub tool_use_id: Option<&'a str>,
    /// `completed`, `errored` or `stopped`.
    pub status: &'a str,
    /// Why it stopped (`user`, `model`, `provider`, `interrupted` or `superseded`); only for `stopped`.
    pub stop_reason: Option<&'a str>,
    /// The run's result as Node's `serializeWorkflowArtifact` writes it: a string verbatim, else its JSON.
    pub result: Option<&'a str>,
    pub error: Option<ErrorText<'a>>,
    /// A quota stop with a reset time, which the host resumes by itself (Node `autoResumesAfterReset`).
    pub auto_resumes_after_reset: bool,
}

/// Node `buildWorkflowTaskSummary` for a dwf run: one sentence that says how the run ended.
pub fn summary(subject: &str, status: &str, stop_reason: Option<&str>) -> String {
    let prefix = format!("Workflow \"{subject}\"");
    if status == "errored" {
        return format!("{prefix} errored: the script failed.");
    }
    if status == "stopped" {
        return match stop_reason {
            Some("user") => format!("{prefix} was stopped by the user."),
            Some("model") => format!("{prefix} was stopped by you (TaskStop)."),
            Some("provider") => format!("{prefix} was stopped on a provider error."),
            Some("interrupted") => {
                format!("{prefix} was stopped: the process that owned it exited.")
            }
            Some("superseded") => {
                format!("{prefix} was stopped and superseded by an amended run.")
            }
            _ => format!("{prefix} was stopped."),
        };
    }
    format!("{prefix} completed.")
}

/// The whole terminal notice: the `<task-notification>` block, then the guidance (Node `formatLocalWorkflowTaskNotification`).
pub fn terminal(input: &Terminal<'_>) -> String {
    let summary = summary(input.subject, input.status, input.stop_reason);
    let mut lines = vec![
        "<task-notification>".to_owned(),
        format!("<task-id>{}</task-id>", escape_xml(input.run_id)),
    ];
    if let Some(tool_use) = input.tool_use_id {
        lines.push(format!(
            "<tool-use-id>{}</tool-use-id>",
            escape_xml(tool_use)
        ));
    }
    lines.push(format!("<status>{}</status>", escape_xml(input.status)));
    if let Some(reason) = input.stop_reason {
        lines.push(format!("<stop-reason>{}</stop-reason>", escape_xml(reason)));
    }
    if !input.subject.is_empty() {
        lines.push(format!(
            "<description>{}</description>",
            escape_xml(input.subject)
        ));
    }
    lines.push(format!("<summary>{}</summary>", escape_xml(&summary)));
    if let Some(result) = input.result {
        lines.push(format!("<result>{}</result>", escape_xml(result)));
    }
    match &input.error {
        Some(ErrorText::Plain(error)) => {
            lines.push(format!("<error>{}</error>", escape_xml(error)))
        }
        Some(ErrorText::ProviderStop(block)) => {
            lines.push(format!("<error>\n{}\n</error>", escape_text(block)));
        }
        None => {}
    }
    lines.push("</task-notification>".to_owned());
    lines.push(String::new());
    lines.push(guidance(input));
    truncate_task_notification(&lines.join("\n"))
}

/// Node `escapeXmlText`: `<`, `>` and `&` only.
fn escape_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Node `workflowDeliveryGuidance` for a dwf run, with no artifacts and no script file.
fn guidance(input: &Terminal<'_>) -> String {
    let run_id = input.run_id;
    if input.status == "completed" {
        return [
            "The workflow completed. Present its outcome to the user as a deliverable, in this order: the conclusion; each finding with its evidence (path and line, or the command and output that showed it); which findings were confirmed by a deterministic check or an independent subagent and which are judged only; what the run did not cover.",
            "The reported items above are individual findings: present them individually and keep their evidence. When the preview is partial (count greater than shown), say so and read the rest with GetWorkflowRun.",
            "Do not restate the phase graph or the script.",
        ]
        .join("\n");
    }
    // A run stopped by the user reflects a decision, not an accident.
    if input.stop_reason == Some("user") {
        return [
            "The user stopped this workflow on purpose. Do not resume it with ResumeWorkflowRun and do not amend or rebuild it unless the user asks you to.",
            "Present what it finished before it was stopped: the reported items above are finished findings — show them individually with their evidence. Then stop and wait for the user to say what happens next.",
        ]
        .join("\n");
    }
    if input.stop_reason == Some("model") {
        return [
            "You stopped this workflow with TaskStop. If you stopped it to fix the script, do that now: call AmendWorkflow with this run's ID and the corrected script — everything that settled before the stop is imported as cache, and the sooner the fix runs the less it re-pays. (Next time, amend the running run directly: AmendWorkflow stops it for you.)".to_owned(),
            "Otherwise present what it finished: the reported items above are finished findings — show them individually with their evidence. Resume it unchanged only if that is what the user wants.".to_owned(),
        ]
        .join("\n");
    }
    if input.stop_reason == Some("provider") {
        let resume = if input.auto_resumes_after_reset {
            "The run resumes by itself after the usage cap resets (the <error> block says when): tell the user, and do not call ResumeWorkflowRun or rebuild the workflow before then.".to_owned()
        } else {
            format!(
                "Then resolve the cause with the user before calling ResumeWorkflowRun with run_id=\"{run_id}\" — finished steps replay from the journal. Do not rebuild the workflow."
            )
        };
        return [
            "A provider-side error stopped this run; the <error> block above names the cause and the fix. Present what the run finished: the reported items above are finished findings — show them individually with their evidence.".to_owned(),
            resume,
        ]
        .join("\n");
    }
    if input.stop_reason == Some("interrupted") {
        return [
            "The process that owned this run exited before it finished. Present what it finished: the reported items above are finished findings — show them individually with their evidence.".to_owned(),
            format!(
                "Then call ResumeWorkflowRun with run_id=\"{run_id}\" — finished steps replay from the journal and only the unfinished ones run again."
            ),
        ]
        .join("\n");
    }
    if input.stop_reason == Some("superseded") {
        return "This run was stopped because you amended it: a newer run supersedes it and is already running. Do not resume this run and do not amend it again; wait for the successor's notification.".to_owned();
    }
    if input.status == "stopped" {
        return [
            "This workflow was stopped before it finished. Present what it salvaged first: the reported items above are finished findings — show them individually with their evidence.".to_owned(),
            format!(
                "It can be continued with ResumeWorkflowRun (run_id=\"{run_id}\"); ask the user before resuming a run you did not stop yourself."
            ),
        ]
        .join("\n");
    }
    // errored
    [
        "The workflow script failed. Present what it salvaged first: the reported items above are finished findings — show them individually with their evidence. Then explain the failure and what it means for the user's request.".to_owned(),
        format!(
            "Fix the script and submit it with AmendWorkflow (run_id=\"{run_id}\") so finished work is reused. ResumeWorkflowRun will refuse this run: replaying the same script would fail the same way."
        ),
    ]
    .join("\n")
}

#[cfg(test)]
#[path = "workflow_terminal_tests.rs"]
mod tests;
