//! 模型请求的准入（F5 W6b 第一部分）：每次尝试（attempt）进网络之前取一张票，结束时交回结果。
//!
//! 进程级的治理器（[`crate::governor`]）实现这个端口；模型适配器只看端口，不知道桶与队列。Node 对应
//! `ModelRequestAdmission`（contracts）与 `workflow-concurrency-governor.ts`。

use futures_util::future::BoxFuture;
use rust_cli_kernel_api::model::ModelError;
use tokio_util::sync::CancellationToken;

/// 工作流 run 的 ID（准入的 key 空间里的一个成员；9.9 的后续 12：与父会话 ID 分开的类型，不能互相传错）。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RunId(String);

impl RunId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for RunId {
    fn from(id: &str) -> Self {
        Self::new(id)
    }
}

/// 主代理的父会话 ID（子代理池的队列名）。空字符串表示“未知的父会话”（见 9.9 的偏差 1）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct ParentSessionId(String);

impl ParentSessionId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for ParentSessionId {
    fn from(id: &str) -> Self {
        Self::new(id)
    }
}

/// 谁在请求。`Observer` 不排队、不看冷却，但计入在飞数，并把结果喂给桶（主代理的请求，Node `observer()`）；
/// `SessionSubagents` 是主代理的子代理，同一个父会话共用一条队列；`Run` 是一个工作流 run（登记上界、参与扇出）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionScope {
    Observer,
    Run(RunId),
    SessionSubagents(ParentSessionId),
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
    /// 失败的错误映射成信号（流中途的失败用它；没有响应头可看的时候）。
    pub fn of_error(error: &ModelError) -> Self {
        Self::of_failure(error, None)
    }

    /// 失败映射成信号。`retry_after_ms` 是响应头里的 Retry-After：错误自己没有时用它（529 过载的时长在响应头里，
    /// Node 把它作为 overload 的 `retryAfterMs` 带进桶的冷却）。
    pub fn of_failure(error: &ModelError, retry_after_ms: Option<u64>) -> Self {
        match error.peel() {
            ModelError::RateLimited {
                retry_after_ms: own,
                ..
            } => Self::Throttled {
                reason: ThrottleReason::RateLimited,
                retry_after_ms: own.or(retry_after_ms),
            },
            ModelError::Overloaded { .. } => Self::Throttled {
                reason: ThrottleReason::Overloaded,
                retry_after_ms,
            },
            // 瞬时失败：网络、5xx、流空闲，以及被传输层重发的截断或协议违例的流。
            ModelError::Network { .. }
            | ModelError::Server { .. }
            | ModelError::StreamIdle { .. }
            | ModelError::Protocol { .. } => Self::FailedTransient,
            // 不是并发信号，只结束这次尝试。这里逐个列出变体（不用 `_`），新增变体时编译器会要求给出分类。
            ModelError::Cancelled
            | ModelError::PromptTooLong { .. }
            | ModelError::Authentication { .. }
            | ModelError::InvalidRequest { .. }
            | ModelError::FallbackTriggered { .. }
            | ModelError::Unsupported { .. }
            | ModelError::QuotaExhausted { .. }
            | ModelError::ContentBlocked { .. }
            | ModelError::RequestTooLarge { .. }
            | ModelError::CurrentAttachmentsTooLarge
            // `peel` 已经去掉了 `Provider` 包装，这一支只为让 match 保持穷举。
            | ModelError::Provider { .. } => Self::Ended,
        }
    }
}

/// 一次尝试的票。结算一次；没有结算就丢弃，按 [`AttemptSignal::Ended`] 结束（Node `release()`）。
pub trait AdmissionTicket: Send {
    fn settle(self: Box<Self>, signal: AttemptSignal);
}

/// 准入端口。`acquire` 在排队时可以被 `cancel` 中断，中断后不占名额。取消（或治理器已经不在）时返回
/// [`ModelError::Cancelled`]，从不返回限流类的错误：限流只来自尝试自己的结局（[`AttemptSignal`]）。
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
