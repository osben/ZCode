//! Node's `workflow-model-failure-policy.test.ts` (adapters/tests), ported: the table cases on facts, then the same
//! rules on `ModelError`, which is what the Rust side has.

use super::*;
use crate::model::{ModelError, ProviderFailure};

fn facts<'a>(
    reason: &'a str,
    code: Option<&'a str>,
    provider: Option<&'a str>,
) -> FailureFacts<'a> {
    FailureFacts {
        reason,
        code,
        provider_code: provider,
    }
}

fn stop(kind: ProviderStopKind) -> WorkflowModelFailurePolicy {
    WorkflowModelFailurePolicy::Stop(kind)
}

fn provider(code: &str, reason: &str, inner: ModelError) -> ModelError {
    ModelError::Provider {
        provider: Box::new(ProviderFailure::new(
            code,
            Some(400),
            false,
            reason,
            "openai",
        )),
        error: Box::new(inner),
    }
}

// Stop set: authentication, not configured, model unavailable, invalid request, quota. Node test 1.
#[test]
fn the_stop_set_has_one_row_per_kind() {
    assert_eq!(
        resolve_failure_policy(facts("auth_failed", None, Some("1006")), 1),
        stop(ProviderStopKind::Auth)
    );
    assert_eq!(
        resolve_failure_policy(facts("auth_failed", None, Some("3007")), 1),
        stop(ProviderStopKind::Auth)
    );
    assert_eq!(
        resolve_failure_policy(facts("provider_not_configured", None, None), 1),
        stop(ProviderStopKind::NotConfigured)
    );
    assert_eq!(
        resolve_failure_policy(facts("unknown", Some("model_config_missing"), None), 1),
        stop(ProviderStopKind::NotConfigured)
    );
    assert_eq!(
        resolve_failure_policy(
            facts("invalid_request", Some("model_not_found"), Some("3006")),
            1
        ),
        stop(ProviderStopKind::ModelUnavailable)
    );
    assert_eq!(
        resolve_failure_policy(
            facts(
                "invalid_request",
                Some("invalid_model_request"),
                Some("3001")
            ),
            1
        ),
        stop(ProviderStopKind::InvalidRequest)
    );
    assert_eq!(
        resolve_failure_policy(
            facts("invalid_request", Some("invalid_model_request"), None),
            1
        ),
        stop(ProviderStopKind::InvalidRequest)
    );
    // 1005 is invalid_request in the classifier: quota is decided by the code, before the reason.
    assert_eq!(
        resolve_failure_policy(facts("invalid_request", None, Some("1005")), 1),
        stop(ProviderStopKind::Quota)
    );
}

#[test]
fn a_quota_code_is_a_stop_whatever_the_reason() {
    for code in [
        "1308",
        "1310",
        "1313",
        "1321",
        "2056",
        "20097",
        "insufficient_quota",
    ] {
        assert_eq!(
            resolve_failure_policy(facts("rate_limited", None, Some(code)), 1),
            stop(ProviderStopKind::Quota),
            "{code}"
        );
    }
}

// Concurrency limits and everything else retry. Node test 2.
#[test]
fn concurrency_limits_and_the_rest_retry() {
    for code in ["3008", "3009", "3010"] {
        assert_eq!(
            resolve_failure_policy(facts("rate_limited", None, Some(code)), 1),
            WorkflowModelFailurePolicy::Retry,
            "{code}"
        );
    }
    for reason in [
        "rate_limited",
        "provider_overloaded",
        "server_error",
        "network_error",
        "timeout",
        "stream_idle_timeout",
        "unknown",
        "tls_error",
        "proxy_error",
    ] {
        assert_eq!(
            resolve_failure_policy(facts(reason, None, None), 1),
            WorkflowModelFailurePolicy::Retry,
            "{reason}"
        );
    }
    for code in ["1008", "1314", "1315", "2007"] {
        assert_eq!(
            resolve_failure_policy(facts("unknown", None, Some(code)), 1),
            WorkflowModelFailurePolicy::Retry,
            "{code}"
        );
    }
    // A response that did not parse is classified as invalid_request, but it is not a provider rejection of the request.
    assert_eq!(
        resolve_failure_policy(
            facts("invalid_request", Some("invalid_model_response"), None),
            1
        ),
        WorkflowModelFailurePolicy::Retry
    );
}

// Node test 3.
#[test]
fn context_exceeded_and_cancelled_have_their_own_rows() {
    assert_eq!(
        resolve_failure_policy(facts("context_exceeded", None, Some("1261")), 1),
        WorkflowModelFailurePolicy::ContextExceeded
    );
    assert_eq!(
        resolve_failure_policy(facts("cancelled", None, None), 1),
        WorkflowModelFailurePolicy::Cancelled
    );
}

// Node: unrecognized provider codes stop after ten in a row.
#[test]
fn an_unrecognized_code_retries_below_the_limit_and_stops_at_it() {
    let limit = UNRECOGNIZED_CODE_MAX_CONSECUTIVE;
    assert_eq!(limit, 10);
    assert_eq!(
        resolve_failure_policy(facts("unknown", None, Some("1113")), limit - 1),
        WorkflowModelFailurePolicy::Retry
    );
    assert_eq!(
        resolve_failure_policy(facts("unknown", None, Some("1113")), limit),
        stop(ProviderStopKind::Other)
    );
    assert_eq!(
        resolve_failure_policy(facts("unknown", None, Some("1314")), limit + 5),
        stop(ProviderStopKind::Other)
    );
}

