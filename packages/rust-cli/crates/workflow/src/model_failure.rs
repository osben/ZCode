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
    reset_at: Option<u64>,
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
    if let Some(reset_at) = reset_at {
        details.insert("resetAt".into(), Value::from(reset_at));
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

/// Node `parseQuotaResetAt` (`workflow-model-failure-policy.ts`): the reset time in a quota failure's provider text
/// ("您的限额将在 2026-10-15 18:50:42 重置"), read as Beijing time. None when the text has no reset word, no time, or a
/// time outside the plausible window.
pub fn parse_quota_reset_at(message: &str, now_ms: u64) -> Option<u64> {
    let mentions_reset = message.contains("重置") || message.to_ascii_lowercase().contains("reset");
    if !mentions_reset {
        return None;
    }
    let bytes = message.as_bytes();
    let (year, month, day, hour, minute, second) =
        bytes.windows(WALL_TIME_LEN).find_map(wall_time_at)?;
    // The copy comes from the bigmodel server with no timezone, and its times are Beijing time (UTC+8).
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - BEIJING_OFFSET_SECONDS;
    let at = u64::try_from(seconds).ok()?.checked_mul(1_000)?;
    is_plausible_reset_at(at, now_ms).then_some(at)
}

/// Node `inspectWorkflowModelFailure`'s `resetAt` for a quota stop: Retry-After first (when the time it gives is plausible),
/// otherwise the provider's text.
pub fn quota_reset_at(model: &ModelError, message: &str, now_ms: u64) -> Option<u64> {
    if let Some(retry_after_ms) = retry_after_of(model) {
        let at = now_ms.saturating_add(retry_after_ms);
        if is_plausible_reset_at(at, now_ms) {
            return Some(at);
        }
    }
    parse_quota_reset_at(message, now_ms)
}

/// Node `isPlausibleQuotaResetAt`: one day in the past (clock skew) to 35 days ahead (weekly and monthly quotas).
fn is_plausible_reset_at(at: u64, now_ms: u64) -> bool {
    const DAY_MS: u64 = 24 * 60 * 60 * 1_000;
    at >= now_ms.saturating_sub(DAY_MS) && at <= now_ms.saturating_add(35 * DAY_MS)
}

const WALL_TIME_LEN: usize = 19;
const BEIJING_OFFSET_SECONDS: i64 = 8 * 3_600;

/// A `YYYY-MM-DD[ T]HH:MM:SS` wall time at the start of `window`, with every field in range.
fn wall_time_at(window: &[u8]) -> Option<(i64, i64, i64, i64, i64, i64)> {
    let digits_at = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];
    let shape = digits_at.iter().all(|&i| window[i].is_ascii_digit())
        && window[4] == b'-'
        && window[7] == b'-'
        && (window[10] == b' ' || window[10] == b'T')
        && window[13] == b':'
        && window[16] == b':';
    if !shape {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        std::str::from_utf8(&window[range]).ok()?.parse().ok()
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second) = (number(11..13)?, number(14..16)?, number(17..19)?);
    let valid = (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && hour < 24
        && minute < 60
        && second < 60;
    valid.then_some((year, month, day, hour, minute, second))
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_from_march = (month + 9) % 12;
    let day_of_year = (153 * month_from_march + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The clock the owner redrives on. `after` runs `job` once, after `delay_ms`; `random` is the jitter in `[0, 1)`.
/// The owner posts its redrive request from `job`, so the owner runs the redrive on its own thread.
pub trait RedriveClock: Send + Sync {
    /// Returns whether the job was scheduled. False means it will never run, and the caller must not wait for it.
    fn after(&self, delay_ms: u64, job: Box<dyn FnOnce() + Send>) -> bool;
    fn random(&self) -> f64;
    /// Wall-clock milliseconds since the Unix epoch, for a quota stop's reset time (Node's `Date.now()`).
    fn now_ms(&self) -> u64;
}

/// The production clock: one thread per redrive, sleeping then running the job. Jitter is drawn from the process's
/// random hash state, which is seeded at random for each process.
pub struct ThreadClock;

impl RedriveClock for ThreadClock {
    fn after(&self, delay_ms: u64, job: Box<dyn FnOnce() + Send>) -> bool {
        // The job is moved into the thread. When the spawn fails the thread never exists, and the job is dropped with
        // it; the caller learns that from the return value and fails the ask (ocr review, finding 1).
        let spawned = thread::Builder::new()
            .name("workflow-redrive".to_owned())
            .spawn(move || {
                thread::sleep(Duration::from_millis(delay_ms));
                job();
            });
        match spawned {
            Ok(_) => true,
            Err(error) => {
                tracing::warn!(error = %error, "a workflow redrive could not be scheduled");
                false
            }
        }
    }

    fn random(&self) -> f64 {
        // A fresh `RandomState` hashes to a random value; its top 53 bits give a float in [0, 1).
        let bits = rust_cli_base::random::u64();
        (bits >> 11) as f64 / (1u64 << 53) as f64
    }

    #[expect(
        clippy::disallowed_methods,
        reason = "this is the production clock: the one place the wall clock is read for a redrive"
    )]
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
            .unwrap_or(0)
    }
}

#[cfg(test)]
#[path = "model_failure_tests.rs"]
mod tests;
