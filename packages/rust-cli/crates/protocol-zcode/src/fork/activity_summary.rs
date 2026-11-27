//! Fork (upstream 4.0.0 parity, specs/fork-rust-activity-summary.md): the Activity capsule's
//! `activitySummaryDismissed` boundary (Node `product-projection.ts`). The session's `Live` state owns the value;
//! these are its rules over the facts the session shows.
use std::collections::HashSet;

use serde_json::{Map, Value, json};

/// What the session shows right now: its `backgroundWorks`, its `subagents` manifest and its workflow runs.
pub(crate) struct Facts<'a> {
    pub(crate) works: &'a Value,
    pub(crate) subagents: &'a Value,
    pub(crate) runs: &'a [Map<String, Value>],
}

/// Rule 2: the deltas appended a real user input row (a typed message or a guided steer). Rows are only created
/// by `row.appended`; an upsert changes a row that already had its turn.
pub(crate) fn is_new_real_input(deltas: &[Value]) -> bool {
    deltas.iter().any(|delta| {
        delta["op"] == "row.appended"
            && delta["row"]["kind"] == "userInput"
            && delta["row"]["origin"] == "realUser"
    })
}

/// Rule 2: the boundary at `at`: every work, child and run of the session that is not running.
pub(crate) fn dismissed(at: u64, facts: &Facts<'_>) -> Value {
    let running = running_children(facts);
    let work_ids: Vec<&str> = items(facts.works)
        .filter(|work| work["status"] != "running")
        .filter_map(|work| work["workId"].as_str())
        .collect();
    let subagent_ids: Vec<&str> = items(&facts.subagents["childSessionIds"])
        .filter_map(Value::as_str)
        .filter(|id| !running.contains(id))
        .collect();
    let run_ids: Vec<&str> = facts
        .runs
        .iter()
        .filter(|run| !run_is_live(run))
        .filter_map(|run| run.get("runId").and_then(Value::as_str))
        .collect();
    json!({
        "at": at,
        "workIds": work_ids,
        "subagentIds": subagent_ids,
        "workflowRunIds": run_ids,
    })
}

/// Rule 5: the cold boundary at `at` from the stored facts. `ended` are the ended children of the active branch,
/// `runs` the journaled runs as `(runId, physical status, last event or update time in ms)`. An item is in it when it
/// had ended by `at`; background works are never stored, so `workIds` is empty.
pub(crate) fn cold_dismissed(
    at: u64,
    ended: &[crate::fork::subagents::EndedOutcome],
    runs: &[(String, String, i64)],
) -> Value {
    let subagent_ids: Vec<&str> = ended
        .iter()
        .filter(|item| item.completed_at.unwrap_or(item.ended_at) <= at)
        .map(|item| item.child.as_str())
        .collect();
    let run_ids: Vec<&str> = runs
        .iter()
        .filter(|(_, status, updated_at)| {
            status != "running"
                && status != "pending"
                && u64::try_from(*updated_at).is_ok_and(|time| time <= at)
        })
        .map(|(run_id, _, _)| run_id.as_str())
        .collect();
    json!({
        "at": at,
        "workIds": [],
        "subagentIds": subagent_ids,
        "workflowRunIds": run_ids,
    })
}

/// Rule 3: the boundary without the ids that run again; `None` when none does.
pub(crate) fn without_running(boundary: &Value, facts: &Facts<'_>) -> Option<Value> {
    let works: HashSet<&str> = items(facts.works)
        .filter(|work| work["status"] == "running")
        .filter_map(|work| work["workId"].as_str())
        .collect();
    let children = running_children(facts);
    let runs: HashSet<&str> = facts
        .runs
        .iter()
        .filter(|run| run_is_live(run))
        .filter_map(|run| run.get("runId").and_then(Value::as_str))
        .collect();
    let mut next = boundary.clone();
    let mut changed = false;
    for (key, live) in [
        ("workIds", &works),
        ("subagentIds", &children),
        ("workflowRunIds", &runs),
    ] {
        if let Some(ids) = next.get_mut(key).and_then(Value::as_array_mut) {
            let before = ids.len();
            ids.retain(|id| !id.as_str().is_some_and(|id| live.contains(id)));
            changed |= ids.len() != before;
        }
    }
    changed.then_some(next)
}

fn items(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn running_children<'a>(facts: &Facts<'a>) -> HashSet<&'a str> {
    items(&facts.subagents["running"])
        .filter_map(|child| child["childSessionId"].as_str())
        .collect()
}

fn run_is_live(run: &Map<String, Value>) -> bool {
    matches!(
        run.get("status").and_then(Value::as_str),
        Some("running" | "pending")
    )
}

#[cfg(test)]
#[path = "activity_summary_tests.rs"]
mod tests;
