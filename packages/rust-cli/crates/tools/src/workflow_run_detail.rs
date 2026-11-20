//! Fork: the model text of GetWorkflowRun (Node `core/src/tool/handlers/get-workflow-run-format.ts` and
//! `get-workflow-run-summary.ts`; specs/fork-rust-workflow-engine.md, 9.42). The block order is Node's. The blocks that need
//! the run's live roster, phases, log tail, holes, artifacts, node counts or pending-question ids are not in this build
//! (divergences 433 to 436), so their absence is said in the text rather than shown as zero.
//!
//! A pure function of the detail and of one clock reading, so the text is exact in tests.

use rust_cli_prompts::workflow_notice::escape_xml;
use serde_json::Value;

use crate::workflow_run_tools::{attribute, field_text, iso_from_ms};

const MS_PER_SECOND: i64 = 1_000;
const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;

/// What this build says about pending questions. Node names the ids here; this build has not read them yet (433).
const PENDING_QUESTIONS_DEFERRED: &str = "Unknown: this build of GetWorkflowRun does not read pending questions yet, so this read cannot list the ids of the questions a subagent is waiting on. A question's ID comes from its escalation notification; the run keeps waiting until it is answered.";

/// Node `formatWorkflowRunDuration`: `40s`, `5m 10s`, `2h 15m` or `3d 2h`. Two units only, minutes and seconds padded.
fn duration(ms: i64) -> String {
    let total = ms.max(0);
    if total < MS_PER_MINUTE {
        return format!("{}s", total / MS_PER_SECOND);
    }
    if total < MS_PER_HOUR {
        let minutes = total / MS_PER_MINUTE;
        let seconds = (total % MS_PER_MINUTE) / MS_PER_SECOND;
        return format!("{minutes}m {seconds:02}s");
    }
    if total < MS_PER_DAY {
        let hours = total / MS_PER_HOUR;
        let minutes = (total % MS_PER_HOUR) / MS_PER_MINUTE;
        return format!("{hours}h {minutes:02}m");
    }
    format!(
        "{}d {}h",
        total / MS_PER_DAY,
        (total % MS_PER_DAY) / MS_PER_HOUR
    )
}

/// Node `formatRelativeAge`: `X ago`.
fn age(now: i64, at: i64) -> String {
    format!("{} ago", duration(now - at))
}

/// Node `formatWorkflowRunInstant`: the ISO time and its age.
fn instant(now: i64, at: i64) -> String {
    format!("{} ({})", iso_from_ms(at), age(now, at))
}

fn text_of<'a>(detail: &'a Value, key: &str) -> Option<&'a str> {
    detail.get(key).and_then(Value::as_str)
}

