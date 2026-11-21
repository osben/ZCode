//! Fork (9.61): the GetWorkflowRun and ListWorkflowRuns result cards (Node `createGetWorkflowRunDisplay` and
//! `createListWorkflowRunsDisplay`, core `tool/executor/workflow-observation-display.ts`). The desktop parses both strictly
//! (`toolCallGetWorkflowRunDisplaySchema`, `toolCallListWorkflowRunsDisplaySchema`): one key outside the schema drops the
//! whole card to text. So every object is rebuilt from the schema's own keys, never passed through from the detail, whose
//! rows carry more (the pending questions, the script path, the persona).

use serde_json::{Map, Value, json};

/// Node `WORKFLOW_OBSERVATION_DISPLAY_MAX_*`.
const MAX_ACTORS: usize = 32;
const MAX_LOG_ENTRIES: usize = 40;
const MAX_LOG_BYTES: usize = 1_024;
const MAX_RESULT_BYTES: usize = 4_000;
const MAX_PHASES: usize = 32;
const MAX_SUBAGENTS: usize = 64;
/// Node `DISPLAY_TRUNCATION_SUFFIX`.
const TRUNCATION_SUFFIX: &str = "\n...[truncated]";

const USAGE_KEYS: [&str; 5] = [
    "spentTokens",
    "nodesObserved",
    "nodesRunning",
    "nodesCompleted",
    "nodesFailed",
];
const PHASE_KEYS: [&str; 7] = [
    "name",
    "state",
    "rounds",
    "nodesSettled",
    "nodesRunning",
    "enteredAt",
    "exitedAt",
];
const HEALTH_KEYS: [&str; 6] = [
    "lastProgressAt",
    "stalledSince",
    "consecutiveFailures",
    "cachedSteps",
    "leftoverRunning",
    "pendingQuestionsKnown",
];
const LIST_ROW_KEYS: [&str; 12] = [
    "runId",
    "label",
    "labelSource",
    "status",
    "stopReason",
    "ownedByThisSession",
    "possiblyInterrupted",
    "createdAt",
    "updatedAt",
    "spentTokens",
    "resumedFrom",
    "supersededBy",
];

/// The status card of one run's detail, read at `now` (the same reading as the model text, so the summary matches).
pub(crate) fn get_display(detail: &Value, now: i64) -> Value {
    let mut truncated = false;
    let mut card = Map::new();
    card.insert("kind".into(), json!("get_workflow_run"));
    copy(
        detail,
        &mut card,
        &["runId", "label", "status", "stopReason"],
    );
    if detail.get("possiblyInterrupted") == Some(&Value::Bool(true)) {
        card.insert("possiblyInterrupted".into(), Value::Bool(true));
    }
    card.insert(
        "summary".into(),
        Value::String(crate::workflow_run_detail::summary(detail, now)),
    );
    card.insert("generatedAt".into(), Value::from(now));
    card.insert("usage".into(), picked(detail.get("usage"), &USAGE_KEYS));
    let phases = list(detail, "phases");
    if !phases.is_empty() {
        truncated |= phases.len() > MAX_PHASES;
        let shown = phases.iter().take(MAX_PHASES);
        card.insert(
            "phases".into(),
            shown
                .map(|phase| picked(Some(phase), &PHASE_KEYS))
                .collect(),
        );
    }
    let subagents = list(detail, "subagents");
    truncated |= subagents.len() > MAX_SUBAGENTS
        || detail.get("subagentsTruncated") == Some(&Value::Bool(true));
    card.insert(
        "subagents".into(),
        subagents.iter().take(MAX_SUBAGENTS).map(subagent).collect(),
    );
    if let Some(health) = detail.get("health").filter(|health| health.is_object()) {
        let mut out = as_map(picked(Some(health), &HEALTH_KEYS));
        if let Some(concurrency) = health.get("concurrency").filter(|c| c.is_object()) {
            out.insert(
                "concurrency".into(),
                picked(Some(concurrency), &["effective", "cap", "reason", "since"]),
            );
        }
        card.insert("health".into(), Value::Object(out));
    }
    let actors = list(detail, "actors");
    truncated |= actors.len() > MAX_ACTORS;
    card.insert(
        "actors".into(),
        actors
            .iter()
            .take(MAX_ACTORS)
            .map(|actor| picked(Some(actor), &["siteId", "ordinal", "name"]))
            .collect(),
    );
    // The tail is kept: the latest progress matters most, so the head is dropped.
    let log = list(detail, "logTail");
    let skip = log.len().saturating_sub(MAX_LOG_ENTRIES);
    truncated |= skip > 0;
    let mut tail = Vec::new();
    for entry in &log[skip..] {
        let mut out = as_map(picked(Some(entry), &["sequence", "at"]));
        let message = entry
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let (message, cut) = bound(message, MAX_LOG_BYTES);
        truncated |= cut;
        out.insert("message".into(), Value::String(message));
        tail.push(order(out, &["sequence", "message", "at"]));
    }
    card.insert("logTail".into(), Value::Array(tail));
    if let Some(result) = detail.get("result") {
        let text = rust_cli_kernel_api::workflow_notice_meta::artifact_text(result);
        let (result, cut) = bound(&text, MAX_RESULT_BYTES);
        truncated |= cut;
        card.insert("result".into(), Value::String(result));
    }
    // The card's error is the code and the message only; the provider stop stays in the model text.
    if let Some(error) = detail.get("error").filter(|error| error.is_object()) {
        card.insert("error".into(), picked(Some(error), &["code", "message"]));
    }
    if truncated {
        card.insert("truncated".into(), Value::Bool(true));
    }
    Value::Object(card)
}

