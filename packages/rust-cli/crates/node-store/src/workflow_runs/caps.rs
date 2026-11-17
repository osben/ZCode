//! Counters for evicted or rejected instances: the two run-level usage counters (Node's
//! `workflow-runs-caps.ts`) and the per-birth-phase grid (`workflow-runs-unlisted.ts`).

use serde_json::Value;

use super::Limits;
use super::js::{Obj, plain};

/// One birth-phase cell of `unlistedByPhase` (`WorkflowRunUnlistedPhase`), in schema field order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Bucket {
    pub phase_name: Option<String>,
    pub actors: i64,
    pub actors_settled: Option<i64>,
    pub actors_failed: Option<i64>,
    pub settled: i64,
}

/// `Partial` increment for one cell (`WorkflowRunUnlistedDelta`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct BucketDelta {
    pub actors: i64,
    pub actors_settled: i64,
    pub actors_failed: i64,
    pub settled: i64,
}

fn at_least_zero(value: i64) -> i64 {
    value.max(0)
}

impl Bucket {
    fn from_obj(obj: &Obj) -> Bucket {
        let int = |key: &str| obj.get(key).and_then(Value::as_i64);
        Bucket {
            phase_name: obj
                .get("phaseName")
                .and_then(Value::as_str)
                .map(str::to_string),
            actors: int("actors").unwrap_or(0),
            actors_settled: int("actorsSettled"),
            actors_failed: int("actorsFailed"),
            settled: int("settled").unwrap_or(0),
        }
    }

    fn to_obj(&self) -> Obj {
        let mut out = Obj::new();
        if let Some(name) = &self.phase_name {
            out.insert("phaseName".into(), Value::String(name.clone()));
        }
        out.insert("actors".into(), Value::from(self.actors));
        if let Some(value) = self.actors_settled {
            out.insert("actorsSettled".into(), Value::from(value));
        }
        if let Some(value) = self.actors_failed {
            out.insert("actorsFailed".into(), Value::from(value));
        }
        out.insert("settled".into(), Value::from(self.settled));
        out
    }
}

/// Reads `run.unlistedByPhase` (`None` = key absent).
pub fn read_buckets(run: &Obj) -> Option<Vec<Bucket>> {
    let array = run.get("unlistedByPhase")?.as_array()?;
    Some(
        array
            .iter()
            .filter_map(|value| plain(Some(value)))
            .map(Bucket::from_obj)
            .collect(),
    )
}

/// `withUnlistedBuckets`: an empty or absent table removes the key; an unchanged table is a no-op.
pub fn with_buckets(mut run: Obj, buckets: Option<Vec<Bucket>>) -> Obj {
    let current = read_buckets(&run);
    if buckets == current {
        return run;
    }
    match buckets {
        None => {
            run.shift_remove("unlistedByPhase");
        }
        Some(list) if list.is_empty() => {
            run.shift_remove("unlistedByPhase");
        }
        Some(list) => {
            let array = list
                .iter()
                .map(|bucket| Value::Object(bucket.to_obj()))
                .collect();
            run.insert("unlistedByPhase".into(), Value::Array(array));
        }
    }
    run
}

/// `addToUnlistedBucket`: adds a delta to the cell for a birth phase. A full table drops the detail
/// (run-level counts are still incremented by the caller). A cell that reaches zero is removed.
pub fn add_to_bucket(
    buckets: Option<Vec<Bucket>>,
    phase_name: Option<&str>,
    delta: BucketDelta,
    max_phases: usize,
) -> Option<Vec<Bucket>> {
    let current = buckets.clone().unwrap_or_default();
    let index = current
        .iter()
        .position(|bucket| bucket.phase_name.as_deref() == phase_name);
    if index.is_none() && current.len() > max_phases {
        return buckets.map(|_| current);
    }
    let base = index.map(|i| current[i].clone()).unwrap_or_default();
    let actors = at_least_zero(base.actors + delta.actors);
    let actors_settled =
        at_least_zero(base.actors_settled.unwrap_or(0) + delta.actors_settled).min(actors);
    let actors_failed =
        at_least_zero(base.actors_failed.unwrap_or(0) + delta.actors_failed).min(actors_settled);
    let settled = at_least_zero(base.settled + delta.settled);

    if actors == 0 && actors_settled == 0 && actors_failed == 0 && settled == 0 {
        return match index {
            None => buckets.map(|_| current),
            Some(position) => {
                let remaining: Vec<Bucket> = current
                    .into_iter()
                    .enumerate()
                    .filter(|(i, _)| *i != position)
                    .map(|(_, bucket)| bucket)
                    .collect();
                if remaining.is_empty() {
                    None
                } else {
                    Some(remaining)
                }
            }
        };
    }
    let merged = Bucket {
        phase_name: phase_name.map(str::to_string),
        actors,
        actors_settled: (actors_settled > 0).then_some(actors_settled),
        actors_failed: (actors_failed > 0).then_some(actors_failed),
        settled,
    };
    let mut next = current;
    match index {
        None => next.push(merged),
        Some(position) => next[position] = merged,
    }
    Some(next)
}

/// `countUnlistedInstance`: a rejected instance that advances the mark counts once at birth and once
/// at settlement (a cache-hit settlement is its own birth).
pub fn count_unlisted_instance(
    usage: Obj,
    rejected: bool,
    advances_water_mark: bool,
    event_type: &str,
    cached: bool,
) -> Obj {
    if !rejected || !advances_water_mark {
        return usage;
    }
    let settled = event_type == "node-settled";
    let born = event_type == "node-queued" || (settled && cached);
    if !born && !settled {
        return usage;
    }
    let current_unlisted = usage
        .get("nodesUnlisted")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let current_settled = usage
        .get("nodesUnlistedSettled")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let unlisted = current_unlisted + u64::from(born);
    let unlisted_settled = current_settled + u64::from(settled);
    let mut next = usage;
    if unlisted > 0 {
        next.insert("nodesUnlisted".into(), Value::from(unlisted));
    }
    if unlisted_settled > 0 {
        next.insert("nodesUnlistedSettled".into(), Value::from(unlisted_settled));
    }
    next
}

/// `discountUnlistedInstance`: an instance returning to the node table leaves the unlisted count.
/// Clamped at zero; the key is removed at zero.
pub fn discount_unlisted_instance(usage: Obj) -> Obj {
    let current = usage
        .get("nodesUnlisted")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if current == 0 {
        return usage;
    }
    let settled = usage.get("nodesUnlistedSettled").cloned();
    let mut head = usage;
    head.shift_remove("nodesUnlisted");
    head.shift_remove("nodesUnlistedSettled");
    if current > 1 {
        head.insert("nodesUnlisted".into(), Value::from(current - 1));
    }
    if let Some(value) = settled {
        head.insert("nodesUnlistedSettled".into(), value);
    }
    head
}

/// Limits used by the caps path (kept for the signature parity with Node's `WorkflowRunEntryLimits`).
pub fn phase_limit(limits: &Limits) -> usize {
    limits.max_phases
}