fn int_of(detail: &Value, key: &str) -> i64 {
    detail.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn error_code(detail: &Value) -> Option<&str> {
    detail.get("error")?.get("code")?.as_str()
}

/// Node `buildWorkflowRunSummary`, for the facts this build reads. The step, phase and progress clauses need the roster
/// and are not here (433).
fn summary(detail: &Value, now: i64) -> String {
    let status = text_of(detail, "status").unwrap_or_default();
    let terminal = matches!(status, "completed" | "errored" | "stopped");
    let created = int_of(detail, "createdAt");
    let updated = int_of(detail, "updatedAt");
    let elapsed = duration(updated - created);
    let mut clauses = vec![match status {
        "pending" => "Pending, not dispatched yet.".to_owned(),
        "completed" => format!("Completed in {elapsed}."),
        "errored" => format!("Errored after {elapsed}."),
        "stopped" => {
            let reason = text_of(detail, "stopReason").unwrap_or("stopped");
            format!("Stopped ({reason}) {} after {elapsed}.", age(now, updated))
        }
        _ => format!("Running for {}.", duration(now - created)),
    }];
    if !terminal {
        clauses.push("Pending questions are unknown from this session.".to_owned());
    }
    if let Some(code) = error_code(detail)
        && (status == "errored" || text_of(detail, "stopReason") == Some("provider"))
    {
        clauses.push(format!("Failure: {code}."));
    }
    if detail.get("ownedByThisSession") == Some(&Value::Bool(false)) {
        clauses.push("Owned by another session.".to_owned());
    }
    clauses.join(" ")
}

/// Node `<resumable>`: the reason sentence is the one Node writes for each stop reason.
fn resumable(detail: &Value) -> String {
    let reason = match text_of(detail, "stopReason") {
        Some("user") => {
            " This run was stopped on purpose by the user: resume it only when the user asks."
        }
        Some("model") => {
            " You stopped this run yourself with TaskStop: resume it unchanged only if that is what the user wants. If you stopped it to fix the script, do not wait — amend it now, see <amendable>."
        }
        Some("provider") => {
            " A provider-side error stopped it: resolve the cause named in <error> with the user before resuming, or it will stop again the same way."
        }
        _ => "",
    };
    format!(
        "<resumable>This run can be continued with ResumeWorkflowRun — it will resume under the same run ID, replaying finished steps and re-dispatching the unfinished ones.{reason} The script must be byte-for-byte the one this run was started with; to change it, see <amendable>.</resumable>"
    )
}

/// The model's text for one run. `now` is the one clock reading of the call.
pub fn format_detail(detail: &Value, now: i64) -> String {
    let status = text_of(detail, "status").unwrap_or_default();
    let terminal = matches!(status, "completed" | "errored" | "stopped");
    let mut blocks = vec![format!(
        "<summary>{}</summary>",
        escape_xml(&summary(detail, now))
    )];

    let run_id = text_of(detail, "runId").unwrap_or_default();
    blocks.push(format!("<run_id>{}</run_id>", escape_xml(run_id)));
    blocks.push(format!(
        "<label {}>{}</label>",
        attribute("source", text_of(detail, "labelSource").unwrap_or_default()),
        escape_xml(text_of(detail, "label").unwrap_or_default())
    ));
    blocks.push(format!("<status>{}</status>", escape_xml(status)));
    for (key, tag) in [
        ("stopReason", "stop_reason"),
        ("resumedFrom", "resumed_from"),
        ("supersededBy", "superseded_by"),
    ] {
        if let Some(value) = text_of(detail, key) {
            blocks.push(format!("<{tag}>{}</{tag}>", escape_xml(value)));
        }
    }
    let owned = detail.get("ownedByThisSession") == Some(&Value::Bool(true));
    blocks.push(format!(
        "<owned_by_this_session>{owned}</owned_by_this_session>"
    ));
    if detail.get("possiblyInterrupted") == Some(&Value::Bool(true)) {
        blocks.push(
            "<possibly_interrupted>true — this session cannot confirm the run is still alive</possibly_interrupted>"
                .to_owned(),
        );
    }
    blocks.push(format!(
        "<created_at>{}</created_at>",
        instant(now, int_of(detail, "createdAt"))
    ));
    blocks.push(format!(
        "<updated_at>{}</updated_at>",
        instant(now, int_of(detail, "updatedAt"))
    ));
    if !terminal {
        blocks.push(format!(
            "<pending_questions>{PENDING_QUESTIONS_DEFERRED}</pending_questions>"
        ));
    }

    let spent = detail
        .get("usage")
        .and_then(|usage| usage.get("spentTokens"))
        .map(field_text)
        .unwrap_or_else(|| "0".to_owned());
    blocks.push(format!("<usage>spent_tokens={spent}</usage>"));

    if let Some(result) = detail.get("result") {
        // Verbatim, as Node's `<result>`: a string is the text itself, anything else its JSON.
        let body = match result {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
        blocks.push(format!("<result>\n{body}\n</result>"));
    }
    if let Some(error) = detail.get("error") {
        let code = error
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        blocks.push(format!(
            "<error {}>{}</error>",
            attribute("code", code),
            escape_xml(message)
        ));
    }

    // Routing. A superseded run points only at its successor; a stopped run says how it may continue.
    if text_of(detail, "stopReason") == Some("superseded") {
        let successor = text_of(detail, "supersededBy").map_or_else(
            || "its successor".to_owned(),
            |id| format!("run {}", escape_xml(id)),
        );
        blocks.push(format!(
            "<superseded>This run was stopped by an AmendWorkflow and superseded by {successor}, which owns its unfinished work. Do not resume it (ResumeWorkflowRun will refuse) and do not amend it again; read or amend {successor} instead.</superseded>"
        ));
    } else if status == "stopped" {
        blocks.push(resumable(detail));
    }
    blocks.join("\n\n")
}
