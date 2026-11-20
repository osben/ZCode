//! Publisher rules for the `workflowRun.*` key-level deltas (W7-0): Node's `workflow-runs-legacy.ts`
//! (the clamp for consumers without `workflowRunDeltas`), `conversation-workflow-run-deltas.ts`
//! (encoding for those consumers, and the growth bound for the ingest fast path). Pure, as in Node:
//! the Host owns the subscriptions and calls these per batch.

use std::borrow::Cow;

use serde_json::{Value, json};

use super::State;
use super::js::{Obj, canonical};

/// `WORKFLOW_RUNS_LEGACY_LIMITS` (`maxActors` = `maxNodes` = 256): the bound older consumers validate.
pub const LEGACY_MAX_ENTRIES: usize = 256;

/// Headroom per batch for the JSON wrapper and for the decimal width of `seq`
/// (`WORKFLOW_RUN_DELTA_ENVELOPE_SLACK_BYTES`).
pub const ENVELOPE_SLACK_BYTES: usize = 64;

fn is_run_delta(op: &Value) -> bool {
    matches!(
        op.get("op").and_then(Value::as_str),
        Some("workflowRun.updated") | Some("workflowRun.removed")
    )
}

/// `clampWorkflowRunsForLegacy`: the state cut to the legacy bound, with `truncated` set on each cut
/// run. Borrowed when no run is over the bound (Node returns the same object).
///
/// Which entries stay: live ones first (actors not `completed`, nodes not `settled`), then the earliest
/// of the rest, in table order. The output keeps table order.
pub fn clamp_for_legacy(state: &State) -> Cow<'_, State> {
    let over = |run: &Obj| {
        ["actors", "nodes"].iter().any(|key| {
            run.get(*key)
                .and_then(Value::as_array)
                .is_some_and(|list| list.len() > LEGACY_MAX_ENTRIES)
        })
    };
    if !state.runs.iter().any(over) {
        return Cow::Borrowed(state);
    }
    let runs = state
        .runs
        .iter()
        .map(|run| {
            let mut out = run.clone();
            if !over(run) {
                return out;
            }
            let actors = slice_of(run, "actors");
            if let Some(kept) = clamp_keeping_live(actors, |actor| {
                actor.get("status").and_then(Value::as_str) != Some("completed")
            }) {
                out.insert("actors".into(), Value::Array(kept));
            }
            let nodes = slice_of(run, "nodes");
            if let Some(kept) = clamp_keeping_live(nodes, |node| {
                node.get("phase").and_then(Value::as_str) != Some("settled")
            }) {
                out.insert("nodes".into(), Value::Array(kept));
            }
            out.insert("truncated".into(), Value::Bool(true));
            canonical(out)
        })
        .collect();
    Cow::Owned(State {
        revision: state.revision,
        runs,
    })
}

fn slice_of<'a>(run: &'a Obj, key: &str) -> &'a [Value] {
    run.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// `clampKeepingLive`: `None` when the list is within the bound (kept as it is).
fn clamp_keeping_live(list: &[Value], is_live: impl Fn(&Value) -> bool) -> Option<Vec<Value>> {
    if list.len() <= LEGACY_MAX_ENTRIES {
        return None;
    }
    let mut kept = vec![false; list.len()];
    let mut count = 0usize;
    for (index, entry) in list.iter().enumerate() {
        if count >= LEGACY_MAX_ENTRIES {
            break;
        }
        if is_live(entry) {
            kept[index] = true;
            count += 1;
        }
    }
    for flag in kept.iter_mut() {
        if count >= LEGACY_MAX_ENTRIES {
            break;
        }
        if !*flag {
            *flag = true;
            count += 1;
        }
    }
    Some(
        list.iter()
            .zip(kept)
            .filter(|(_, keep)| *keep)
            .map(|(entry, _)| entry.clone())
            .collect(),
    )
}

/// `encodeConversationDeltasForLegacy`: for a consumer without `workflowRunDeltas`. A batch with no run
/// delta comes back as the same slice. Otherwise every run delta is dropped, and one whole-key
/// `state.updated{workflowRuns}` (the clamped current state) goes at the position of the last dropped
/// op. With no `workflowRuns` state there is nothing to replace, so the deltas are dropped only.
pub fn encode_for_legacy<'a>(ops: &'a [Value], state: Option<&State>) -> Cow<'a, [Value]> {
    let Some(last) = ops.iter().rposition(is_run_delta) else {
        return Cow::Borrowed(ops);
    };
    let replacement = state.map(|state| {
        json!({"op": "state.updated", "patch": {"workflowRuns": clamp_for_legacy(state).to_value()}})
    });
    let mut encoded = Vec::with_capacity(ops.len());
    for (index, op) in ops.iter().enumerate() {
        if !is_run_delta(op) {
            encoded.push(op.clone());
        } else if index == last
            && let Some(replacement) = &replacement
        {
            encoded.push(replacement.clone());
        }
    }
    Cow::Owned(encoded)
}

/// `workflowRunDeltaGrowthUpperBound`: the byte bound on how much the snapshot grew for this batch, or
/// `None` when the batch holds any op other than `workflowRun.updated` and `workflowRun.removed`.
///
/// The bound holds because `workflowRun.updated` writes into the snapshot only its own payload (the
/// header is replaced as a whole and an entry is upserted as a whole), and `workflowRun.removed` only
/// shrinks it. A whole-key `state.updated` is not a bound (it replaces the key, and the bytes it
/// replaces are not in its payload), so it returns `None`.
pub fn growth_upper_bound(ops: &[Value]) -> Option<usize> {
    if !ops.iter().all(is_run_delta) {
        return None;
    }
    let text = serde_json::to_string(ops).map_or(0, |text| text.len());
    Some(text + ENVELOPE_SLACK_BYTES)
}
