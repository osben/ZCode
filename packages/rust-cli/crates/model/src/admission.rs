//! 模型请求的准入（F5 W6b 第一部分）：每次尝试（attempt）进网络之前取一张票，结束时交回结果。
//!
//! 进程级的治理器（[`crate::governor`]）实现这个端口；模型适配器只看端口，不知道桶与队列。Node 对应
//! `ModelRequestAdmission`（contracts）与 `workflow-concurrency-governor.ts`。

use futures_util::future::BoxFuture;
use rust_cli_kernel_api::model::ModelError;
use tokio_util::sync::CancellationToken;

/// 谁在请求。`Observer` 不排队、不看冷却，但计入在飞数，并把结果喂给桶（主代理的请求，Node `observer()`）；
/// `SessionSubagents` 是主代理的子代理，同一个父会话共用一条队列；`Run` 是一个工作流 run（W6b 第二部分接入）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionScope {
    Observer,
    Run(String),
    SessionSubagents(String),
}

/// 一次限流的原因（Node 的 `ConcurrencyThrottleReason` 中模型请求会出现的两种）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThrottleReason {
    RateLimited,
    Overloaded,
}

/// 一次尝试的结局，交给票（Node 的 ticket 把状态事件映射成的同一组信号）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptSignal {
    /// 整个响应成功读完（`model_request_completed`）。
    Completed,
    /// 限流或过载：减 cap，按 Retry-After 冷却。
    Throttled {
        reason: ThrottleReason,
        retry_after_ms: Option<u64>,
    },
    /// 网络、5xx、流空闲：清连续成功数，cap 不变。
    FailedTransient,
    /// 不是 provider 的并发信号（配额、认证、内容拦截、取消……）：只结束这次尝试。
    Ended,
}

impl AttemptSignal {
    /// 失败的错误映射成信号（重试与终结共用，见 `transport::Connect::fail`）。
    pub fn of_error(error: &ModelError) -> Self {
        match error.peel() {
            ModelError::RateLimited { retry_after_ms, .. } => Self::Throttled {
                reason: ThrottleReason::RateLimited,
                retry_after_ms: *retry_after_ms,
            },
            ModelError::Overloaded { .. } => Self::Throttled {
                reason: ThrottleReason::Overloaded,
                retry_after_ms: None,
            },
            ModelError::Network { .. }
            | ModelError::Server { .. }
            | ModelError::StreamIdle { .. } => Self::FailedTransient,
            _ => Self::Ended,
        }
    }
}

/// 一次尝试的票。结算一次；没有结算就丢弃，按 [`AttemptSignal::Ended`] 结束（Node `release()`）。
pub trait AdmissionTicket: Send {
    fn settle(self: Box<Self>, signal: AttemptSignal);
}

/// 准入端口。`acquire` 在排队时可以被 `cancel` 中断，中断后不占名额。
pub trait RequestAdmission: Send + Sync {
    fn acquire<'a>(
        &'a self,
        scope: AdmissionScope,
        key: String,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<Box<dyn AdmissionTicket>, ModelError>>;
}

#[cfg(test)]
#[path = "admission_tests.rs"]
mod tests;
