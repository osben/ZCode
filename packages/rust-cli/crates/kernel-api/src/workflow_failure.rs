//! The workflow model-failure policy table (W6b part 3; Node `adapters/src/model/workflow-model-failure-policy.ts`).
//!
//! One pure table answers "what does a workflow do with this model failure": stop the run, fail only the ask, or
//! redrive it after a backoff. The model governor reads the same table to decide whether a failure ends an attempt
//! (`AttemptSignal`), and the workflow driver reads it to decide the ask. It lives here because both crates already
//! depend on this one and `ModelError` is defined here: the model crate and the workflow crate do not depend on each
//! other, so neither needs the other to share the table.

use crate::model::ModelError;

/// Node `WORKFLOW_UNRECOGNIZED_CODE_MAX_CONSECUTIVE`: an unrecognized business code that appears this many times in a
/// row stops the run, as kind `other`.
pub const UNRECOGNIZED_CODE_MAX_CONSECUTIVE: u32 = 10;

/// Node `WORKFLOW_QUOTA_PROVIDER_CODES`: the quota-related business codes (the Stop set's quota row). Kept apart from
/// the main conversation's retry table, as in Node.
pub const WORKFLOW_QUOTA_PROVIDER_CODES: &[&str] = &[
    "1005",
    "1308",
    "1310",
    "1313",
    "1316",
    "1317",
    "1318",
    "1319",
    "1320",
    "1321",
    "2056",
    "20097",
    "insufficient_quota",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "exceeded_current_quota_error",
];

/// Node `WorkflowProviderStopKind`: the classification key of a `ProviderStop`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderStopKind {
    Auth,
    NotConfigured,
    ModelUnavailable,
    InvalidRequest,
    Quota,
    Other,
}

impl ProviderStopKind {
    /// The name Node writes into the `ProviderStop` details (`providerStop.kind`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::NotConfigured => "not_configured",
            Self::ModelUnavailable => "model_unavailable",
            Self::InvalidRequest => "invalid_request",
            Self::Quota => "quota",
            Self::Other => "other",
        }
    }
}

/// Node `WorkflowModelFailurePolicy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowModelFailurePolicy {
    /// Redrive after a backoff. The script never sees the failure.
    Retry,
    /// Stop the run as `stopped(provider)`. Resumable.
    Stop(ProviderStopKind),
    /// Fail only the ask, with `ContextLimit`, so the script can catch it.
    ContextExceeded,
    /// The attempt was cancelled. Node's driver redrives it (its switch default), as the table says.
    Cancelled,
}

/// The facts the table reads: Node's classifier `reason` and `code`, and the provider's business code. The names are
/// Node's strings (`ModelFailureReason`, `ModelErrorCode`), so the table reads as Node's does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FailureFacts<'a> {
    pub reason: &'a str,
    pub code: Option<&'a str>,
    pub provider_code: Option<&'a str>,
}

/// Node `resolveWorkflowModelFailurePolicy`. `streak` is how many unrecognized business codes have appeared in a row,
/// counting this one. Order matters: cancellation first, quota by code before reason, the rest by reason and code.
pub fn resolve_failure_policy(facts: FailureFacts<'_>, streak: u32) -> WorkflowModelFailurePolicy {
    if facts.reason == REASON_CANCELLED {
        return WorkflowModelFailurePolicy::Cancelled;
    }
    // Quota is decided by the business code before the reason: 1005 is invalid_request in the classifier.
    if facts
        .provider_code
        .is_some_and(|code| WORKFLOW_QUOTA_PROVIDER_CODES.contains(&code))
    {
        return stop(ProviderStopKind::Quota);
    }
    if facts.reason == REASON_AUTH_FAILED {
        return stop(ProviderStopKind::Auth);
    }
    if facts.reason == REASON_PROVIDER_NOT_CONFIGURED
        || facts
            .code
            .is_some_and(|code| NOT_CONFIGURED_CODES.contains(&code))
    {
        return stop(ProviderStopKind::NotConfigured);
    }
    if facts.code == Some(CODE_MODEL_NOT_FOUND) {
        return stop(ProviderStopKind::ModelUnavailable);
    }
    if facts.reason == REASON_CONTEXT_EXCEEDED {
        return WorkflowModelFailurePolicy::ContextExceeded;
    }
    // "Invalid request" is a provider's rejection of the request. A response that did not parse is also classified as
    // invalid_request, but it may succeed on a retry.
    if facts.reason == REASON_INVALID_REQUEST && facts.code != Some(CODE_INVALID_MODEL_RESPONSE) {
        return stop(ProviderStopKind::InvalidRequest);
    }
    // Rust-only row: a quota error with no provider business code (see `facts_of`).
    if facts.reason == REASON_QUOTA_EXHAUSTED {
        return stop(ProviderStopKind::Quota);
    }
    if is_unrecognized(facts) && streak >= UNRECOGNIZED_CODE_MAX_CONSECUTIVE {
        return stop(ProviderStopKind::Other);
    }
    WorkflowModelFailurePolicy::Retry
}

fn stop(kind: ProviderStopKind) -> WorkflowModelFailurePolicy {
    WorkflowModelFailurePolicy::Stop(kind)
}

/// Node `isUnrecognizedProviderCodeFailure`: reason unknown, with a provider business code.
fn is_unrecognized(facts: FailureFacts<'_>) -> bool {
    facts.reason == REASON_UNKNOWN && facts.provider_code.is_some()
}

