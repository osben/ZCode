//! Fork: the model text of GetWorkflowRun (Node `core/src/tool/handlers/get-workflow-run-format*.ts`,
//! `get-workflow-run-summary.ts` and `workflow-run-introspection.ts`; specs/fork-rust-workflow-engine.md, 9.42 and 9.46).
//! The block order is Node's: summary, identity, pending questions, holes, health, phases, subagents, log tail, usage,
//! outcome (result, error, artifacts), routing.
//!
//! The facts come from the detail the runtime builds: the journal row, the projected state (9.42) and the situation snapshot
//! (9.46, `run_roster`). Each block is written only for the facts it has; a count the read does not carry is left out, not
//! shown as zero. Holes and the artifact line keep this build's wording (divergences 435 and 437 in 9.42).
//!
//! A pure function of the detail and of one clock reading, so the text is exact in tests.

use rust_cli_prompts::workflow_notice::escape_xml;
use serde_json::Value;

use crate::workflow_run_tools::{attribute, field_text, iso_from_ms};

const MS_PER_SECOND: i64 = 1_000;
const MS_PER_MINUTE: i64 = 60_000;
const MS_PER_HOUR: i64 = 3_600_000;
const MS_PER_DAY: i64 = 86_400_000;

/// Node `buildWorkflowRunSummary`: the budget in characters; a longer summary drops optional clauses, then is cut.
const SUMMARY_MAX_CHARS: usize = 400;
const SUMMARY_ELLIPSIS: &str = "…";
/// Node `MAX_COLUMN_WIDTH`: a column is at most this wide; a longer value makes its row longer, not the table wider.
const MAX_COLUMN_WIDTH: usize = 24;

const PENDING_QUESTIONS_UNKNOWN: &str = "Unknown: pending questions are tracked only by the process that owns the run, and this session does not. Resuming the run will re-ask any question its subagent still needs answered.";
const PENDING_QUESTIONS_INSTRUCTION: &str = "Each of these subagents is parked waiting for an answer and nothing times out on its behalf. Answer one with ResolveWorkflowQuestion using the ID in brackets. The rest of the run keeps running meanwhile.";
const HOLES_INSTRUCTION_WAITING: &str = "Each waiting hole parks one branch of the script until you supply its body, and nothing times out on its behalf. Read the run's draft for context, write only the statements of the hole's function returning its type, and call FillWorkflowHole with run_id=\"{run}\" and the hole id in brackets as hole_id. The rest of the run keeps running meanwhile.";
const HOLES_INSTRUCTION_FILLED: &str = "Every hole above has been filled; its body is part of the run's script now (see <amendable> to change it).";
const NO_SUBAGENTS: &str = "<subagents>No subagents created yet.</subagents>";
const NO_LOG_TAIL: &str = "<log_tail>No log() narration recorded yet.</log_tail>";

/// The entries of a list field, or none.
fn entries<'a>(detail: &'a Value, key: &str) -> &'a [Value] {
    detail
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn text_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn int_of(value: &Value, key: &str) -> Option<i64> {
    let field = value.get(key)?;
    field.as_i64().or_else(|| {
        field
            .as_f64()
            .filter(|n| n.fract() == 0.0)
            .map(|n| n as i64)
    })
}

fn bool_of(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn health(detail: &Value) -> &Value {
    detail.get("health").unwrap_or(&Value::Null)
}

/// Whether the run's parked questions are known. A detail without the situation snapshot does not say, so it is unknown.
fn questions_known(detail: &Value) -> bool {
    bool_of(health(detail), "pendingQuestionsKnown") == Some(true)
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "completed" | "errored" | "stopped")
}

// ————————————————————————————————————————————————
// Durations, ages and table cells (Node `workflow-run-introspection.ts`, `get-workflow-run-format-roster.ts`)
// ————————————————————————————————————————————————

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

/// Node `formatRelativeAge`: `X ago`. A clock reading before the time reads as no time passed.
fn age(now: i64, at: i64) -> String {
    format!("{} ago", duration(now - at))
}

/// The age without its ` ago`, for the sentences that say `for X` or `X on this step`.
fn bare_age(now: i64, at: i64) -> String {
    duration(now - at)
}

/// Node `formatWorkflowRunInstant`: the ISO time and its age.
fn instant(now: i64, at: i64) -> String {
    format!("{} ({})", iso_from_ms(at), age(now, at))
}

/// Node `escapeWorkflowRunText` on a value that may be a number: the field text, escaped.
fn escaped(value: &Value) -> String {
    escape_xml(&field_text(value))
}

/// Node `formatWorkflowRunCount`: thousands separators.
fn count(value: i64) -> String {
    let sign = if value < 0 { "-" } else { "" };
    let digits = value.unsigned_abs().to_string();
    let mut grouped = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(digit);
    }
    format!("{sign}{grouped}")
}