/// The list card of one page of runs.
pub(crate) fn list_display(page: &Value) -> Value {
    let runs: Vec<Value> = list(page, "runs")
        .iter()
        .map(|row| picked(Some(row), &LIST_ROW_KEYS))
        .collect();
    let mut card = Map::new();
    card.insert("kind".into(), json!("list_workflow_runs"));
    card.insert("runs".into(), Value::Array(runs));
    if page.get("truncated") == Some(&Value::Bool(true)) {
        card.insert("truncated".into(), Value::Bool(true));
    }
    Value::Object(card)
}

/// Node `toDisplaySubagent`: the nested ask and wait facts flattened into the row; an absent fact stays absent.
fn subagent(view: &Value) -> Value {
    let mut out = as_map(picked(
        Some(view),
        &["siteId", "ordinal", "name", "state", "phaseName"],
    ));
    if let Some(ask) = view.get("currentAsk") {
        copy(
            ask,
            &mut out,
            &["instructionsHead", "startedAt", "turn", "toolCalls"],
        );
        if let Some(tool) = ask.get("lastTool").filter(|tool| tool.is_object()) {
            out.insert(
                "lastTool".into(),
                picked(Some(tool), &["name", "target", "at"]),
            );
        }
    }
    if let Some(wait) = view.get("wait") {
        if let Some(cause) = wait.get("cause").filter(|cause| !cause.is_null()) {
            out.insert("waitCause".into(), cause.clone());
        }
        copy(wait, &mut out, &["retryAfterMs"]);
        if let Some(since) = wait.get("since").filter(|since| !since.is_null()) {
            out.insert("waitSince".into(), since.clone());
        }
    }
    copy(
        view,
        &mut out,
        &[
            "parkedOn",
            "stepsSettled",
            "stepsFailed",
            "tokens",
            "lastProgressAt",
        ],
    );
    Value::Object(out)
}

fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// The present, non-null `keys` of `from` copied into `to`.
fn copy(from: &Value, to: &mut Map<String, Value>, keys: &[&str]) {
    for key in keys {
        if let Some(value) = from.get(*key).filter(|value| !value.is_null()) {
            to.insert((*key).to_owned(), value.clone());
        }
    }
}

fn picked(from: Option<&Value>, keys: &[&str]) -> Value {
    let mut out = Map::new();
    if let Some(from) = from {
        copy(from, &mut out, keys);
    }
    Value::Object(out)
}

fn as_map(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `map` with `keys` first, in that order (the card's JSON reads like Node's literal).
fn order(mut map: Map<String, Value>, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = map.remove(*key) {
            out.insert((*key).to_owned(), value);
        }
    }
    out.extend(map);
    Value::Object(out)
}

/// Node `boundDisplayText`: within `max_bytes` UTF-8 bytes, the cut ending in the truncation suffix.
fn bound(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_owned(), false);
    }
    let budget = max_bytes.saturating_sub(TRUNCATION_SUFFIX.len());
    let mut end = 0;
    for (index, ch) in text.char_indices() {
        if index + ch.len_utf8() > budget {
            break;
        }
        end = index + ch.len_utf8();
    }
    (format!("{}{TRUNCATION_SUFFIX}", &text[..end]), true)
}

#[cfg(test)]
#[path = "workflow_observation_display_tests.rs"]
mod tests;