const REASON_CANCELLED: &str = "cancelled";
const REASON_AUTH_FAILED: &str = "auth_failed";
const REASON_PROVIDER_NOT_CONFIGURED: &str = "provider_not_configured";
const REASON_CONTEXT_EXCEEDED: &str = "context_exceeded";
const REASON_INVALID_REQUEST: &str = "invalid_request";
const REASON_UNKNOWN: &str = "unknown";
/// Rust-only: `ModelError::QuotaExhausted` with no provider business code. Node always names a quota code.
const REASON_QUOTA_EXHAUSTED: &str = "quota_exhausted";
const CODE_MODEL_NOT_FOUND: &str = "model_not_found";
const CODE_INVALID_MODEL_RESPONSE: &str = "invalid_model_response";
/// Node `NOT_CONFIGURED_ERROR_CODES`. Rust raises none of these on a model error; the table keeps the row for parity.
const NOT_CONFIGURED_CODES: &[&str] = &[
    "provider_not_found",
    "provider_not_configured",
    "model_config_missing",
    "invalid_model_selection",
    "model_request_auth_missing",
];

/// The facts of a model error, as Node's classifier would name them. A provider business failure reads its own
/// `reason` and code; any other error reads its variant.
pub fn facts_of(error: &ModelError) -> FailureFacts<'_> {
    let provider_code = error.provider().map(|provider| provider.code.as_str());
    if let Some(provider) = error.provider()
        && !provider.reason.is_empty()
    {
        let reason = if KNOWN_PROVIDER_REASONS.contains(&provider.reason.as_str()) {
            provider.reason.as_str()
        } else {
            REASON_UNKNOWN
        };
        return FailureFacts {
            reason,
            code: None,
            provider_code,
        };
    }
    FailureFacts {
        reason: variant_reason(error.peel()),
        code: None,
        provider_code,
    }
}

/// The Node reason of an error variant (the variant's own classification, without a provider business code).
fn variant_reason(error: &ModelError) -> &'static str {
    match error {
        ModelError::Cancelled => REASON_CANCELLED,
        ModelError::RateLimited { .. } => "rate_limited",
        ModelError::Overloaded { .. } => "provider_overloaded",
        ModelError::PromptTooLong { .. } => REASON_CONTEXT_EXCEEDED,
        ModelError::Authentication { .. } => REASON_AUTH_FAILED,
        ModelError::InvalidRequest { .. } => REASON_INVALID_REQUEST,
        ModelError::Network { .. } => "network_error",
        ModelError::Server { .. } => "server_error",
        ModelError::StreamIdle { .. } => "stream_idle_timeout",
        ModelError::QuotaExhausted { .. } => REASON_QUOTA_EXHAUSTED,
        // Deterministic rejections of the request. Node's equivalent wire failures are a 400 or 422, which its classifier
        // maps to `invalid_request` (a stop row). Node has no content-filter error: `sensitive` is a finish reason.
        ModelError::ContentBlocked { .. }
        | ModelError::RequestTooLarge { .. }
        | ModelError::CurrentAttachmentsTooLarge
        | ModelError::Unsupported { .. } => REASON_INVALID_REQUEST,
        // A truncated or malformed stream is retried (Node's invalid_model_response is not in the Stop set). A fallback
        // switch is an overload that already moved to another model: it is retried as an overload is (Node retries it).
        ModelError::Protocol { .. } | ModelError::FallbackTriggered { .. } => REASON_UNKNOWN,
        // `peel` removed the provider wrapper; this arm keeps the match exhaustive.
        ModelError::Provider { .. } => REASON_UNKNOWN,
    }
}

/// The provider reasons the table knows. Any other reason from a provider is read as `unknown`, so an unrecognized code
/// with such a reason still counts toward the streak (ocr review, finding 8).
const KNOWN_PROVIDER_REASONS: &[&str] = &[
    REASON_CANCELLED,
    REASON_AUTH_FAILED,
    REASON_PROVIDER_NOT_CONFIGURED,
    REASON_CONTEXT_EXCEEDED,
    REASON_INVALID_REQUEST,
    REASON_UNKNOWN,
    REASON_QUOTA_EXHAUSTED,
    "rate_limited",
    "provider_overloaded",
    "server_error",
    "network_error",
    "timeout",
    "stream_idle_timeout",
    "tls_error",
    "proxy_error",
    "content_blocked",
    "request_too_large",
];

/// The policy for a model error, with `streak` as in [`resolve_failure_policy`].
pub fn model_failure_policy(error: &ModelError, streak: u32) -> WorkflowModelFailurePolicy {
    resolve_failure_policy(facts_of(error), streak)
}

/// The streak after another failure: one more if this failure is an unrecognized business code, otherwise zero.
pub fn next_unrecognized_streak(previous: u32, error: &ModelError) -> u32 {
    if is_unrecognized(facts_of(error)) {
        previous.saturating_add(1)
    } else {
        0
    }
}

/// Whether a failure is in the Stop set, read with a streak of one. This is the governor's test: Node's governor
/// calls the same table with no streak, so an unrecognized code never stops there.
pub fn is_workflow_stop(error: &ModelError) -> bool {
    matches!(
        model_failure_policy(error, 1),
        WorkflowModelFailurePolicy::Stop(_)
    )
}

#[cfg(test)]
#[path = "workflow_failure_tests.rs"]
mod tests;
