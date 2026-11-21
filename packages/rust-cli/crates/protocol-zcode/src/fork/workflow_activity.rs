//! Fork: the sessions-index row's `workflowActivity` (Node `deriveSessionWorkflowActivity`, shared
//! `sessions-index-workflow-activity.ts`; specs/fork-rust-workflow-engine.md 9.61). The sidebar's run line under a
//! session title reads it: each run's name, status, phase lights, current phase and working agents, derived from the
//! session's `workflowRuns` and its `backgroundWorks`. A pure function with no clock.

use serde_json::{Map, Value, json};

/// Node `SESSION_WORKFLOW_ACTIVITY_MAX_RUNS`.
const MAX_RUNS: usize = 4;
/// Node `WORKFLOW_RUNS_LIMITS.maxPhases`.
const MAX_PHASES: usize = 32;
/// Node `WORKFLOW_RUNS_LIMITS.maxPhaseNameLength`, in UTF-16 units as JS counts them.
const MAX_PHASE_NAME: usize = 128;

/// Node `isSessionWorkflowRunLive`.
fn live(status: &str) -> bool {
    status == "pending" || status == "running"
}

fn status_of(run: &Map<String, Value>) -> &str {
    run.get("status")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// Node `isRunNodeRunning`: dispatched and waiting nodes do not count.
fn node_running(node: &Value) -> bool {
    matches!(
        node.get("phase").and_then(Value::as_str),
        Some("executing" | "repairing" | "nudged")
    )
}

/// Node `phaseNameMatches`: exact, or a prefix only when the station name reaches the length limit.
fn phase_name_matches(station: &str, stamp: &str) -> bool {
    station == stamp
        || (station.encode_utf16().count() >= MAX_PHASE_NAME && stamp.starts_with(station))
}

fn names_of(items: Option<&Value>, key: Option<&str>) -> Vec<String> {
    items
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| match key {
            Some(key) => item.get(key).and_then(Value::as_str),
            None => item.as_str(),
        })
        .map(str::to_owned)
        .collect()
}

