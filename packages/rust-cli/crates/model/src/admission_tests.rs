//! 错误到准入信号的映射（Node `isWorkflowStopFailure` 与 `mintTicket` 的 publish 分支）。

#![allow(clippy::unwrap_used, reason = "测试辅助不在 #[test] 里")]

use rust_cli_kernel_api::model::ModelError;

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