/// Node `joinCells`: empty cells are dropped, the rest are joined by two spaces, and the end is trimmed.
fn join_cells(cells: &[String]) -> String {
    cells
        .iter()
        .filter(|cell| !cell.is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("  ")
        .trim_end()
        .to_owned()
}

/// Node `columnWidth`: the widest value, capped.
fn column_width(values: &[String]) -> usize {
    values
        .iter()
        .map(|value| value.chars().count())
        .max()
        .unwrap_or(0)
        .min(MAX_COLUMN_WIDTH)
}

/// Node `padColumn`: pad with spaces to the column width.
fn pad(value: &str, width: usize) -> String {
    let length = value.chars().count();
    if length >= width {
        value.to_owned()
    } else {
        format!("{value}{}", " ".repeat(width - length))
    }
}

// ————————————————————————————————————————————————
// The summary (Node `get-workflow-run-summary.ts`)
// ————————————————————————————————————————————————

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The first `limit` UTF-16 units of `text`, never splitting a character.
fn utf16_prefix(text: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for ch in text.chars() {
        let width = ch.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        out.push(ch);
    }
    out
}

/// Node `buildWorkflowRunSummary`: one sentence from the detail's facts. The status and the step clauses are kept; the
/// optional clauses are dropped from the end when the sentence is over the budget, and a last cut adds an ellipsis.
pub(crate) fn summary(detail: &Value, now: i64) -> String {
    let status = text_of(detail, "status").unwrap_or_default();
    let terminal = is_terminal(status);
    let mut required = vec![format!(
        "{}{}.",
        status_clause(detail, now, status, terminal),
        phase_clause(detail)
    )];
    if let Some(steps) = steps_clause(detail, status, terminal) {
        required.push(format!("{steps}."));
    }
    let mut optional: Vec<String> = [
        failure_clause(detail, status),
        questions_clause(detail),
        holes_clause(detail),
        progress_clause(detail, now, terminal),
        deliverable_clause(detail, status),
        ownership_clause(detail),
    ]
    .into_iter()
    .flatten()
    .collect();
    let joined = |required: &[String], optional: &[String]| {
        required
            .iter()
            .chain(optional)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(" ")
    };
    while !optional.is_empty() && utf16_len(&joined(&required, &optional)) > SUMMARY_MAX_CHARS {
        optional.pop();
    }
    let text = joined(&required, &optional);
    if utf16_len(&text) <= SUMMARY_MAX_CHARS {
        return text;
    }
    let cut = SUMMARY_MAX_CHARS - utf16_len(SUMMARY_ELLIPSIS);
    format!("{}{SUMMARY_ELLIPSIS}", utf16_prefix(&text, cut))
}

/// Status and how long it has run, or how long ago it ended.
fn status_clause(detail: &Value, now: i64, status: &str, terminal: bool) -> String {
    let created = int_of(detail, "createdAt").unwrap_or(0);
    let updated = int_of(detail, "updatedAt").unwrap_or(0);
    let elapsed = duration(updated - created);
    if !terminal {
        return if status == "pending" {
            "Pending, not dispatched yet".to_owned()
        } else {
            format!("Running for {}", duration(now - created))
        };
    }
    match status {
        "completed" => format!("Completed in {elapsed}"),
        "errored" => format!("Errored after {elapsed}"),
        _ => {
            let reason = text_of(detail, "stopReason").unwrap_or("stopped");
            format!("Stopped ({reason}) {} after {elapsed}", age(now, updated))
        }
    }
}

/// The phase position: the current or unfinished phase of a live or unfinished run, else how many phases were entered.
fn phase_clause(detail: &Value) -> String {
    let phases = entries(detail, "phases");
    if phases.is_empty() {
        return String::new();
    }
    let position = phases
        .iter()
        .position(|phase| matches!(text_of(phase, "state"), Some("current" | "unfinished")));
    match position {
        Some(index) => format!(
            ", in phase {} of {} ({})",
            index + 1,
            phases.len(),
            text_of(&phases[index], "name").unwrap_or_default()
        ),
        None => {
            // Phases not yet entered (`ahead`) have not happened: they are not counted.
            let entered = phases
                .iter()
                .filter(|phase| text_of(phase, "state") != Some("ahead"))
                .count();
            format!(", across {entered} phase{}", plural(entered))
        }
    }
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// The step count. Without the node counts of the read, no step clause is written (divergence 432 of 9.42).
fn steps_clause(detail: &Value, status: &str, terminal: bool) -> Option<String> {
    let usage = detail.get("usage")?;
    let completed = int_of(usage, "nodesCompleted")?;
    let failed_count = int_of(usage, "nodesFailed")?;
    let observed = int_of(usage, "nodesObserved")?;
    let running = int_of(usage, "nodesRunning").unwrap_or(0);
    let settled = completed + failed_count;
    let leftover = int_of(health(detail), "leftoverRunning").unwrap_or(0);
    if terminal && leftover > 0 {
        // The process died while these steps were active: they are remnants, and resuming re-dispatches them.
        return Some(format!(
            "{settled} of {observed} dispatched steps settled; {leftover} {} still running {}",
            if leftover == 1 { "was" } else { "were" },
            leftover_ending(detail, status, leftover)
        ));
    }
    if terminal {
        let failed = if failed_count > 0 {
            format!(", {failed_count} failed")
        } else {
            String::new()
        };
        let tokens = int_of(usage, "spentTokens").unwrap_or(0);
        return Some(format!(
            "{settled} step{} settled{failed}, {} tokens",
            plural(settled as usize),
            count(tokens)
        ));
    }
    let running_part = if running > 0 {
        format!(", {running} running{}", running_breakdown(detail))
    } else {
        String::new()
    };
    Some(format!(
        "{settled} of {observed} dispatched steps settled{running_part}"
    ))
}

/// How the leftover steps were left, which the stop reason decides (Node `leftoverEnding`).
fn leftover_ending(detail: &Value, status: &str, leftover: i64) -> &'static str {
    let reason = text_of(detail, "stopReason");
    if reason == Some("superseded") {
        return if leftover == 1 {
            "when the run was superseded; the new run owns it"
        } else {
            "when the run was superseded; the new run owns them"
        };
    }
    if status == "errored" {
        return "when the run ended";
    }
    if reason.is_none() || reason == Some("interrupted") {
        return "when the owning process exited and will be re-dispatched on resume";
    }
    "when the run stopped and will be re-dispatched on resume"
}

/// The live subagents' states in parentheses: they partition the running steps (Node `runningBreakdown`).
fn running_breakdown(detail: &Value) -> String {
    let mut parts = Vec::new();
    for state in ["executing", "waiting", "parked"] {
        let n = entries(detail, "subagents")
            .iter()
            .filter(|subagent| text_of(subagent, "state") == Some(state))
            .count();
        if n > 0 {
            parts.push(format!("{n} {state}"));
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ({})", parts.join(", "))
    }
}

fn failure_clause(detail: &Value, status: &str) -> Option<String> {
    let error = detail.get("error")?;
    if status != "errored" && text_of(detail, "stopReason") != Some("provider") {
        return None;
    }
    Some(format!(
        "Failure: {}.",
        text_of(error, "code").unwrap_or_default()
    ))
}

/// The parked questions. An unknown list is said to be unknown: "nobody is waiting" and "cannot look it up" differ.
fn questions_clause(detail: &Value) -> Option<String> {
    if !questions_known(detail) {
        return Some("Pending questions are unknown from this session.".to_owned());
    }
    let count = entries(detail, "pendingQuestions").len();
    (count > 0).then(|| format!("{count} question{} awaiting your answer.", plural(count)))
}

fn holes_clause(detail: &Value) -> Option<String> {
    let waiting = waiting_holes(detail);
    (waiting > 0).then(|| format!("{waiting} hole{} awaiting your code.", plural(waiting)))
}

fn waiting_holes(detail: &Value) -> usize {
    entries(detail, "holes")
        .iter()
        .filter(|hole| text_of(hole, "state") == Some("waiting"))
        .count()
}

fn progress_clause(detail: &Value, now: i64, terminal: bool) -> Option<String> {
    if terminal {
        return None;
    }
    let at = int_of(health(detail), "lastProgressAt")?;
    Some(if int_of(health(detail), "stalledSince").is_some() {
        format!("Stalled, last progress {}.", age(now, at))
    } else {
        format!("Last progress {}.", age(now, at))
    })
}

/// The deliverable, named by its kind, for a completed run with a primary artifact. The title is not quoted: the kind brackets it.
fn deliverable_clause(detail: &Value, status: &str) -> Option<String> {
    if status != "completed" {
        return None;
    }
    let primary = entries(detail, "artifacts")
        .iter()
        .find(|artifact| bool_of(artifact, "primary") == Some(true))?;
    let title = text_of(primary, "title").or_else(|| text_of(primary, "id"))?;
    Some(format!(
        "Deliverable: {title} ({}, primary).",
        text_of(primary, "kind").unwrap_or_default()
    ))
}

fn ownership_clause(detail: &Value) -> Option<String> {
    (bool_of(detail, "ownedByThisSession") == Some(false))
        .then(|| "Owned by another session.".to_owned())
}

// ————————————————————————————————————————————————
// The blocks
// ————————————————————————————————————————————————

/// Node `identityBlocks`: one label per fact, and none for an absent fact.
fn identity(detail: &Value, now: i64) -> Vec<String> {
    let mut blocks = vec![
        format!(
            "<run_id>{}</run_id>",
            escape_xml(text_of(detail, "runId").unwrap_or_default())
        ),
        format!(
            "<label {}>{}</label>",
            attribute("source", text_of(detail, "labelSource").unwrap_or_default()),
            escape_xml(text_of(detail, "label").unwrap_or_default())
        ),
        format!(
            "<status>{}</status>",
            escape_xml(text_of(detail, "status").unwrap_or_default())
        ),
    ];
    for (key, tag) in [
        ("stopReason", "stop_reason"),
        ("resumedFrom", "resumed_from"),
    ] {
        if let Some(value) = text_of(detail, key) {
            blocks.push(format!("<{tag}>{}</{tag}>", escape_xml(value)));
        }
    }
    // Present only when the run lowered its concurrency: an amendment inherits this value.
    if let Some(limit) = detail.get("maxConcurrency") {
        blocks.push(format!(
            "<max_concurrency>{}</max_concurrency>",
            escaped(limit)
        ));
    }
    if let Some(model) = text_of(detail, "subagentModel") {
        blocks.push(format!(
            "<subagent_model>{}</subagent_model>",
            escape_xml(model)
        ));
    }
    if let Some(bindings) = detail
        .get("modelBindings")
        .and_then(Value::as_object)
        .filter(|bindings| !bindings.is_empty())
    {
        let lines: Vec<String> = bindings
            .iter()
            .map(|(name, canonical)| {
                format!(
                    "\"{}\" = {}",
                    escape_xml(name),
                    escape_xml(&field_text(canonical))
                )
            })
            .collect();
        blocks.push(format!(
            "<script_models>\n{}\n</script_models>",
            lines.join("\n")
        ));
    }
    if let Some(successor) = text_of(detail, "supersededBy") {
        blocks.push(format!(
            "<superseded_by>{}</superseded_by>",
            escape_xml(successor)
        ));
    }
    let owned = bool_of(detail, "ownedByThisSession") == Some(true);
    blocks.push(format!(
        "<owned_by_this_session>{owned}</owned_by_this_session>"
    ));
    if bool_of(detail, "possiblyInterrupted") == Some(true) {
        blocks.push(
            "<possibly_interrupted>true — this session cannot confirm the run is still alive</possibly_interrupted>"
                .to_owned(),
        );
    }
    blocks.push(format!(
        "<created_at>{}</created_at>",
        instant(now, int_of(detail, "createdAt").unwrap_or(0))
    ));
    blocks.push(format!(
        "<updated_at>{}</updated_at>",
        instant(now, int_of(detail, "updatedAt").unwrap_or(0))
    ));
    blocks
}

/// Node `pendingQuestionBlocks`: the question list, or the statement that it is unknown.
fn pending_block(detail: &Value, now: i64) -> Option<String> {
    if !questions_known(detail) {
        return Some(format!(
            "<pending_questions>{PENDING_QUESTIONS_UNKNOWN}</pending_questions>"
        ));
    }
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
            let asked = match int_of(question, "askedAt") {
                Some(at) => format!("asked {}", age(now, at)),
                None => "asked at an unknown time".to_owned(),
            };
            let mut lines = vec![
                format!(
                    "[{}] {} {asked}",
                    escape_xml(text_of(question, "qid").unwrap_or_default()),
                    escape_xml(who)
                ),
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

/// Node `holeBlocks`: each hole with its state and age, then the instruction for the waiting ones.
fn holes_block(detail: &Value, now: i64) -> Option<String> {
    let holes = entries(detail, "holes");
    if holes.is_empty() {
        return None;
    }
    let rendered: Vec<String> = holes
        .iter()
        .map(|hole| {
            // The journal does not carry a hole's type (divergence 437 of 9.42), so a hole may have none; then no type is written.
            let type_part = text_of(hole, "type")
                .map_or_else(String::new, |kind| format!(": {}", escape_xml(kind)));
            let head = format!(
                "[{}] \"{}\"{type_part}",
                escape_xml(text_of(hole, "siteId").unwrap_or_default()),
                escape_xml(text_of(hole, "name").unwrap_or_default()),
            );
            if text_of(hole, "state") == Some("waiting") {
                let when = int_of(hole, "since")
                    .map_or_else(String::new, |at| format!(" {}", bare_age(now, at)));
                format!("{head} — waiting{when}")
            } else {
                let when = int_of(hole, "filledAt")
                    .map_or_else(String::new, |at| format!(" {}", age(now, at)));
                let by = text_of(hole, "filledBy")
                    .map_or_else(String::new, |who| format!(" by {}", escape_xml(who)));
                format!("{head} — filled{when}{by}")
            }
        })
        .collect();
    let instruction = if waiting_holes(detail) == 0 {
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

/// Node `formatWorkflowRunHealthBlock`: the run's activity on one `key=value` row; a terminal run explains its leftover rows.
fn health_block(detail: &Value, terminal: bool, now: i64) -> String {
    let health = health(detail);
    let mut cells = Vec::new();
    if let Some(at) = int_of(health, "lastProgressAt") {
        cells.push(format!("last_progress={}", age(now, at)));
    }
    if let Some(concurrency) = health.get("concurrency") {
        let mut why = Vec::new();
        if let Some(reason) = text_of(concurrency, "reason") {
            why.push(escape_xml(reason));
        }
        if let Some(since) = int_of(concurrency, "since") {
            why.push(format!("since {}", age(now, since)));
        }
        let suffix = if why.is_empty() {
            String::new()
        } else {
            format!(" ({})", why.join(" "))
        };
        cells.push(format!(
            "concurrency={}/{}{suffix}",
            escaped(concurrency.get("effective").unwrap_or(&Value::Null)),
            escaped(concurrency.get("cap").unwrap_or(&Value::Null)),
        ));
    }
    if !terminal {
        let stalled = match int_of(health, "stalledSince") {
            Some(at) => format!("since {}", age(now, at)),
            None => "no".to_owned(),
        };
        cells.push(format!("stalled={stalled}"));
    }
    cells.push(format!(
        "consecutive_failures={}",
        int_of(health, "consecutiveFailures").unwrap_or(0)
    ));
    cells.push(format!(
        "cached_steps={}",
        int_of(health, "cachedSteps").unwrap_or(0)
    ));
    let leftover = if terminal {
        int_of(health, "leftoverRunning").unwrap_or(0)
    } else {
        0
    };
    let note = if leftover == 0 {
        String::new()
    } else {
        // Only an interrupted run (or one with no stop reason) lost its process; the others stopped themselves.
        let stop = match text_of(detail, "stopReason") {
            None | Some("interrupted") => "the exited process",
            Some(_) => "the ended run",
        };
        format!(
            "\nThe {leftover} \"running\" step{} below {} of {stop}, not live work.",
            plural(leftover as usize),
            if leftover == 1 {
                "is a leftover"
            } else {
                "are leftovers"
            }
        )
    };
    format!("<health>{}{note}</health>", join_cells(&cells))
}

/// Node `formatWorkflowRunPhasesBlock`: one row per phase, in declaration order; an `ahead` row has only its name and state.
fn phases_block(detail: &Value, terminal: bool, now: i64) -> Option<String> {
    let phases = entries(detail, "phases");
    if phases.is_empty() {
        return None;
    }
    let names: Vec<String> = phases
        .iter()
        .map(|phase| escape_xml(text_of(phase, "name").unwrap_or_default()))
        .collect();
    let states: Vec<String> = phases
        .iter()
        .map(|phase| text_of(phase, "state").unwrap_or_default().to_owned())
        .collect();
    let name_width = column_width(&names);
    let state_width = column_width(&states);
    let lines: Vec<String> = phases
        .iter()
        .enumerate()
        .map(|(index, phase)| {
            let rounds = int_of(phase, "rounds").unwrap_or(0);
            let running = int_of(phase, "nodesRunning").unwrap_or(0);
            let settled = int_of(phase, "nodesSettled").unwrap_or(0);
            let rounds_cell = if rounds == 0 {
                String::new()
            } else {
                format!("{rounds} round{}", plural(rounds as usize))
            };
            let counts_cell = if running > 0 {
                // "Still running" on a terminal run means unsettled, not active.
                format!(
                    "{settled} settled, {running} {}",
                    if terminal { "unfinished" } else { "running" }
                )
            } else if settled == 0 {
                String::new()
            } else {
                format!("{settled} step{} settled", plural(settled as usize))
            };
            let duration_cell = match int_of(phase, "enteredAt") {
                None => String::new(),
                Some(entered) => match int_of(phase, "exitedAt") {
                    Some(exited) => duration(exited - entered),
                    // A terminal run's exit time was not recorded: counting to now would count the time after it died.
                    None if terminal => String::new(),
                    None => format!("{} so far", duration(now - entered)),
                },
            };
            join_cells(&[
                format!("{}. {}", index + 1, pad(&names[index], name_width)),
                pad(&states[index], state_width),
                rounds_cell,
                counts_cell,
                duration_cell,
            ])
        })
        .collect();
    Some(format!("<phases>\n{}\n</phases>", lines.join("\n")))
}

/// Node `subagentActivityCell`: what a subagent is doing, by its state.
fn activity(subagent: &Value, now: i64, asked: &[(String, i64)]) -> String {
    let state = text_of(subagent, "state").unwrap_or_default();
    if let Some(qid) = text_of(subagent, "parkedOn").filter(|_| state == "parked") {
        let for_how = asked
            .iter()
            .find(|(id, _)| id == qid)
            .map_or_else(String::new, |(_, at)| {
                format!(" for {}", bare_age(now, *at))
            });
        return format!("on question {}{for_how}", escape_xml(qid));
    }
    if state == "waiting" {
        return wait_cell(subagent, now);
    }
    let current = subagent.get("currentAsk");
    match current {
        Some(ask) if state == "unfinished" => {
            format!("{} was in flight at the stop", ask_address(ask))
        }
        Some(ask) => executing_cell(ask, now),
        None => settled_cell(subagent),
    }
}

fn ask_address(ask: &Value) -> String {
    // The journal's actor sequence is zero-based; the model reads a one-based step number.
    let step =
        int_of(ask, "actorSeq").map_or_else(String::new, |seq| format!(" (step {})", seq + 1));
    format!(
        "{}@{}{step}",
        escape_xml(text_of(ask, "siteId").unwrap_or_default()),
        escaped(ask.get("ordinal").unwrap_or(&Value::Null))
    )
}

fn executing_cell(ask: &Value, now: i64) -> String {
    let mut parts = vec![ask_address(ask)];
    if let Some(at) = int_of(ask, "startedAt") {
        parts.push(format!("{} on this step", bare_age(now, at)));
    }
    if let Some(turn) = int_of(ask, "turn") {
        parts.push(format!("turn {turn}"));
    }
    if let Some(calls) = int_of(ask, "toolCalls") {
        parts.push(format!(
            "{calls} tool call{}",
            if calls == 1 { "" } else { "s" }
        ));
    }
    if let Some(tool) = ask.get("lastTool") {
        let target = text_of(tool, "target")
            .map_or_else(String::new, |target| format!(" {}", escape_xml(target)));
        let when = int_of(tool, "at").map_or_else(String::new, |at| format!(" {}", age(now, at)));
        parts.push(format!(
            "last {}{target}{when}",
            escape_xml(text_of(tool, "name").unwrap_or_default())
        ));
    }
    parts.join(", ")
}

fn wait_cell(subagent: &Value, now: i64) -> String {
    let Some(wait) = subagent.get("wait") else {
        return String::new();
    };
    let for_how = int_of(wait, "since").map_or_else(String::new, |since| {
        format!(" for {}", bare_age(now, since))
    });
    if text_of(wait, "cause") == Some("slot") {
        return format!("waiting for a slot{for_how}");
    }
    let after = text_of(wait, "reason").map_or_else(String::new, |reason| {
        format!(" after {}", escape_xml(reason))
    });
    let retry = int_of(wait, "retryAfterMs")
        .map_or_else(String::new, |ms| format!(", retry in {}", duration(ms)));
    format!("backoff{after}{for_how}{retry}")
}

fn settled_cell(subagent: &Value) -> String {
    let settled = int_of(subagent, "stepsSettled").unwrap_or(0);
    let failed_count = int_of(subagent, "stepsFailed").unwrap_or(0);
    if settled == 0 && failed_count == 0 {
        return String::new();
    }
    let failed = if failed_count > 0 {
        format!(", {failed_count} failed")
    } else {
        String::new()
    };
    format!("{settled} step{}{failed}", plural(settled as usize))
}

/// Node `formatWorkflowRunSubagentsBlock`: one row per subagent, and a task row under a row with a current ask.
fn subagents_block(detail: &Value, now: i64) -> String {
    let subagents = entries(detail, "subagents");
    if subagents.is_empty() {
        return NO_SUBAGENTS.to_owned();
    }
    let asked: Vec<(String, i64)> = entries(detail, "pendingQuestions")
        .iter()
        .filter_map(|question| {
            Some((
                text_of(question, "qid")?.to_owned(),
                int_of(question, "askedAt")?,
            ))
        })
        .collect();
    let names: Vec<String> = subagents
        .iter()
        .map(|subagent| escape_xml(text_of(subagent, "name").unwrap_or_default()))
        .collect();
    let addresses: Vec<String> = subagents
        .iter()
        .map(|subagent| {
            format!(
                "{}@{}",
                escape_xml(text_of(subagent, "siteId").unwrap_or_default()),
                escaped(subagent.get("ordinal").unwrap_or(&Value::Null))
            )
        })
        .collect();
    let states: Vec<String> = subagents
        .iter()
        .map(|subagent| text_of(subagent, "state").unwrap_or_default().to_owned())
        .collect();
    let (name_width, address_width, state_width) = (
        column_width(&names),
        column_width(&addresses),
        column_width(&states),
    );
    let mut lines = Vec::new();
    for (index, subagent) in subagents.iter().enumerate() {
        let tokens = int_of(subagent, "tokens").unwrap_or(0);
        let phase = text_of(subagent, "phaseName")
            .map_or_else(String::new, |phase| format!("phase {}", escape_xml(phase)));
        lines.push(join_cells(&[
            pad(&names[index], name_width),
            pad(&addresses[index], address_width),
            pad(&states[index], state_width),
            phase,
            activity(subagent, now, &asked),
            if tokens > 0 {
                format!("{} tokens", count(tokens))
            } else {
                String::new()
            },
        ]));
        if let Some(head) = subagent
            .get("currentAsk")
            .and_then(|ask| text_of(ask, "instructionsHead"))
            .filter(|head| !head.is_empty())
        {
            lines.push(format!("  task: {}", escape_xml(head)));
        }
    }
    let truncated = if bool_of(detail, "subagentsTruncated") == Some(true) {
        format!(
            "\nOnly the first {} subagents are listed; this run has more.",
            subagents.len()
        )
    } else {
        String::new()
    };
    format!("<subagents>\n{}{truncated}\n</subagents>", lines.join("\n"))
}

/// Node `formatWorkflowRunLogTailBlock`: the last log lines, each with its sequence, its age and its message.
fn log_tail_block(detail: &Value, now: i64) -> String {
    let logs = entries(detail, "logTail");
    if logs.is_empty() {
        return NO_LOG_TAIL.to_owned();
    }
    let lines: Vec<String> = logs
        .iter()
        .map(|entry| {
            join_cells(&[
                format!(
                    "[{}]",
                    escaped(entry.get("sequence").unwrap_or(&Value::Null))
                ),
                int_of(entry, "at").map_or_else(String::new, |at| age(now, at)),
                escape_xml(text_of(entry, "message").unwrap_or_default()),
            ])
        })
        .collect();
    format!("<log_tail>\n{}\n</log_tail>", lines.join("\n"))
}

/// The usage block: the spent tokens and the node counts the read carries. A count the read does not carry is left out.
fn usage_block(detail: &Value) -> String {
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
            .map(|value| format!("{name}={}", escaped(value)))
    })
    .collect();
    format!("<usage>{}</usage>", parts.join(" "))
}

/// Node `formatWorkflowProviderStopError`: the cause, the action, the facts and the raw message of a provider stop.
pub fn provider_stop_text(stop: &Value, run_id: &str) -> String {
    let provider_id = text_of(stop, "providerId");
    let provider_label = text_of(stop, "providerLabel");
    let provider = provider_label.or(provider_id).unwrap_or("the provider");
    let provider_ref = match (provider_label, provider_id) {
        (Some(label), Some(id)) => format!("{label} ({id})"),
        _ => provider.to_owned(),
    };
    let subagent_name = text_of(stop, "subagentName")
        .or_else(|| text_of(stop, "subagent"))
        .unwrap_or("a subagent");
    let phase =
        text_of(stop, "phase").map_or_else(String::new, |phase| format!(" (phase \"{phase}\")"));
    let model = text_of(stop, "modelId").unwrap_or("the current model");
    let code = stop
        .get("providerCode")
        .or_else(|| stop.get("reason"))
        .map_or_else(|| "undefined".to_owned(), field_text);
    let resume = format!("then call ResumeWorkflowRun with run_id=\"{run_id}\"");
    let (first, second) = match text_of(stop, "kind") {
        Some("auth") => (
            format!("Sign-in to {provider_ref} expired while subagent {subagent_name}{phase} was running."),
            format!("Ask the user to sign in to {provider} again, {resume}. Finished steps are kept."),
        ),
        Some("not_configured") => (
            format!(
                "Provider {} is not configured on this machine, so subagent {subagent_name}{phase} could not send its request.",
                provider_id.unwrap_or(provider)
            ),
            format!("Ask the user to configure the provider or switch this session to another model, {resume}."),
        ),
        Some("model_unavailable") => (
            format!("Model {model} is not available on {provider} (not in the user's plan, or retired)."),
            format!("Ask the user to switch this session to a model the plan includes, {resume}. Subagents follow the session's model."),
        ),
        Some("invalid_request") => (
            format!("{provider} rejected subagent {subagent_name}{phase}'s request as invalid (code {code})."),
            format!("Switching the session to another model usually clears this; {resume}. If it stops again with the same code, show the raw message to the user."),
        ),
        Some("quota") if stop.get("resetAt").is_some() => (
            format!(
                "{provider} reports the user's usage cap is reached (code {code}); it resets at {}.",
                int_of(stop, "resetAt").map_or_else(String::new, iso_from_ms)
            ),
            "ZCode resumes this run by itself a minute after the reset, while this session is open or the next time it is opened. Tell the user; do not call ResumeWorkflowRun before the reset, and do not rebuild the workflow.".to_owned(),
        ),
        Some("quota") => (
            format!("{provider} reports the user's quota is exhausted (code {code})."),
            format!("Ask the user to top up or upgrade the plan, or switch to another provider, {resume}."),
        ),
        _ => (
            format!("{provider} refused subagent {subagent_name}{phase}'s request with a permanent error (code {code})."),
            format!("Resolve it with the user (the raw message below says what the provider wants), {resume}."),
        ),
    };
    let facts = [
        format!("provider={}", provider_id.unwrap_or("unknown")),
        format!("model={}", text_of(stop, "modelId").unwrap_or("unknown")),
        format!(
            "subagent={}",
            text_of(stop, "subagent").unwrap_or("unknown")
        ),
    ]
    .into_iter()
    .chain(text_of(stop, "phase").map(|phase| format!("phase={phase}")))
    .chain(std::iter::once(format!("code={code}")))
    .collect::<Vec<_>>()
    .join(" ");
    let mut lines = vec![first, second, facts];
    if let Some(raw) = text_of(stop, "rawMessage") {
        lines.push(format!("raw: {raw}"));
    }
    lines.join("\n")
}

/// Node `outcomeBlocks`: the result verbatim, then the error, then the artifact index.
fn outcome_blocks(detail: &Value, run_id: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    if let Some(result) = detail.get("result") {
        // Node's `<result>` (`serializeWorkflowArtifact`): a string is the text itself, anything else its indented JSON.
        let body = rust_cli_kernel_api::workflow_notice_meta::artifact_text(result);
        blocks.push(format!("<result>\n{body}\n</result>"));
    }
    if let Some(error) = detail.get("error") {
        let body = match error.get("providerStop").filter(|stop| stop.is_object()) {
            // Verbatim, like the result: the copyable fragments (run_id="...") must not be escaped.
            Some(stop) => format!("\n{}\n", provider_stop_text(stop, run_id)),
            None => escape_xml(text_of(error, "message").unwrap_or_default()),
        };
        blocks.push(format!(
            "<error {}>{body}</error>",
            attribute("code", text_of(error, "code").unwrap_or_default())
        ));
    }
    let artifacts = entries(detail, "artifacts");
    if !artifacts.is_empty() {
        let lines: Vec<String> = artifacts
            .iter()
            .map(|artifact| {
                let id = text_of(artifact, "id").unwrap_or_default();
                let title = text_of(artifact, "title").unwrap_or(id);
                let primary = if bool_of(artifact, "primary") == Some(true) {
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
        blocks.push(format!(
            "<artifacts count=\"{}\">\n{}\n</artifacts>",
            artifacts.len(),
            lines.join("\n")
        ));
    }
    blocks
}

/// Node `formatResumableHint`: a stopped run's resume guidance, with the sentence for its stop reason.
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

/// Node `formatAmendableHint`: how to revise the script. A healthy running run gets one sentence; the rest get the reasoning.
fn amendable(detail: &Value) -> String {
    let run_id = escape_xml(text_of(detail, "runId").unwrap_or_default());
    let status = text_of(detail, "status").unwrap_or_default();
    let script_sentence = text_of(detail, "scriptPath").map_or_else(String::new, |path| {
        let path = escape_xml(path);
        format!(
            " Its script is at {path}: edit that file in place and pass `path: \"{path}\"` to AmendWorkflow instead of a script."
        )
    });
    if status == "running" && int_of(health(detail), "stalledSince").is_none() {
        return format!(
            "<amendable>AmendWorkflow with run_id \"{run_id}\" supersedes this run with a revised script and imports its finished work as cache.{script_sentence}</amendable>"
        );
    }
    let tail = match status {
        "errored" => {
            "This is the highest-value case for it: the script itself failed, so fix the script and re-run — every step that already succeeded is imported instead of being paid for a second time. Do NOT rewrite from scratch."
        }
        "completed" => {
            "Use it to extend or refine a finished workflow — added steps run live, unchanged ones cost nothing."
        }
        "stopped" => {
            "Use it when the script or a setting needs to change; use ResumeWorkflowRun to continue it unchanged. A run stopped because its script was wrong is amended now, not after the user asks: the cache holds everything that settled before the stop, and waiting buys nothing."
        }
        _ => {
            "It is still running: if the script is visibly wrong, amend it now — AmendWorkflow stops this run, imports everything that settled so far, and starts the revision in one call. Do not TaskStop it first and do not wait for it to finish."
        }
    };
    let body = [
        format!("This run can be superseded by a revised script: call AmendWorkflow with `run_id: \"{run_id}\"` and your new script."),
        "That mints a NEW run and imports this one's finished work as a warm cache — matched per named subagent along its conversation prefix — so steps you did not change settle from cache at zero tokens and only the revised part runs live.".to_owned(),
        "To change only its settings (max_concurrency, subagent_model, name), omit both `script` and `path`: the new run keeps this run's script.".to_owned(),
        tail.to_owned(),
    ]
    .join(" ");
    format!("<amendable>{body}{script_sentence}</amendable>")
}

/// The model's text for one run. `now` is the one clock reading of the call.
pub fn format_detail(detail: &Value, now: i64) -> String {
    let status = text_of(detail, "status").unwrap_or_default();
    let terminal = is_terminal(status);
    let run_id = text_of(detail, "runId").unwrap_or_default();
    let mut blocks = vec![format!(
        "<summary>{}</summary>",
        escape_xml(&summary(detail, now))
    )];
    blocks.extend(identity(detail, now));
    blocks.extend(pending_block(detail, now));
    blocks.extend(holes_block(detail, now));
    // A detail with no situation snapshot (the registry gap form, divergence 554) has no health to write: no zero is shown for it.
    if detail.get("health").is_some() {
        blocks.push(health_block(detail, terminal, now));
    }
    blocks.extend(phases_block(detail, terminal, now));
    blocks.push(subagents_block(detail, now));
    blocks.push(log_tail_block(detail, now));
    blocks.push(usage_block(detail));
    blocks.extend(outcome_blocks(detail, run_id));

    // Routing: a superseded run points only at its successor; a stopped run says how it may continue; every other run
    // says how it may be revised.
    if text_of(detail, "stopReason") == Some("superseded") {
        let successor = text_of(detail, "supersededBy").map_or_else(
            || "its successor".to_owned(),
            |id| format!("run {}", escape_xml(id)),
        );
        blocks.push(format!(
            "<superseded>This run was stopped by an AmendWorkflow and superseded by {successor}, which owns its unfinished work. Do not resume it (ResumeWorkflowRun will refuse) and do not amend it again; read or amend {successor} instead.</superseded>"
        ));
    } else {
        if status == "stopped" {
            blocks.push(resumable(detail));
        }
        blocks.push(amendable(detail));
    }
    blocks.join("\n\n")
}

#[cfg(test)]
#[path = "workflow_run_detail_tests.rs"]
mod tests;
