//! The workflow's model-failure handling (W6b part 3; Node `workflow-driver-model-failure.ts` and
//! `workflow-driver-helpers.ts`'s backoff).
//!
//! The policy is the kernel-api table ([`rust_cli_kernel_api::workflow_failure`]). This module holds what the owner
//! needs around it: the failure a turn reports ([`TurnFailure`]), the transient backoff curve, the clock the owner
//! redrives on (injected, so tests are exact), and the `ProviderStop` error the stop writes.

use crate::error::{ErrorCode, WorkflowError};
use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::workflow_failure::{ProviderStopKind, facts_of};
use serde_json::{Map, Value};
use std::thread;
use std::time::Duration;

/// A turn's failure, as the turn side reports it. `model` is the typed model error when the turn failed on a model
/// request; a failure with no model error (a driver fault) is `None` and fails the ask as before.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnFailure {
    pub message: String,
    pub model: Option<ModelError>,
}

impl TurnFailure {
    /// A failure with no model error (a driver fault): the ask fails with `DriverError`.
    pub fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            model: None,
        }
    }

    /// A failure of a model request, classified by the policy table.
    pub fn model(message: impl Into<String>, model: ModelError) -> Self {
        Self {
            message: message.into(),
            model: Some(model),
        }
    }
}

/// Node `TRANSIENT_CONTINUE_PROMPT`: the fresh turn that continues an ask after a transient failure.
pub const TRANSIENT_CONTINUE_PROMPT: &str = "The previous model request failed transiently and was abandoned; continue from where you left off.";

/// Node `TRANSIENT_BACKOFF_BASE_MS`: the first redrive waits this long, before jitter.
pub const TRANSIENT_BACKOFF_BASE_MS: u64 = 2_000;
/// Node `TRANSIENT_BACKOFF_MAX_MS`: the raw delay stops doubling here.
pub const TRANSIENT_BACKOFF_MAX_MS: u64 = 60_000;

/// Node `transientBackoffMs`: 2 s doubling to 60 s, then jittered into `[0.5, 1]` of the raw delay. `attempt` counts from
/// one; `random` is in `[0, 1)`.
pub fn transient_backoff_ms(attempt: u32, random: f64) -> u64 {
    // The exponent is capped well below the width of u64: past the cap the raw delay is already the maximum.
    let exponent = attempt.saturating_sub(1).min(32);
    let raw = (TRANSIENT_BACKOFF_BASE_MS << exponent).min(TRANSIENT_BACKOFF_MAX_MS);
    let factor = 0.5 + 0.5 * random.clamp(0.0, 1.0);
    (raw as f64 * factor).round() as u64
}

/// Node `PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS`: the provider's raw text in a `ProviderStop` is bounded.
pub const PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS: usize = 2_000;

/// The Retry-After of a model error, when it carries a positive one (Node `readRetryAfterMs`).
pub fn retry_after_of(model: &ModelError) -> Option<u64> {
    match model.peel() {
        ModelError::RateLimited {
            retry_after_ms: Some(ms),
            ..
        } if *ms > 0 => Some(*ms),
        _ => None,
    }
}

/// Node `providerStopError`: the `ProviderStop` error that a permanent model failure stops the run with. `subagent` is
/// the actor's ref and `subagent_name` its persona name; the message names the persona when there is one.
pub fn provider_stop_error(
    kind: ProviderStopKind,
    model: &ModelError,
    raw_message: &str,
    subagent: &str,
    subagent_name: Option<&str>,
) -> WorkflowError {
    let facts = facts_of(model);
    let raw: String = raw_message
        .chars()
        .take(PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS)
        .collect();
    let mut details = Map::new();
    details.insert("kind".into(), Value::from(kind.as_str()));
    details.insert("reason".into(), Value::from(facts.reason));
    details.insert("subagent".into(), Value::from(subagent));
    if let Some(name) = subagent_name {
        details.insert("subagentName".into(), Value::from(name));
    }
    if let Some(provider) = model.provider() {
        if let Some(provider_id) = provider.provider_id.as_deref().filter(|id| !id.is_empty()) {
            details.insert("providerId".into(), Value::from(provider_id));
        }
        if let Some(model_id) = provider.model_id.as_deref().filter(|id| !id.is_empty()) {
            details.insert("modelId".into(), Value::from(model_id));
        }
        details.insert("providerCode".into(), Value::from(provider.code.as_str()));
    }
    if !raw.is_empty() {
        details.insert("rawMessage".into(), Value::from(raw.as_str()));
    }
    let label = subagent_name.unwrap_or(subagent);
    let code = facts
        .provider_code
        .map(|code| format!(" [{code}]"))
        .unwrap_or_default();
    WorkflowError::new(
        ErrorCode::ProviderStop,
        format!(
            "Subagent {label} hit a permanent model-side error ({}{code}): {raw}",
            facts.reason
        ),
    )
    .with_provider_stop(Value::Object(details))
}

/// The clock the owner redrives on. `after` runs `job` once, after `delay_ms`; `random` is the jitter in `[0, 1)`.
/// The owner posts its redrive request from `job`, so the owner runs the redrive on its own thread.
pub trait RedriveClock: Send + Sync {
    fn after(&self, delay_ms: u64, job: Box<dyn FnOnce() + Send>);
    fn random(&self) -> f64;
}

/// The production clock: one thread per redrive, sleeping then running the job. Jitter is drawn from the process's
/// random hash state, which is seeded at random for each process.
pub struct ThreadClock;

impl RedriveClock for ThreadClock {
    fn after(&self, delay_ms: u64, job: Box<dyn FnOnce() + Send>) {
        let spawned = thread::Builder::new()
            .name("workflow-redrive".to_owned())
            .spawn(move || {
                thread::sleep(Duration::from_millis(delay_ms));
                job();
            });
        if let Err(error) = spawned {
            tracing::warn!(error = %error, "a workflow redrive could not be scheduled");
        }
    }

    fn random(&self) -> f64 {
        // A fresh `RandomState` hashes to a random value; its top 53 bits give a float in [0, 1).
        let bits = rust_cli_base::random::u64();
        (bits >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[cfg(test)]
#[path = "model_failure_tests.rs"]
mod tests;
