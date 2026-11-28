//! 与协议无关的重试工具（docs/specs/rust-cli/model.md §5）：退避时长、Retry-After 与
//! `x-should-retry` 解析。哪些失败可以重试由协议适配器决定。
//!
//! 默认值是 Node 的（`adapters/src/model/retry-policy.ts`，specs/fork-rust-model-retry-env.md）：最多重试 10 次；第 n 次
//! 失败后等 `min(2 s × 2^(n-1), 60 s)`，再乘 `[0.5, 1.0)` 的随机抖动（Node `calculateRetryDelay`）；服务端给了 Retry-After
//! 时取两者中较大的；Retry-After 超过 `max_wait`（60 秒）时不再重试，直接报错。基础等待、倍数与上限可由
//! `ZCODE_MODEL_RETRY_*` 改（`cli/assemble/options.rs`）。

use std::time::{Duration, SystemTime};

use rust_cli_base::units;

use crate::ResponseHeaders;

/// 默认：首次请求之外最多再试几次。
const DEFAULT_MAX_RETRIES: u32 = 10;
/// 默认：第一次重试前的基础等待。
const DEFAULT_BASE_DELAY: Duration = Duration::from_millis(2_000);
/// 默认：每次重试等待的倍数。
const DEFAULT_BACKOFF_FACTOR: f64 = 2.0;
/// 默认：指数退避的上限（抖动之前）。
const DEFAULT_MAX_BACKOFF: Duration = Duration::from_millis(60_000);
/// 默认：单次等待的上限，超过时不再重试。
const DEFAULT_MAX_WAIT: Duration = Duration::from_secs(units::SECONDS_PER_MINUTE);

/// 重试策略。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RetryPolicy {
    /// 首次请求之外最多再试几次。
    pub max_retries: u32,
    /// 第一次重试前的基础等待。
    pub base_delay: Duration,
    /// 每次重试等待相对上一次的倍数（大于 0，可以是小数）。
    pub backoff_factor: f64,
    /// 指数退避的上限（不含抖动）。
    pub max_backoff: Duration,
    /// 抖动开关：非零的等待乘 `0.5 + 0.5 × random`（Node `retry.jitter`）。
    pub jitter: bool,
    /// 服务端要求的等待的上限；超过时放弃重试（例如 Retry-After 要求等一小时）。本地退避不受它限制。
    pub max_wait: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: DEFAULT_MAX_RETRIES,
            base_delay: DEFAULT_BASE_DELAY,
            backoff_factor: DEFAULT_BACKOFF_FACTOR,
            max_backoff: DEFAULT_MAX_BACKOFF,
            jitter: true,
            max_wait: DEFAULT_MAX_WAIT,
        }
    }
}

impl RetryPolicy {
    /// 第 `attempt` 次失败（从 1 开始）之后、下一次请求之前的等待；`random` 取 `[0, 1)`。
    /// 返回 `None` 表示服务端要求的等待超过 [`max_wait`](Self::max_wait)，不应再重试。
    pub fn delay(
        &self,
        attempt: u32,
        retry_after: Option<Duration>,
        random: f64,
    ) -> Option<Duration> {
        let exponent = i32::try_from(attempt.saturating_sub(1)).unwrap_or(i32::MAX);
        let uncapped = self.base_delay.as_secs_f64() * self.backoff_factor.powi(exponent);
        // A zero base with an overflowing factor is 0 * inf: no wait, not a NaN that `min` would turn into the cap.
        let uncapped = if uncapped.is_nan() { 0.0 } else { uncapped };
        let capped = uncapped.min(self.max_backoff.as_secs_f64());
        // Node: a non-zero wait is scaled by `0.5 + random * 0.5` when jitter is on; the result is whole milliseconds.
        let jittered = if self.jitter && capped > 0.0 {
            capped * (0.5 + random.clamp(0.0, 1.0) * 0.5)
        } else {
            capped
        };
        let computed = Duration::from_millis((jittered * units::MS_PER_SECOND_F64).round() as u64);
        match retry_after {
            Some(after) if after > self.max_wait => None,
            Some(after) => Some(after.max(computed)),
            None => Some(computed),
        }
    }
}

/// 服务端要求的等待：`retry-after-ms`（毫秒，可带小数），否则 `retry-after`（秒数或 HTTP-date）。
/// HTTP-date 早于 `now` 时为零。
// 复制自 apps/zcode-cli-rust/crates/model/src/model_failure.rs（feat/rs 79b6691c55）；
// `x-should-retry` 拆到 [`should_retry`]。
pub fn retry_after(headers: &ResponseHeaders, now: SystemTime) -> Option<Duration> {
    let header = |name: &str| headers.get(name).map(str::trim);
    let numeric = |text: &str, scale: f64| {
        text.parse::<f64>()
            .ok()
            .filter(|value| value.is_finite())
            .map(|value| Duration::from_millis((value * scale).max(0.0).round() as u64))
    };
    if let Some(delay) = header("retry-after-ms").and_then(|text| numeric(text, 1.0)) {
        return Some(delay);
    }
    let value = header(crate::header::RETRY_AFTER)?;
    numeric(value, units::MS_PER_SECOND_F64).or_else(|| {
        httpdate::parse_http_date(value)
            .ok()
            .map(|date| date.duration_since(now).unwrap_or_default())
    })
}

/// `x-should-retry` 的明确指示：`true` / `false`；没有或无法识别时为空。
pub fn should_retry(headers: &ResponseHeaders) -> Option<bool> {
    match headers.get("x-should-retry").map(str::trim) {
        Some("true") => Some(true),
        Some("false") => Some(false),
        _ => None,
    }
}

/// `[0, 1)` 的随机数，用于退避抖动（不要求密码学强度）。
///
/// 随机源是 base 的 `random`（README §4 的“随机”类别，F58）。
pub fn jitter() -> f64 {
    let bits = rust_cli_base::random::u64();
    (bits >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
#[path = "retry_tests.rs"]
mod tests;