fn waiting_holes(run: &Map<String, Value>) -> impl Iterator<Item = &str> {
    run.get("holes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|hole| hole.get("state").and_then(Value::as_str) == Some("waiting"))
        .filter_map(|hole| hole.get("name").and_then(Value::as_str))
}

/// Node `deriveSessionWorkflowPhases`.
fn phases(run: &Map<String, Value>) -> Vec<Value> {
    let entered = names_of(run.get("phases"), Some("name"));
    let current = run.get("currentPhase").and_then(Value::as_str);
    let waiting: Vec<&str> = waiting_holes(run).collect();
    let declared = names_of(run.get("phaseNames"), None);
    // "Alongside" and hole indexes point into the declared list only; the fallback list has another index space.
    let (names, alongside, holes) = if declared.is_empty() {
        let mut names = entered.clone();
        if let Some(current) = current
            && !entered.iter().any(|name| name == current)
        {
            names.push(current.to_owned());
        }
        (names, None, Vec::new())
    } else {
        let holes: Vec<u64> = run
            .get("phaseHoles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_u64)
            .collect();
        (
            declared,
            run.get("phaseAlongside").and_then(Value::as_array),
            holes,
        )
    };
    let status = status_of(run);
    let is_live = live(status);
    // No one works in a terminal run, even before its settled events are recorded.
    let burning: Vec<&str> = if is_live {
        run.get("nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|node| node_running(node))
            .filter_map(|node| node.get("phaseName").and_then(Value::as_str))
            .collect()
    } else {
        Vec::new()
    };
    let emitted = names.len().min(MAX_PHASES);
    names
        .iter()
        .take(MAX_PHASES)
        .enumerate()
        .map(|(index, name)| {
            let is_current = current == Some(name.as_str());
            let was_entered = is_current || entered.contains(name);
            let burning_here = burning.iter().any(|stamp| phase_name_matches(name, stamp));
            let light = if is_live {
                if is_current || burning_here {
                    "running"
                } else if was_entered {
                    "done"
                } else {
                    "pending"
                }
            } else if status == "errored" && is_current {
                "failed"
            } else if status != "completed" && is_current {
                // Stopped at the current phase: neither done nor failed.
                "pending"
            } else if was_entered {
                "done"
            } else {
                "pending"
            };
            let mut phase = json!({"name": name, "status": light});
            let beside: Vec<u64> = alongside
                .and_then(|table| table.get(index))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_u64)
                .filter(|other| (*other as usize) < emitted && *other as usize != index)
                .collect();
            if !beside.is_empty() {
                phase["alongside"] = json!(beside);
            }
            if waiting.contains(&name.as_str()) {
                phase["hole"] = json!("waiting");
            } else if holes.contains(&(index as u64)) {
                phase["hole"] = json!("open");
            }
            phase
        })
        .collect()
}

/// Node `summarizeRun`.
fn summarize(run: &Map<String, Value>, work: Option<&Value>) -> Value {
    let status = status_of(run);
    let mut summary = Map::new();
    let mut put = |key: &str, value: Value| {
        summary.insert(key.to_owned(), value);
    };
    put("runId", run.get("runId").cloned().unwrap_or(Value::Null));
    if let Some(call) = run.get("toolCallId").filter(|value| !value.is_null()) {
        put("toolCallId", call.clone());
    }
    if let Some(name) = work
        .and_then(|work| work.get("title"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        put("name", json!(name));
    }
    put("status", json!(status));
    if let Some(reason) = run.get("stopReason").filter(|value| !value.is_null()) {
        put("stopReason", reason.clone());
    }
    if let Some(started) = work
        .and_then(|work| work.get("startedAt"))
        .filter(|value| !value.is_null())
    {
        put("startedAt", started.clone());
    }
    put("phases", Value::Array(phases(run)));
    if let Some(current) = run.get("currentPhase").filter(|value| !value.is_null()) {
        put("currentPhase", current.clone());
    }
    let working = run
        .get("actors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|actor| actor.get("status").and_then(Value::as_str) == Some("running"))
        .count();
    put("agentsWorking", json!(working));
    if live(status)
        && let Some(hole) = waiting_holes(run).next()
    {
        put("waitingHole", json!(hole));
    }
    Value::Object(summary)
}

/// Node `deriveSessionWorkflowActivity`: the live runs first in start order, then the ended ones (latest `endedAt`
/// first, else the later run first), at most four. None when the session has no run, so the row leaves the key out.
pub fn activity(runs: &[Map<String, Value>], background_works: &Value) -> Option<Value> {
    if runs.is_empty() {
        return None;
    }
    // The last workflow work with the run's id wins, as Node's map does.
    let work_of = |run_id: Option<&str>| {
        background_works
            .as_array()
            .into_iter()
            .flatten()
            .rev()
            .filter(|work| work.get("kind").and_then(Value::as_str) == Some("workflow"))
            .find(|work| work.get("workId").and_then(Value::as_str) == run_id)
    };
    let mut live_runs = Vec::new();
    let mut settled = Vec::new();
    for (index, run) in runs.iter().enumerate() {
        let work = work_of(run.get("runId").and_then(Value::as_str));
        let summary = summarize(run, work);
        if live(status_of(run)) {
            live_runs.push(summary);
        } else {
            let ended = work
                .and_then(|work| work.get("endedAt"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            settled.push((summary, ended, index));
        }
    }
    settled.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.2.cmp(&a.2)));
    let runs: Vec<Value> = live_runs
        .into_iter()
        .chain(settled.into_iter().map(|(summary, _, _)| summary))
        .take(MAX_RUNS)
        .collect();
    Some(json!({"runs": runs}))
}

#[cfg(test)]
#[path = "workflow_activity_tests.rs"]
mod tests;
