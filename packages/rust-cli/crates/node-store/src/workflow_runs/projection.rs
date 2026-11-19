//! Projection hook for the `workflowRuns` snapshot key and its two deltas (W3, W7-0). Not called from
//! `protocol-zcode` yet: the gate is off, and the Rust server answers the empty snapshot for
//! `v4/conversation/workflowRuns` as it does today (`protocol-zcode/src/fork/methods.rs`).
//!
//! `LiveProjection` is the per-session holder the run service (W7-5) feeds. It keeps the current
//! snapshot, applies one event in place, and hands back the deltas for the Host to publish.

use serde_json::{Value, json};

use super::{Envelope, Limits, State, reduce};

/// The snapshot a client reads. With no run it is the empty answer Rust gives today, byte for byte.
pub fn snapshot(state: Option<&State>) -> Value {
    match state {
        Some(state) if !state.runs.is_empty() => state.to_value(),
        _ => json!({"runs": []}),
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

    /// A projection seeded from a state (a cold replay, `replay::replay_state`).
    pub fn from_state(state: State, limits: Limits) -> Self {
        Self { state, limits }
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
