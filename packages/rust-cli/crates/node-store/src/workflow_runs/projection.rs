//! Projection hook for the `workflowRuns` snapshot key and its two deltas (W3). Not called from
//! `protocol-zcode` yet: the gate is off, and the Rust server answers the empty snapshot for
//! `v4/conversation/workflowRuns` as it does today (`protocol-zcode/src/fork/methods.rs`).

use serde_json::{Value, json};

use super::delta;
use super::{Envelope, Limits, State, reduce};

/// The snapshot a client reads. With no run it is the empty answer Rust gives today, byte for byte.
pub fn snapshot(state: Option<&State>) -> Value {
    match state {
        Some(state) if !state.runs.is_empty() => state.to_value(),
        _ => json!({"runs": []}),
    }
}

/// One progress event: the next state and the deltas that take the prior state to it. `None` when the
/// reducer reports no semantic change (no delta, no revision bump), as the Node projection does.
pub fn on_progress(
    prior: Option<&State>,
    envelope: &Envelope,
    limits: &Limits,
) -> Option<(State, Vec<Value>)> {
    let next = reduce(prior, envelope, limits)?;
    let ops = delta::diff(prior, &next);
    Some((next, ops))
}
