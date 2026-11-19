//! The observation feed of an actor's ask (W7-3; Node `createActorModelActivity` in `workflow-driver-concurrency.ts`).
//!
//! The turn side reports what its actor's model requests do: a wait, an execution, a retry, a completed request, the
//! last tool. [`AskFeed`] turns those reports into [`FeedEvent`]s, once per change, as Node's observer does: a wait is
//! reported once per wait period, and the non-failure retries are not reported at all. The owner routes each event to
//! its engine call (`ActorDriverOwner::feed`), and the mailbox carries them from the turn side (`ActorHandle::feed`).
//!
//! Node aggregates a set of in-flight request chains per actor. A Rust ask has one model request at a time (the turn
//! loop waits for its turn), so the chain set is one state, and a completed request ends the period with no further
//! wait report (spec 9.15's divergence list, W7-3).
use crate::event::LastTool;
use crate::model::{AskWait, WaitCause};
use rust_cli_kernel_api::model::{ModelError, ModelNotice};
use rust_cli_kernel_api::workflow_failure::facts_of;

/// Node `NON_FAILURE_RETRY_REASONS`: retries that are not provider failures. They neither wait nor count for the stall
/// clock.
const NON_FAILURE_RETRY_REASONS: &[&str] = &["reasoning_signature_repair", "auth_refresh"];

/// One observation of an actor's ask, as the owner takes it.
#[derive(Debug, Clone, PartialEq)]
pub enum FeedEvent {
    /// Node `askWaiting`: the ask's next model request waits, for a slot or in backoff.
    Waiting(AskWait),
    /// Node `askExecuting`: the ask's model request was sent.
    Executing,
    /// Node `model_retry_scheduled`: a retry with this reason is scheduled (the run-level stall clock counts it).
    RetryScheduled(String),
    /// Node `model_request_completed`: a model request of the actor succeeded (the stall clock resets).
    RequestCompleted,
    /// Node `lastTool`: the tool the ask most recently started.
    LastTool(LastTool),
}

/// The per-ask state of the observer: what has been reported, so that a repeated observation is not reported again.
#[derive(Debug, Default)]
pub struct AskFeed {
    executing: bool,
    reported_wait: Option<AskWait>,
}

impl AskFeed {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new ask starts with no reported state (Node `reset`).
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// The ask's next request waits. Reported once per wait period: an identical wait is not reported again, and an
    /// executing observation starts a new period (Node `reportWaiting`).
    pub fn waiting(&mut self, wait: AskWait) -> Option<FeedEvent> {
        self.executing = false;
        if self.reported_wait.as_ref() == Some(&wait) {
            return None;
        }
        self.reported_wait = Some(wait.clone());
        Some(FeedEvent::Waiting(wait))
    }

    /// The ask's request was sent. Reported on the transition only (Node `reportExecuting`).
    pub fn executing(&mut self) -> Option<FeedEvent> {
        self.reported_wait = None;
        if self.executing {
            return None;
        }
        self.executing = true;
        Some(FeedEvent::Executing)
    }

    /// A retry was scheduled for `reason`, at `attempt`, after `delay_ms` (with the Retry-After, when the provider gave
    /// one). Node `model_retry_scheduled`: the reason counts for the stall clock, then the ask waits in backoff. The
    /// non-failure reasons produce nothing.
    pub fn retry(
        &mut self,
        reason: &str,
        attempt: u64,
        delay_ms: u64,
        retry_after_ms: Option<u64>,
    ) -> Vec<FeedEvent> {
        if NON_FAILURE_RETRY_REASONS.contains(&reason) {
            return Vec::new();
        }
        let mut events = vec![FeedEvent::RetryScheduled(reason.to_owned())];
        let wait = AskWait {
            cause: WaitCause::Backoff,
            reason: Some(reason.to_owned()),
            attempt: Some(attempt),
            delay_ms: Some(delay_ms),
            retry_after_ms,
        };
        events.extend(self.waiting(wait));
        events
    }

    /// One notice of the model stream, as the observer reads it. A `Retrying` notice names the attempt that failed, so
    /// Node's `nextAttempt` is one more; its reason is the workflow policy table's reason for the error. `Resumed` is
    /// the request running again. A stall has no Node counterpart and reports nothing.
    pub fn notice(&mut self, notice: &ModelNotice) -> Vec<FeedEvent> {
        match notice {
            ModelNotice::Retrying {
                attempt,
                delay_ms,
                error,
                ..
            } => {
                let reason = facts_of(error).reason.to_owned();
                self.retry(
                    &reason,
                    u64::from(*attempt) + 1,
                    *delay_ms,
                    retry_after_of(error),
                )
            }
            ModelNotice::Resumed => self.executing().into_iter().collect(),
            ModelNotice::Stalled { .. } => Vec::new(),
        }
    }
}

/// The Retry-After a rate-limit error carries. Other errors carry none here (an overload's header is read by the
/// governor, not by the observer).
fn retry_after_of(error: &ModelError) -> Option<u64> {
    match error.peel() {
        ModelError::RateLimited { retry_after_ms, .. } => *retry_after_ms,
        _ => None,
    }
}
