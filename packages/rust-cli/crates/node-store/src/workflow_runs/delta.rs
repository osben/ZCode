//! Key-level deltas for `workflowRuns` (Node's `workflow-runs-delta.ts`): `diff` (producer), `apply`
//! (consumer) and the canonical key order.
//!
//! Contract, checked by the property test: for any pair (prior, next) the reducer produces,
//! `serialize(apply(prior, diff(prior, next))) == serialize(next)`, byte for byte.
//!
//! Not ported in W3: `mergeWorkflowRunUpdates` and `workflowRunUpdateWithinWireBounds`. They belong
//! to the publisher's coalescing (rule 6), which lands with the engine's publish path.

use serde_json::{Value, json};

use super::State;
use super::js::{InstanceRef, Obj, canonical, entry_key, entry_ref, json_equal, plain};

/// Header keys: the run minus the two incrementally synchronised tables, in schema order.
const HEADER_KEYS: &[&str] = &[
    "runId",
    "toolCallId",
    "status",
    "stopReason",
    "resumedFrom",
    "supersededBy",
    "usage",
    "error",
    "resumable",
    "resultPreview",
    "reports",
    "pendingQuestions",
    "concurrency",
    "concurrencyCeiling",
    "subagentModel",
    "artifacts",
    "phases",
    "currentPhase",
    "phaseNames",
    "phaseAlongside",
    "phaseHoles",
    "holes",
    "unlistedByPhase",
    "truncated",
    "lastEventSequence",
];

/// Keys a header needs before an unknown run can be born (the schema's non-optional ones).
const REQUIRED_HEADER_KEYS: &[&str] = &["runId", "status", "usage", "lastEventSequence"];

/// `isCompleteWorkflowRunHeader`.
pub fn is_complete_header(header: &Value) -> bool {
    match header.as_object() {
        Some(record) => REQUIRED_HEADER_KEYS
            .iter()
            .all(|key| record.get(*key).is_some_and(|v| !v.is_null())),
        None => false,
    }
}

/// Result of diffing one run: a delta, nothing to send, or an unrepresentable change.
pub(super) enum RunDiff {
    Op(Value),
    NoChange,
    WholeKey,
}

/// The `workflowRun.removed` op for one run (shared by `diff` and the in-place reducer, so the key
/// order is the same in both).
pub(super) fn removed_op(run_id: &str, revision: u64) -> Value {
    json!({"op": "workflowRun.removed", "runId": run_id, "revision": revision})
}

