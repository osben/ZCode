//! Fork: the model text of GetWorkflowRun (Node `core/src/tool/handlers/get-workflow-run-format.ts` and
//! `get-workflow-run-summary.ts`; specs/fork-rust-workflow-engine.md, 9.42). The block order is Node's. The text writes the
//! pending questions (with their ids), the holes, the artifacts, the usage counts and the launch settings the detail
//! carries, from the journal's projected state. What it does not write is the run's roster: the phases, subagents, health,
//! log tail and actors (divergence 433), and with them the summary's step, phase and progress clauses. A count the detail
//! does not carry is left out, not shown as zero.
//!
//! A pure function of the detail and of one clock reading, so the text is exact in tests.

use rust_cli_prompts::workflow_notice::escape_xml;
use serde_json::Value;

use crate::workflow_run_tools::{attribute, field_text, iso_from_ms};

const MS_PER_SECOND: i64 = 1_000;
const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;

const PENDING_QUESTIONS_INSTRUCTION: &str = "Each of these subagents is parked waiting for an answer and nothing times out on its behalf. Answer one with ResolveWorkflowQuestion using the ID in brackets. The rest of the run keeps running meanwhile.";

const HOLES_INSTRUCTION_WAITING: &str = "Each waiting hole parks one branch of the script until you supply its body, and nothing times out on its behalf. Read the run's draft for context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id=\"{run}\" and the hole id in brackets as hole_id. The rest of the run keeps running meanwhile.";

const HOLES_INSTRUCTION_FILLED: &str = "Every hole above has been filled; its body is part of the run's script now (see <amendable> to change it).";

/// The waiting questions and holes of a run, as the journal's projected state gives them (9.42).
fn entries<'a>(detail: &'a Value, key: &str) -> &'a [Value] {
    detail
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Node's pending-question block: each question with its id, asker, age, text and context.
fn pending_block(detail: &Value, now: i64) -> Option<String> {
    let questions = entries(detail, "pendingQuestions");
    if questions.is_empty() {
        return None;
    }
    let rendered: Vec<String> = questions
        .iter()
        .map(|question| {
            let who = text_of(question, "actorName")
                .or_else(|| text_of(question, "actor"))
                .unwrap_or_default();
            let asked = match question.get("askedAt").and_then(Value::as_i64) {
                Some(at) => format!("asked {}", age(now, at)),
                None => "asked at an unknown time".to_owned(),
            };
            let qid = text_of(question, "qid").unwrap_or_default();
            let mut lines = vec![
                format!("[{}] {} {asked}", escape_xml(qid), escape_xml(who)),
                escape_xml(text_of(question, "question").unwrap_or_default()),
            ];
            if let Some(context) = text_of(question, "context") {
                lines.push(format!("context: {}", escape_xml(context)));
            }
            lines.join("\n")
        })
        .collect();
    Some(format!(
        "<pending_questions>\n{}\n\n{PENDING_QUESTIONS_INSTRUCTION}\n</pending_questions>",
        rendered.join("\n\n")
    ))
}

/// Node's hole block: each hole with its state and age, then the instruction for the waiting ones.
fn holes_block(detail: &Value, now: i64) -> Option<String> {
    let holes = entries(detail, "holes");
    if holes.is_empty() {
        return None;
    }
    let rendered: Vec<String> = holes
        .iter()
        .map(|hole| {
            // The journal does not carry a hole's type (divergence 437), so a hole may have none; then no type is written.
            let type_part = text_of(hole, "type")
                .map_or_else(String::new, |kind| format!(": {}", escape_xml(kind)));
            let head = format!(
                "[{}] \"{}\"{type_part}",
                escape_xml(text_of(hole, "siteId").unwrap_or_default()),
                escape_xml(text_of(hole, "name").unwrap_or_default()),
            );
            if text_of(hole, "state") == Some("waiting") {
                let since = hole.get("since").and_then(Value::as_i64);
                let when = since.map_or_else(String::new, |at| {
                    format!(" {}", age(now, at).replace(" ago", ""))
                });
                format!("{head} — waiting{when}")
            } else {
                let filled = hole.get("filledAt").and_then(Value::as_i64);
                let when = filled.map_or_else(String::new, |at| format!(" {}", age(now, at)));
                let by = text_of(hole, "filledBy")
                    .map_or_else(String::new, |who| format!(" by {}", escape_xml(who)));
                format!("{head} — filled{when}{by}")
            }
        })
        .collect();
    let waiting = holes
        .iter()
        .filter(|hole| text_of(hole, "state") == Some("waiting"))
        .count();
    let instruction = if waiting == 0 {
        HOLES_INSTRUCTION_FILLED.to_owned()
    } else {
        HOLES_INSTRUCTION_WAITING.replace(
            "{run}",
            &escape_xml(text_of(detail, "runId").unwrap_or_default()),
        )
    };
    Some(format!(
        "<holes>\n{}\n\n{instruction}\n</holes>",
        rendered.join("\n")
    ))
}