#[test]
fn only_a_run_of_unrecognized_codes_counts_and_any_other_failure_resets_it() {
    let unknown = ModelError::Provider {
        provider: Box::new(ProviderFailure::new(
            "1113", None, false, "unknown", "zhipu",
        )),
        error: Box::new(ModelError::QuotaExhausted {
            message: "x".into(),
        }),
    };
    let network = ModelError::Network {
        message: "x".into(),
    };
    assert_eq!(next_unrecognized_streak(0, &unknown), 1);
    assert_eq!(next_unrecognized_streak(4, &unknown), 5);
    assert_eq!(next_unrecognized_streak(4, &network), 0);
    assert_eq!(
        next_unrecognized_streak(
            4,
            &ModelError::Network {
                message: "x".into()
            }
        ),
        0
    );
}

#[test]
fn nine_network_errors_then_one_unknown_code_does_not_stop() {
    let limit = UNRECOGNIZED_CODE_MAX_CONSECUTIVE;
    let unknown = provider(
        "1113",
        "unknown",
        ModelError::Protocol {
            message: "x".into(),
        },
    );
    let network = ModelError::Network {
        message: "x".into(),
    };
    let mut streak = 0;
    let mut decisions = Vec::new();
    for error in (0..limit - 1)
        .map(|_| &network)
        .chain(std::iter::once(&unknown))
    {
        streak = next_unrecognized_streak(streak, error);
        decisions.push(model_failure_policy(error, streak));
    }
    assert!(
        decisions
            .iter()
            .all(|d| *d == WorkflowModelFailurePolicy::Retry)
    );
}

#[test]
fn the_tenth_unknown_code_in_a_row_stops_even_after_network_errors() {
    let limit = UNRECOGNIZED_CODE_MAX_CONSECUTIVE;
    let unknown = provider(
        "1113",
        "unknown",
        ModelError::Protocol {
            message: "x".into(),
        },
    );
    let network = ModelError::Network {
        message: "x".into(),
    };
    let sequence: Vec<&ModelError> = [&network, &network]
        .into_iter()
        .chain(std::iter::repeat_n(&unknown, limit as usize))
        .collect();
    let mut streak = 0;
    let mut last = WorkflowModelFailurePolicy::Retry;
    for error in sequence {
        streak = next_unrecognized_streak(streak, error);
        last = model_failure_policy(error, streak);
    }
    assert_eq!(last, stop(ProviderStopKind::Other));
}

// Node's runner gate: a failure the table retries never reaches the driver as a stop.
#[test]
fn the_governor_stop_test_ignores_the_unrecognized_streak() {
    let unknown = provider(
        "1113",
        "unknown",
        ModelError::Protocol {
            message: "x".into(),
        },
    );
    assert!(!is_workflow_stop(&unknown));
    assert!(is_workflow_stop(&provider(
        "1308",
        "rate_limited",
        ModelError::QuotaExhausted {
            message: "x".into()
        }
    )));
}

// ModelError-level: the same rules through the Rust error variants.
#[test]
fn a_provider_business_failure_reads_its_own_reason_and_code() {
    // Quota by code, as the zhipu table gives it (the inner class is quota exhausted).
    assert_eq!(
        model_failure_policy(
            &provider(
                "1308",
                "rate_limited",
                ModelError::QuotaExhausted {
                    message: "x".into()
                }
            ),
            1
        ),
        stop(ProviderStopKind::Quota)
    );
    // A concurrency limit retries, however the classifier names its inner error.
    assert_eq!(
        model_failure_policy(
            &provider(
                "3008",
                "rate_limited",
                ModelError::RateLimited {
                    message: "x".into(),
                    retry_after_ms: None
                }
            ),
            1
        ),
        WorkflowModelFailurePolicy::Retry
    );
    // An unrecognized code keeps its provider reason (unknown), so it counts toward the streak, not the quota row.
    assert_eq!(
        model_failure_policy(
            &provider(
                "1113",
                "unknown",
                ModelError::QuotaExhausted {
                    message: "x".into()
                }
            ),
            10
        ),
        stop(ProviderStopKind::Other)
    );
}

#[test]
fn model_error_variants_map_to_the_table_reasons() {
    let m = |text: &str| text.to_owned();
    let cases: Vec<(ModelError, WorkflowModelFailurePolicy)> = vec![
        (ModelError::Cancelled, WorkflowModelFailurePolicy::Cancelled),
        (
            ModelError::Authentication { message: m("x") },
            stop(ProviderStopKind::Auth),
        ),
        (
            ModelError::InvalidRequest { message: m("x") },
            stop(ProviderStopKind::InvalidRequest),
        ),
        (
            ModelError::QuotaExhausted { message: m("x") },
            stop(ProviderStopKind::Quota),
        ),
        (
            ModelError::PromptTooLong { message: m("x") },
            WorkflowModelFailurePolicy::ContextExceeded,
        ),
        (
            ModelError::RateLimited {
                message: m("x"),
                retry_after_ms: Some(5_000),
            },
            WorkflowModelFailurePolicy::Retry,
        ),
        (
            ModelError::Overloaded { message: m("x") },
            WorkflowModelFailurePolicy::Retry,
        ),
        (
            ModelError::Network { message: m("x") },
            WorkflowModelFailurePolicy::Retry,
        ),
        (
            ModelError::Server {
                status: 503,
                message: m("x"),
            },
            WorkflowModelFailurePolicy::Retry,
        ),
        (
            ModelError::StreamIdle { idle_ms: 1 },
            WorkflowModelFailurePolicy::Retry,
        ),
        (
            ModelError::Protocol { message: m("x") },
            WorkflowModelFailurePolicy::Retry,
        ),
    ];
    for (error, expected) in cases {
        assert_eq!(model_failure_policy(&error, 1), expected, "{error:?}");
    }
}
