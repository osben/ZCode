//! Fork: ChatGPT Plan error codes (specs/fork-rust-chatgpt-plan.md, Errors; R12, R13).

use std::time::SystemTime;

use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::provider::WireProtocol;
use rust_cli_net::ResponseHeaders;
use serde_json::json;

use crate::errors::dispose::{Action, Phase, dispose};
use crate::errors::{Class, Vendor, Verdict};

fn failure(status: u16, code: &str) -> Verdict {
    let body =
        json!({"error": {"message": "server text", "type": "invalid_request_error", "code": code}});
    crate::errors::classify_response(
        Vendor::Generic,
        WireProtocol::OpenAiResponses,
        (status, &ResponseHeaders::default()),
        &body.to_string(),
        SystemTime::UNIX_EPOCH,
    )
}

#[test]
fn the_usage_limit_is_final_with_the_node_text() {
    let limited = failure(429, "subscription_sharing_usage_limit_exceeded");
    assert_eq!(limited.class, Class::QuotaExhausted);
    assert_eq!(
        limited.error,
        ModelError::QuotaExhausted {
            message: "ChatGPT plan usage limit reached. Manage your usage at https://chatgpt.com/settings/usage (5-hour window, shared across all apps using the plan).".to_owned(),
        }
    );
    assert_eq!(
        dispose(limited.class, Phase::Head, true, None),
        Action::Fail
    );
}

#[test]
fn an_unavailable_plan_service_is_retried() {
    for code in [
        "subscription_sharing_usage_unavailable",
        "subscription_sharing_user_unavailable",
    ] {
        let verdict = failure(503, code);
        assert_eq!(verdict.class, Class::ServerError, "{code}");
        assert!(matches!(
            &verdict.error,
            ModelError::Server { status: 503, message } if message.starts_with("The ChatGPT plan service is temporarily unavailable")
        ));
        assert!(matches!(
            dispose(verdict.class, Phase::Head, true, None),
            Action::Retry { .. }
        ));
    }
}

#[test]
fn eligibility_scope_and_account_codes_keep_their_classes() {
    let cases = [
        (
            "subscription_sharing_user_not_eligible",
            403,
            Class::InvalidRequest,
        ),
        (
            "subscription_sharing_unsupported_capability",
            400,
            Class::InvalidRequest,
        ),
        (
            "subscription_sharing_route_not_supported",
            404,
            Class::InvalidRequest,
        ),
        (
            "subscription_sharing_invalid_user",
            401,
            Class::AuthRejected,
        ),
        ("chatpass_v2_scope_not_authorized", 403, Class::AccessDenied),
        (
            "chatpass_v2_invalid_authorization_context",
            403,
            Class::AccessDenied,
        ),
        // Any plan code at 401 is renewed once first, like Node (status based).
        (
            "chatpass_v2_invalid_authorization_context",
            401,
            Class::AuthRejected,
        ),
        (
            "subscription_sharing_user_not_eligible",
            401,
            Class::AuthRejected,
        ),
    ];
    for (code, status, class) in cases {
        let verdict = failure(status, code);
        assert_eq!(verdict.class, class, "{code}");
        let message = match &verdict.error {
            ModelError::InvalidRequest { message } | ModelError::Authentication { message } => {
                message
            }
            other => panic!("{code}: {other:?}"),
        };
        assert!(message.contains("ChatGPT plan"), "{code}: {message}");
    }
    // The scope codes are an authentication failure at 401 / 403 (the sign-in error, not a bad request).
    assert!(matches!(
        failure(403, "chatpass_v2_scope_not_authorized").error,
        ModelError::Authentication { .. }
    ));
}

#[test]
fn stream_errors_and_the_type_field_are_recognised() {
    let value = json!({"type": "error", "error": {"type": "subscription_sharing_usage_limit_exceeded", "message": "x"}});
    let verdict = crate::errors::classify_stream_error(
        Vendor::Generic,
        WireProtocol::OpenAiResponses,
        &value,
        &value.to_string(),
    );
    assert_eq!(verdict.class, Class::QuotaExhausted);
    // Other OpenAI codes are untouched.
    assert_eq!(
        failure(429, "rate_limit_exceeded").class,
        Class::RateLimited
    );
}