/// Node's artifact list. The line is this build's: the kind, the title (or the id) and whether it is the primary one.
fn artifacts_block(detail: &Value) -> Option<String> {
    let artifacts = entries(detail, "artifacts");
    if artifacts.is_empty() {
        return None;
    }
    let lines: Vec<String> = artifacts
        .iter()
        .map(|artifact| {
            let id = text_of(artifact, "id").unwrap_or_default();
            let title = text_of(artifact, "title").unwrap_or(id);
            let primary = if artifact.get("primary") == Some(&Value::Bool(true)) {
                " (primary)"
            } else {
                ""
            };
            format!(
                "[{}] {}: {}{primary}",
                escape_xml(id),
                escape_xml(text_of(artifact, "kind").unwrap_or_default()),
                escape_xml(title)
            )
        })
        .collect();
    Some(format!(
        "<artifacts count=\"{}\">\n{}\n</artifacts>",
        artifacts.len(),
        lines.join("\n")
    ))
}

/// Node's usage block: the spent tokens and the four node counts.
fn usage_block(detail: &Value) -> String {
    // A count the read did not carry is left out, not shown as zero.
    let usage = detail.get("usage");
    let parts: Vec<String> = [
        ("spentTokens", "spent_tokens"),
        ("nodesObserved", "nodes_observed"),
        ("nodesRunning", "nodes_running"),
        ("nodesCompleted", "nodes_completed"),
        ("nodesFailed", "nodes_failed"),
    ]
    .into_iter()
    .filter_map(|(key, name)| {
        usage
            .and_then(|usage| usage.get(key))
            .map(|value| format!("{name}={}", escape_xml(&field_text(value))))
    })
    .collect();
    format!("<usage>{}</usage>", parts.join(" "))
}

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
    if let Some(code) = error_code(detail)
        && (status == "errored" || text_of(detail, "stopReason") == Some("provider"))
    {
        clauses.push(format!("Failure: {code}."));
    }
    let questions = entries(detail, "pendingQuestions").len();
    if questions > 0 {
        let plural = if questions == 1 { "" } else { "s" };
        clauses.push(format!(
            "{questions} question{plural} awaiting your answer."
        ));
    }
    let waiting_holes = entries(detail, "holes")
        .iter()
        .filter(|hole| text_of(hole, "state") == Some("waiting"))
        .count();
    if waiting_holes > 0 {
        let plural = if waiting_holes == 1 { "" } else { "s" };
        clauses.push(format!("{waiting_holes} hole{plural} awaiting your code."));
    }
    if status == "completed"
        && let Some(primary) = entries(detail, "artifacts")
            .iter()
            .find(|artifact| artifact.get("primary") == Some(&Value::Bool(true)))
    {
        let title = text_of(primary, "title")
            .or_else(|| text_of(primary, "id"))
            .unwrap_or_default();
        let kind = text_of(primary, "kind").unwrap_or_default();
        clauses.push(format!("Deliverable: {title} ({kind}, primary)."));
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
    // Node's order: stop reason, resumed-from, the concurrency limit and subagent model an amendment inherits, superseded-by.
    for (key, tag) in [
        ("stopReason", "stop_reason"),
        ("resumedFrom", "resumed_from"),
    ] {
        if let Some(value) = text_of(detail, key) {
            blocks.push(format!("<{tag}>{}</{tag}>", escape_xml(value)));
        }
    }
    if let Some(limit) = detail.get("maxConcurrency") {
        blocks.push(format!(
            "<max_concurrency>{}</max_concurrency>",
            escape_xml(&field_text(limit))
        ));
    }
    if let Some(model) = text_of(detail, "subagentModel") {
        blocks.push(format!(
            "<subagent_model>{}</subagent_model>",
            escape_xml(model)
        ));
    }
    if let Some(value) = text_of(detail, "supersededBy") {
        blocks.push(format!(
            "<superseded_by>{}</superseded_by>",
            escape_xml(value)
        ));
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
    blocks.extend(pending_block(detail, now));
    blocks.extend(holes_block(detail, now));
    blocks.push(usage_block(detail));

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

    blocks.extend(artifacts_block(detail));

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

#[cfg(test)]
#[path = "workflow_run_detail_tests.rs"]
mod tests;