fn birth_op(run: &Obj, revision: u64) -> Value {
    let mut patch = Obj::new();
    for key in HEADER_KEYS {
        if let Some(value) = run.get(*key) {
            patch.insert((*key).to_string(), value.clone());
        }
    }
    let mut op = Obj::new();
    op.insert("op".into(), json!("workflowRun.updated"));
    op.insert(
        "runId".into(),
        run.get("runId").cloned().unwrap_or(Value::Null),
    );
    op.insert("revision".into(), json!(revision));
    op.insert("run".into(), Value::Object(patch));
    let actors = run
        .get("actors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let nodes = run
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !actors.is_empty() {
        op.insert("actors".into(), Value::Array(actors));
    }
    if !nodes.is_empty() {
        op.insert("nodes".into(), Value::Array(nodes));
    }
    Value::Object(op)
}

/// `EntryDiff`: removed identities, and changed entries in next order.
struct EntryDiff {
    removed: Vec<InstanceRef>,
    changed: Vec<Value>,
}

fn entries(run: &Obj, key: &str) -> Vec<Obj> {
    run.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}

/// `diffWorkflowRunEntries`: index fast path, then a key-based path for eviction. `None` means a
/// reorder or an unrepresentable change (resend the whole key).
fn diff_entries(before: &[Obj], after: &[Obj]) -> Result<Option<EntryDiff>, ()> {
    if before.len() <= after.len() {
        let mut changed = Vec::new();
        let mut aligned = true;
        for (index, entry) in after.iter().enumerate() {
            match before.get(index) {
                None => changed.push(Value::Object(entry.clone())),
                Some(previous) => {
                    if entry_ref(previous) != entry_ref(entry) {
                        aligned = false;
                        break;
                    }
                    if !json_equal(
                        &Value::Object(previous.clone()),
                        &Value::Object(entry.clone()),
                    ) {
                        changed.push(Value::Object(entry.clone()));
                    }
                }
            }
        }
        if aligned {
            return Ok(if changed.is_empty() {
                None
            } else {
                Some(EntryDiff {
                    removed: Vec::new(),
                    changed,
                })
            });
        }
    }
    diff_entries_by_key(before, after)
}

fn diff_entries_by_key(before: &[Obj], after: &[Obj]) -> Result<Option<EntryDiff>, ()> {
    let survives: std::collections::HashSet<String> = after
        .iter()
        .filter_map(entry_ref)
        .map(|r| r.key())
        .collect();
    let mut removed = Vec::new();
    let mut survivors: Vec<&Obj> = Vec::new();
    for entry in before {
        let Some(reference) = entry_ref(entry) else {
            return Err(());
        };
        if survives.contains(&reference.key()) {
            survivors.push(entry);
        } else {
            removed.push(reference);
        }
    }
    if survivors.len() > after.len() {
        return Err(());
    }
    let mut changed = Vec::new();
    for (index, entry) in after.iter().enumerate() {
        let Some(previous) = survivors.get(index) else {
            changed.push(Value::Object(entry.clone()));
            continue;
        };
        if entry_ref(previous) != entry_ref(entry) {
            return Err(());
        }
        if !json_equal(
            &Value::Object((*previous).clone()),
            &Value::Object(entry.clone()),
        ) {
            changed.push(Value::Object(entry.clone()));
        }
    }
    if removed.is_empty() && changed.is_empty() {
        return Ok(None);
    }
    Ok(Some(EntryDiff { removed, changed }))
}

/// `diffWorkflowRun`: the change of one run. `before` is `None` for a run that is being born.
pub(super) fn diff_run(before: Option<&Obj>, run: &Obj, revision: u64) -> RunDiff {
    let Some(before) = before else {
        return RunDiff::Op(birth_op(run, revision));
    };
    let mut patch = Obj::new();
    let mut cleared: Vec<Value> = Vec::new();
    for key in HEADER_KEYS {
        let left = before.get(*key);
        let right = run.get(*key);
        match (left, right) {
            (None, None) => {}
            (Some(_), None) => cleared.push(json!(key)),
            (Some(l), Some(r)) if json_equal(l, r) => {}
            (_, Some(r)) => {
                patch.insert((*key).to_string(), r.clone());
            }
        }
    }
    let actors = match diff_entries(&entries(before, "actors"), &entries(run, "actors")) {
        Ok(value) => value,
        Err(()) => return RunDiff::WholeKey,
    };
    let nodes = match diff_entries(&entries(before, "nodes"), &entries(run, "nodes")) {
        Ok(value) => value,
        Err(()) => return RunDiff::WholeKey,
    };
    let changed_header = !patch.is_empty() || !cleared.is_empty();
    if !changed_header && actors.is_none() && nodes.is_none() {
        return RunDiff::NoChange;
    }
    let mut op = Obj::new();
    op.insert("op".into(), json!("workflowRun.updated"));
    op.insert(
        "runId".into(),
        run.get("runId").cloned().unwrap_or(Value::Null),
    );
    op.insert("revision".into(), json!(revision));
    if !patch.is_empty() {
        op.insert("run".into(), Value::Object(patch));
    }
    if !cleared.is_empty() {
        op.insert("cleared".into(), Value::Array(cleared));
    }
    if let Some(actors) = &actors
        && !actors.removed.is_empty()
    {
        op.insert("removedActors".into(), refs_value(&actors.removed));
    }
    if let Some(nodes) = &nodes
        && !nodes.removed.is_empty()
    {
        op.insert("removedNodes".into(), refs_value(&nodes.removed));
    }
    if let Some(actors) = &actors
        && !actors.changed.is_empty()
    {
        op.insert("actors".into(), Value::Array(actors.changed.clone()));
    }
    if let Some(nodes) = &nodes
        && !nodes.changed.is_empty()
    {
        op.insert("nodes".into(), Value::Array(nodes.changed.clone()));
    }
    RunDiff::Op(Value::Object(op))
}

fn refs_value(refs: &[InstanceRef]) -> Value {
    Value::Array(
        refs.iter()
            .map(|r| json!({"siteId": r.site_id, "ordinal": r.to_value().get("ordinal").cloned().unwrap_or(Value::Null)}))
            .collect(),
    )
}

/// The whole-key fallback: one `state.updated{workflowRuns}` that replaces the key.
pub(super) fn whole_key(next: &State) -> Vec<Value> {
    vec![json!({"op": "state.updated", "patch": {"workflowRuns": next.to_value()}})]
}

/// `diffWorkflowRunsState`: the ops that take `prior` to `next`. Falls back to one whole-key
/// `state.updated` for an unrepresentable change.
pub fn diff(prior: Option<&State>, next: &State) -> Vec<Value> {
    let prior_runs: &[Obj] = prior.map(|state| state.runs.as_slice()).unwrap_or(&[]);
    let next_ids: std::collections::HashSet<&str> = next
        .runs
        .iter()
        .filter_map(|run| run.get("runId").and_then(Value::as_str))
        .collect();
    let mut ops = Vec::new();
    for run in prior_runs {
        let id = run.get("runId").and_then(Value::as_str).unwrap_or_default();
        if next_ids.contains(id) {
            continue;
        }
        ops.push(removed_op(id, next.revision));
    }
    for run in &next.runs {
        let id = run.get("runId").and_then(Value::as_str).unwrap_or_default();
        let before = prior_runs
            .iter()
            .find(|candidate| candidate.get("runId").and_then(Value::as_str) == Some(id));
        match diff_run(before, run, next.revision) {
            RunDiff::Op(op) => ops.push(op),
            RunDiff::NoChange => {}
            RunDiff::WholeKey => return whole_key(next),
        }
    }
    let prior_revision = prior.map(|state| state.revision as i128).unwrap_or(-1);
    if ops.is_empty() && prior_revision != next.revision as i128 {
        return whole_key(next);
    }
    ops
}

/// Applies a sequence of deltas, in order. A `state.updated` replaces the whole key.
pub fn apply_all(prior: Option<&State>, ops: &[Value]) -> Option<State> {
    let mut state = prior.cloned();
    for op in ops {
        match op.get("op").and_then(Value::as_str) {
            Some("workflowRun.updated") => state = Some(apply_updated(state.as_ref(), op)),
            Some("workflowRun.removed") => state = Some(apply_removed(state.as_ref(), op)),
            // Node assigns `patch.workflowRuns` as it is and leaves the key alone when the patch has none.
            // A value this port cannot hold keeps the prior state rather than emptying it.
            Some("state.updated") => {
                if let Some(next) = op
                    .get("patch")
                    .and_then(|patch| patch.get("workflowRuns"))
                    .and_then(State::from_value)
                {
                    state = Some(next);
                }
            }
            _ => {}
        }
    }
    state
}

fn remove_entries(current: &[Obj], removed: Option<&Value>) -> Vec<Obj> {
    let Some(removed) = removed.and_then(Value::as_array) else {
        return current.to_vec();
    };
    if removed.is_empty() {
        return current.to_vec();
    }
    let dropped: std::collections::HashSet<String> = removed
        .iter()
        .filter_map(|r| {
            let site = r.get("siteId")?.as_str()?;
            let ordinal = super::js::js_number(r.get("ordinal"))?;
            Some(entry_key(site, ordinal))
        })
        .collect();
    current
        .iter()
        .filter(|entry| !entry_ref(entry).is_some_and(|r| dropped.contains(&r.key())))
        .cloned()
        .collect()
}

fn upsert_entries(current: &[Obj], incoming: &[Value]) -> Vec<Obj> {
    let mut next = current.to_vec();
    for value in incoming {
        let Some(entry) = value.as_object() else {
            continue;
        };
        match next
            .iter()
            .position(|item| entry_ref(item) == entry_ref(entry))
        {
            Some(index) => next[index] = entry.clone(),
            None => next.push(entry.clone()),
        }
    }
    next
}

/// `applyWorkflowRunUpdated`.
pub fn apply_updated(state: Option<&State>, delta: &Value) -> State {
    let runs: Vec<Obj> = state.map(|s| s.runs.clone()).unwrap_or_default();
    let revision = state
        .map(|s| s.revision)
        .unwrap_or(0)
        .max(delta.get("revision").and_then(Value::as_u64).unwrap_or(0));
    let run_id = delta
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let index = runs
        .iter()
        .position(|run| run.get("runId").and_then(Value::as_str) == Some(run_id));
    let header = delta.get("run").cloned().unwrap_or(Value::Null);
    match index {
        None => {
            if !is_complete_header(&header) {
                return match state {
                    Some(s) if s.revision == revision => s.clone(),
                    _ => State { revision, runs },
                };
            }
            let mut born = plain(Some(&header)).cloned().unwrap_or_default();
            born.insert(
                "actors".into(),
                delta.get("actors").cloned().unwrap_or_else(|| json!([])),
            );
            born.insert(
                "nodes".into(),
                delta.get("nodes").cloned().unwrap_or_else(|| json!([])),
            );
            let born = canonical(born);
            let mut next = runs;
            next.push(born);
            State {
                revision,
                runs: next,
            }
        }
        Some(index) => {
            let mut merged = runs[index].clone();
            if let Some(patch) = plain(delta.get("run")) {
                for (key, value) in patch {
                    merged.insert(key.clone(), value.clone());
                }
            }
            for key in delta
                .get("cleared")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(name) = key.as_str() {
                    merged.shift_remove(name);
                }
            }
            let actors = remove_entries(&entries(&merged, "actors"), delta.get("removedActors"));
            let nodes = remove_entries(&entries(&merged, "nodes"), delta.get("removedNodes"));
            let mut actors_value = actors;
            let mut nodes_value = nodes;
            if let Some(incoming) = delta.get("actors").and_then(Value::as_array)
                && !incoming.is_empty()
            {
                actors_value = upsert_entries(&actors_value, incoming);
            }
            if let Some(incoming) = delta.get("nodes").and_then(Value::as_array)
                && !incoming.is_empty()
            {
                nodes_value = upsert_entries(&nodes_value, incoming);
            }
            merged.insert(
                "actors".into(),
                Value::Array(actors_value.into_iter().map(Value::Object).collect()),
            );
            merged.insert(
                "nodes".into(),
                Value::Array(nodes_value.into_iter().map(Value::Object).collect()),
            );
            let mut next = runs;
            next[index] = canonical(merged);
            State {
                revision,
                runs: next,
            }
        }
    }
}

/// `applyWorkflowRunRemoved`.
pub fn apply_removed(state: Option<&State>, delta: &Value) -> State {
    let runs: Vec<Obj> = state.map(|s| s.runs.clone()).unwrap_or_default();
    let revision = state
        .map(|s| s.revision)
        .unwrap_or(0)
        .max(delta.get("revision").and_then(Value::as_u64).unwrap_or(0));
    let run_id = delta
        .get("runId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let remaining: Vec<Obj> = runs
        .iter()
        .filter(|run| run.get("runId").and_then(Value::as_str) != Some(run_id))
        .cloned()
        .collect();
    if remaining.len() == runs.len() {
        return match state {
            Some(s) if s.revision == revision => s.clone(),
            _ => State { revision, runs },
        };
    }
    State {
        revision,
        runs: remaining,
    }
}
