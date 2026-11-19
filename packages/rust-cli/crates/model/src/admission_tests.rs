//! 错误到准入信号的映射（Node `isWorkflowStopFailure` 与 `mintTicket` 的 publish 分支）。

use rust_cli_kernel_api::model::{ModelError, ProviderFailure};

use super::{AttemptSignal, ThrottleReason};

#[test]
fn a_429_is_a_rate_limit_with_its_retry_after() {
    let error = ModelError::RateLimited {
        message: "429".into(),
        retry_after_ms: Some(20_000),
    };
    assert_eq!(
        AttemptSignal::of_error(&error),
        AttemptSignal::Throttled {
            reason: ThrottleReason::RateLimited,
            retry_after_ms: Some(20_000),
        }
    );
}

#[test]
fn an_overload_is_a_throttle_without_a_cooldown() {
    let error = ModelError::Overloaded {
        message: "529".into(),
    };
    assert_eq!(
        AttemptSignal::of_error(&error),
        AttemptSignal::Throttled {
            reason: ThrottleReason::Overloaded,
            retry_after_ms: None,
        }
    );
}

#[test]
fn network_server_and_idle_failures_are_transient() {
    assert_eq!(
        AttemptSignal::of_error(&ModelError::Network {
            message: "reset".into()
        }),
        AttemptSignal::FailedTransient
    );
    assert_eq!(
        AttemptSignal::of_error(&ModelError::Server {
            status: 500,
            message: "boom".into()
        }),
        AttemptSignal::FailedTransient
    );
    assert_eq!(
        AttemptSignal::of_error(&ModelError::StreamIdle { idle_ms: 20_000 }),
        AttemptSignal::FailedTransient
    );
}

#[test]
fn a_stop_set_failure_is_not_a_concurrency_signal() {
    // 配额用尽（1308 类）不减 cap、不冷却：等也不会好，由用户决定何时再试（Node `isWorkflowStopFailure`）。
    let quota = ModelError::QuotaExhausted {
        message: "5 小时的使用上限".into(),
    };
    assert_eq!(AttemptSignal::of_error(&quota), AttemptSignal::Ended);
    let auth = ModelError::Authentication {
        message: "401".into(),
    };
    assert_eq!(AttemptSignal::of_error(&auth), AttemptSignal::Ended);
}

#[test]
fn a_truncated_or_malformed_stream_is_transient_like_the_other_stream_failures() {
    // 截断或协议违例的流会被传输层重发（处置表的 Truncation / Resend）：与流空闲一样是瞬时失败，清掉连续成功数。
    let truncated = ModelError::Protocol {
        message: "stream ended before message_stop".into(),
    };
    assert_eq!(
        AttemptSignal::of_error(&truncated),
        AttemptSignal::FailedTransient
    );
}

fn provider(inner: ModelError, code: &str) -> ModelError {
    ModelError::Provider {
        provider: Box::new(ProviderFailure {
            code: code.into(),
            status: Some(429),
            retryable: false,
            reason: "rate_limited".into(),
            error_phase: "prepare".into(),
            transport: "sse".into(),
            provider_kind: "openai-compatible".into(),
            provider_id: None,
            model_id: None,
        }),
        error: Box::new(inner),
    }
}

#[test]
fn a_provider_wrapped_429_and_529_classify_as_their_inner_error() {
    // 智谱与 SIWC 的错误码表把 429 / 529 包进 `Provider`：分类要看里面的错误。
    let wrapped_429 = provider(
        ModelError::RateLimited {
            message: "[1302]".into(),
            retry_after_ms: Some(5_000),
        },
        "1302",
    );
    assert_eq!(
        AttemptSignal::of_error(&wrapped_429),
        AttemptSignal::Throttled {
            reason: ThrottleReason::RateLimited,
            retry_after_ms: Some(5_000),
        }
    );
    let wrapped_529 = provider(
        ModelError::Overloaded {
            message: "busy".into(),
        },
        "1305",
    );
    assert_eq!(
        AttemptSignal::of_error(&wrapped_529),
        AttemptSignal::Throttled {
            reason: ThrottleReason::Overloaded,
            retry_after_ms: None,
        }
    );
}

#[test]
fn an_overload_takes_the_header_retry_after() {
    let error = ModelError::Overloaded {
        message: "529".into(),
    };
    assert_eq!(
        AttemptSignal::of_failure(&error, Some(30_000)),
        AttemptSignal::Throttled {
            reason: ThrottleReason::Overloaded,
            retry_after_ms: Some(30_000),
        }
    );
}

#[test]
fn a_429_without_its_own_retry_after_takes_the_header_and_its_own_wins_when_both_are_set() {
    let without = ModelError::RateLimited {
        message: "429".into(),
        retry_after_ms: None,
    };
    assert_eq!(
        AttemptSignal::of_failure(&without, Some(7_000)),
        AttemptSignal::Throttled {
            reason: ThrottleReason::RateLimited,
            retry_after_ms: Some(7_000),
        }
    );
    let with_both = ModelError::RateLimited {
        message: "429".into(),
        retry_after_ms: Some(20_000),
    };
    assert_eq!(
        AttemptSignal::of_failure(&with_both, Some(7_000)),
        AttemptSignal::Throttled {
            reason: ThrottleReason::RateLimited,
            retry_after_ms: Some(20_000),
        }
    );
}

#[test]
fn a_run_id_keeps_its_text() {
    assert_eq!(super::RunId::new("run-1").as_str(), "run-1");
}

#[test]
#[should_panic(expected = "must not start with NUL")]
fn a_run_id_in_the_reserved_key_space_fails_loudly() {
    let _ = super::RunId::new("\0observer");
}
