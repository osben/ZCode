// Codes, classes and messages copied from apps/zcode-cli/packages/adapters/src/model/
// failure-provider-business-codes.ts (the `subscription_sharing_*` / `chatpass_v2_*` mappings).
//! Fork: ChatGPT Plan (Sign in with ChatGPT) error codes (specs/fork-rust-chatgpt-plan.md, Errors).
//!
//! The codes come only from the ChatGPT Plan direct route, so the OpenAI protocols consult this table first, by
//! `error.code` or `error.type`. None of them falls back to another billing path.

use rust_cli_base::proto::http;
use rust_cli_kernel_api::model::ModelError;

use super::{Class, Shape, Verdict, error_of};

/// One code's class and the Node message (shown instead of the server text).
fn entry(code: &str) -> Option<(Class, &'static str)> {
    Some(match code {
        "subscription_sharing_user_not_eligible" => (
            Class::InvalidRequest,
            "Your ChatGPT plan is not available for this app or workspace. Sign in with an eligible ChatGPT Plus/Pro account to continue.",
        ),
        // Node: rate-limited but not retryable (the 5-hour window does not reset within a retry budget).
        "subscription_sharing_usage_limit_exceeded" => (
            Class::QuotaExhausted,
            "ChatGPT plan usage limit reached. Manage your usage at https://chatgpt.com/settings/usage (5-hour window, shared across all apps using the plan).",
        ),
        "subscription_sharing_unsupported_capability" => (
            Class::InvalidRequest,
            "The ChatGPT plan direct route rejected a request field or tool. Remove the unsupported capability and retry.",
        ),
        "subscription_sharing_route_not_supported" => (
            Class::InvalidRequest,
            "The ChatGPT plan direct route does not support this endpoint or method.",
        ),
        // Node: one refresh and retry through the auth hook, then terminal (rule 10).
        "subscription_sharing_invalid_user" => (
            Class::AuthRejected,
            "The ChatGPT plan no longer accepts this account. Sign in again with zcode login chatgpt.",
        ),
        "chatpass_v2_scope_not_authorized" | "chatpass_v2_invalid_authorization_context" => (
            Class::AccessDenied,
            "The ChatGPT plan grant does not include the required scope. Re-run zcode login chatgpt to consent to plan usage.",
        ),
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => (
            Class::ServerError,
            "The ChatGPT plan service is temporarily unavailable. Retrying with backoff.",
        ),
        _ => return None,
    })
}

/// The verdict for the first known code among `codes` (`type`, then `code`). `status` is absent for stream errors.
pub(super) fn classify(
    status: Option<u16>,
    codes: &[Option<&str>],
    retry_after_ms: Option<u64>,
) -> Option<Verdict> {
    let (class, message) = codes.iter().flatten().find_map(|code| entry(code))?;
    let shape = Shape {
        message: message.to_owned(),
        retry_after_ms,
    };
    // The error is always the code's own (Node's final classification): the scope codes are a sign-in error
    // (Node `ProviderNotConfigured`) with or without an HTTP status, so a stream error gets the same error as a 403.
    let error = match class {
        Class::AccessDenied => ModelError::Authentication {
            message: shape.message,
        },
        _ => error_of(class, status, shape),
    };
    // Node `AccountRequestRetry` renews on the 401 status, whatever the code (`isProjectTokenRejection`): only the
    // disposition becomes a renewal; once that one renewal is spent the request ends with the code's own error.
    let class = if status == Some(http::UNAUTHORIZED) {
        Class::AuthRejected
    } else {
        class
    };
    Some(Verdict::new(class, error))
}

#[cfg(test)]
#[path = "siwc_tests.rs"]
mod tests;
