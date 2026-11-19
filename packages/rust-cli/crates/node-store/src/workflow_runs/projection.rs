//! Projection hook for the `workflowRuns` snapshot key and its two deltas (W3, W7-0). Not called from
//! `protocol-zcode` yet: the gate is off, and the Rust server answers the empty snapshot for
//! `v4/conversation/workflowRuns` as it does today (`protocol-zcode/src/fork/methods.rs`).
//!
//! `LiveProjection` is the per-session holder the run service (W7-5) feeds. It keeps the current
//! snapshot, applies one event in place, and hands back the deltas for the Host to publish.

use serde_json::{Value, json};

use super::{Envelope, Limits, PRODUCTION, State, reduce};

/// The snapshot a client reads. With no run it is the empty answer Rust gives today, byte for byte.
pub fn snapshot(state: Option<&State>) -> Value {
    match state {
        Some(state) if !state.runs.is_empty() => state.to_value(),
        _ => json!({"runs": []}),
    }
}

/// Brings a seed to the reducer's precondition: each run has a unique string `runId` (the first
/// occurrence wins, as `reduce` finds a run by its first match), and at most `PRODUCTION.max_runs`
/// runs remain, the most recent ones, as the run-count cut keeps them. A seed in that shape is
/// returned unchanged in content. Runs that fail the id rule cannot be addressed by `reduce`, so the
/// holder drops them.
fn normalise_seed(state: State) -> State {
    let mut seen = std::collections::HashSet::new();
    let mut runs: Vec<super::js::Obj> = state
        .runs
        .into_iter()
        .filter(|run| match run.get("runId").and_then(Value::as_str) {
            Some(id) => seen.insert(id.to_string()),
            None => false,
        })
        .collect();
    if runs.len() > PRODUCTION.max_runs {
        let excess = runs.len() - PRODUCTION.max_runs;
        runs.drain(..excess);
    }
    State {
        revision: state.revision,
        runs,
    }
}

/// One session's live `workflowRuns` projection (W7-0). The state is owned here and changes only
/// through `apply`, so the deltas it returns take any consumer copy from one state to the next.
#[derive(Debug, Clone)]
pub struct LiveProjection {
    state: State,
    limits: Limits,
}

impl LiveProjection {
    /// An empty projection: no run, revision 0.
    pub fn new(limits: Limits) -> Self {
        Self::from_state(State::default(), limits)
    }

    /// A projection seeded from a state (a cold replay, `replay::replay_state`, or any other state).
    /// The seed is normalised to the reducer's precondition (see `normalise_seed`), so the deltas of
    /// the next event are exactly `delta::diff` between the seed and the new state.
    pub fn from_state(state: State, limits: Limits) -> Self {
        Self {
            state: normalise_seed(state),
            limits,
        }
    }

    /// The current state (the holder's own copy, not a snapshot).
    pub fn state(&self) -> &State {
        &self.state
    }

    /// The snapshot a client reads now (`snapshot`, over the current state).
    pub fn snapshot(&self) -> Value {
        snapshot(Some(&self.state))
    }

    /// Applies one progress event in place. Returns the deltas that take the previous state to the new
    /// one, or `None` for a semantic no-op (the state is then untouched).
    pub fn apply(&mut self, envelope: &Envelope) -> Option<Vec<Value>> {
        reduce(&mut self.state, envelope, &self.limits)
    }
}
