//! The production `RunConcurrency` over the process governor (W7-3; spec 9.12 items 3 and 21; Node
//! `workflow-concurrency-governor.ts`: `setRunBound`, `clearRunBound` and `subscribe`).
//!
//! The workflow crate names the governor through its port and does not depend on the model crate. This adapter is the
//! one place that joins them: a run's bound is the model governor's bound for the run's `RunId`, and a cap change is
//! handed to the run as the workflow's `ConcurrencyChange`, with the reason as Node writes it.
use std::sync::Arc;

use rust_cli_model::admission::RunId;
use rust_cli_model::governor::controller::ChangeReason;
use rust_cli_model::governor::{CapChange, Governor};
use rust_cli_workflow::model::ConcurrencyChange;
use rust_cli_workflow::run_concurrency::{ConcurrencyListener, RunConcurrency};

/// Node's `ConcurrencyChangeReason` for the controller's reason. `offpeak_queued` has no controller reason: the
/// controller does not model an off-peak queue.
pub fn wire_reason(reason: ChangeReason) -> &'static str {
    match reason {
        ChangeReason::RateLimited => "rate_limited",
        ChangeReason::Overloaded => "provider_overloaded",
        ChangeReason::Recovered => "recovered",
        ChangeReason::IdleReset => "idle_reset",
        ChangeReason::LimitLowered => "limit_lowered",
        ChangeReason::Seeded => "seeded",
    }
}

/// The governor's change as a run hears it: the key, the change's fields, and the reason as Node's string.
pub fn run_change(change: &CapChange) -> ConcurrencyChange {
    ConcurrencyChange {
        key: change.key.clone(),
        previous: u64::from(change.change.previous),
        next: u64::from(change.change.next),
        reason: wire_reason(change.change.reason).to_owned(),
        last_good: change.change.last_good.map(u64::from),
        last_bad: change.change.last_bad.map(u64::from),
        cooldown_ms: change.change.cooldown_ms,
    }
}

/// A run's bound as the governor takes it: a count of at least 1, saturated to the governor's `u32`.
pub fn governor_bound(bound: u64) -> u32 {
    u32::try_from(bound.max(1)).unwrap_or(u32::MAX)
}

/// The run's concurrency port over the process governor. Cheap to clone; the governor is shared by every run and the
/// main agent.
#[derive(Clone)]
pub struct GovernorRunConcurrency {
    governor: Arc<Governor>,
}

impl GovernorRunConcurrency {
    pub fn new(governor: Arc<Governor>) -> Self {
        Self { governor }
    }
}

impl RunConcurrency for GovernorRunConcurrency {
    fn set_run_bound(&self, run_id: &str, bound: u64) {
        self.governor
            .set_run_bound(&RunId::new(run_id), governor_bound(bound));
    }

    fn clear_run_bound(&self, run_id: &str) {
        self.governor.clear_run_bound(&RunId::new(run_id));
    }

    fn subscribe(&self, run_id: &str, listener: ConcurrencyListener) -> Box<dyn FnOnce() + Send> {
        let subscription =
            self.governor
                .subscribe(&RunId::new(run_id), move |change: &CapChange| {
                    listener(&run_change(change));
                });
        Box::new(move || subscription.unsubscribe())
    }
}

#[cfg(test)]
#[path = "workflow_governor_tests.rs"]
mod tests;
