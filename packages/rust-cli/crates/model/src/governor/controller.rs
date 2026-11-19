//! AIMD 控制器：一个 provider/模型桶的 cap 状态机（Node `dynamic-workflow/src/engine/concurrency.ts`）。
//!
//! 纯状态机：不读时钟，`now`（Unix 毫秒）由调用方给。信号返回这次 cap 变化（0 或 1 条，空闲重置后紧跟限流时 2 条）。
//! 增长上限（`set_growth_limit`）与起跳（`seed`）由治理器按 run 的上界调用（见 `governor::mod`，9.10）。

use crate::admission::ThrottleReason;

/// 限流时 cap 乘以 3/4 再向下取整（Node `CONCURRENCY_DECREASE_FACTOR`）。
const DECREASE_NUM: u32 = 3;
const DECREASE_DEN: u32 = 4;
/// 连续成功数达到它才 +1（Node `CONCURRENCY_INCREASE_AFTER_SUCCESSES`）。
const INCREASE_AFTER_SUCCESSES: u32 = 4;
/// cap 的地板（Node `CONCURRENCY_FLOOR`）。
const FLOOR: u32 = 1;
/// 空闲这么久且没有在飞请求，cap 回到起始值（Node `CONCURRENCY_IDLE_RESET_MS`）。
pub const IDLE_RESET_MS: u64 = 300_000;
/// 冷却的上限（毫秒）。Node 对 Retry-After 没有上限（`concurrency.ts` 原样使用）；这里取 Rust 的重试策略的最长等待
/// （`rust_cli_net::retry` 的 `max_wait`，60 s）。一个超大的 Retry-After 会让桶冻住很久，所以在这里截断。
/// 这是与 Node 的偏差，记在 spec 9.9。
pub const MAX_COOLDOWN_MS: u64 = 60_000;

/// cap 变化的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeReason {
    RateLimited,
    Overloaded,
    Recovered,
    IdleReset,
    /// 增长上限被压低，cap 当场拉下来（Node `limit_lowered`）。
    LimitLowered,
    /// 抬高上界时直接起跳（Node `seeded`）。
    Seeded,
}

/// 一次 cap 变化（Node `ConcurrencyChange`，去掉了事件要的 key：桶自己知道，治理器发给监听者时补上）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub previous: u32,
    pub next: u32,
    pub reason: ChangeReason,
    /// 变化之后的 lastGood / lastBad（Node 的 `change()` 同样带上）。
    pub last_good: Option<u32>,
    pub last_bad: Option<u32>,
    /// 这次限流带来的冷却（毫秒，已截断到 `MAX_COOLDOWN_MS`）。
    pub cooldown_ms: Option<u64>,
}

/// 只读快照（Node `ConcurrencyControllerSnapshot`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub initial: u32,
    pub growth_limit: u32,
    pub cap: u32,
    pub epoch: u64,
    pub in_flight: u32,
    pub waiters: u32,
    pub success_streak: u32,
    pub cooldown_until: Option<u64>,
    pub last_good: Option<u32>,
    pub last_bad: Option<u32>,
    pub last_throttled_at: Option<u64>,
}

pub struct Controller {
    initial: u32,
    growth_limit: u32,
    cap: u32,
    epoch: u64,
    in_flight: u32,
    waiters: u32,
    success_streak: u32,
    cooldown_until: Option<u64>,
    last_request_at: Option<u64>,
    last_good: Option<u32>,
    last_bad: Option<u32>,
    last_throttled_at: Option<u64>,
}

impl Controller {
    /// `initial` 是起始值与空闲重置的落点（默认 D）；`growth_limit` 是自动增长的上限（2D）。
    pub fn new(initial: u32, growth_limit: u32) -> Self {
        Self {
            initial,
            growth_limit: growth_limit.max(initial),
            cap: initial,
            epoch: 0,
            in_flight: 0,
            waiters: 0,
            success_streak: 0,
            cooldown_until: None,
            last_request_at: None,
            last_good: None,
            last_bad: None,
            last_throttled_at: None,
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            initial: self.initial,
            growth_limit: self.growth_limit,
            cap: self.cap,
            epoch: self.epoch,
            in_flight: self.in_flight,
            waiters: self.waiters,
            success_streak: self.success_streak,
            cooldown_until: self.cooldown_until,
            last_good: self.last_good,
            last_bad: self.last_bad,
            last_throttled_at: self.last_throttled_at,
        }
    }

    /// 门（准入条件）：在飞数低于 cap，且不在冷却里。纯查询。
    pub fn can_admit(&self, now: u64) -> bool {
        self.in_flight < self.cap && self.cooldown_until.is_none_or(|until| now >= until)
    }

    /// 准入前的空信号：只做空闲重置（准入也是一次信号；空闲很久的第一个请求要从起始值起步）。
    pub fn observe(&mut self, now: u64) -> Vec<Change> {
        self.idle_reset(now)
    }

    /// 一个请求被准入：在飞数加一，记下请求时间，返回它的 epoch（结束时交回）。
    pub fn admitted(&mut self, now: u64) -> u64 {
        self.last_request_at = Some(now);
        self.in_flight += 1;
        self.epoch
    }

    /// 成功：只有当前 epoch 的成功计入连续数。连续 K 次证明当前 cap 可行（记下 lastGood）；有等待者且 cap 未到
    /// 上限时 +1，否则连续数继续累计但不生效。
    pub fn succeeded(&mut self, now: u64, epoch: u64) -> Vec<Change> {
        let mut changes = self.idle_reset(now);
        self.in_flight = self.in_flight.saturating_sub(1);
        if epoch != self.epoch {
            return changes;
        }
        self.success_streak = self.success_streak.saturating_add(1);
        if self.success_streak < INCREASE_AFTER_SUCCESSES {
            return changes;
        }
        if self.last_good.is_none_or(|good| self.cap > good) {
            self.last_good = Some(self.cap);
        }
        if self.waiters == 0 || self.cap >= self.growth_limit {
            return changes;
        }
        let previous = self.cap;
        self.cap = (previous + 1).min(self.growth_limit);
        self.success_streak = 0;
        changes.push(self.change(previous, ChangeReason::Recovered));
        changes
    }

    /// 限流或过载：在飞数减一，连续数清零，Retry-After 把冷却推到更晚的时刻。只有当前 epoch 的 429 才评价 cap：
    /// 有 lastGood 且 cap 在它之上就回到 lastGood（不乘系数），否则乘 3/4 并清掉 lastGood。两种都让 epoch 加一，
    /// 同一批请求只触发一次决定。
    pub fn throttled(
        &mut self,
        now: u64,
        epoch: u64,
        reason: ThrottleReason,
        retry_after_ms: Option<u64>,
    ) -> Vec<Change> {
        let mut changes = self.idle_reset(now);
        self.in_flight = self.in_flight.saturating_sub(1);
        self.success_streak = 0;
        // 旧 epoch 的限流也记下（种子规则要看“刚刚撞过墙”），但不评价当前 cap。
        self.last_throttled_at = Some(now);
        let cooldown_ms = retry_after_ms
            .filter(|ms| *ms > 0)
            .map(|ms| ms.min(MAX_COOLDOWN_MS));
        if let Some(ms) = cooldown_ms {
            // 饱和加法：Retry-After 可以是任意大的数（`u64::MAX` 表示“太大”），不能让截止时间回绕。
            let until = now.saturating_add(ms);
            self.cooldown_until = Some(self.cooldown_until.unwrap_or(0).max(until));
        }
        if epoch != self.epoch {
            return changes;
        }
        let previous = self.cap;
        match self.last_good {
            Some(good) if self.cap > good => {
                self.last_bad = Some(self.cap);
                self.cap = good;
            }
            _ => {
                // u64 中间值：cap 为 u32 时 cap x 3 / 4 必然落在 u32 内，不会溢出（Codex #560 P3）。
                let decreased =
                    u64::from(self.cap) * u64::from(DECREASE_NUM) / u64::from(DECREASE_DEN);
                let Ok(decreased) = u32::try_from(decreased) else {
                    unreachable!("a decrease factor below one cannot push the cap past u32");
                };
                self.cap = decreased.max(FLOOR);
                self.last_bad = Some(previous);
                self.last_good = None;
            }
        }
        self.epoch += 1;
        let reason = match reason {
            ThrottleReason::RateLimited => ChangeReason::RateLimited,
            ThrottleReason::Overloaded => ChangeReason::Overloaded,
        };
        // cap 没变且没有 Retry-After 时不发事件；有 Retry-After 时总是发（冷却的结束时刻要告诉用户）。
        if previous != self.cap || retry_after_ms.is_some_and(|ms| ms > 0) {
            let mut change = self.change(previous, reason);
            change.cooldown_ms = cooldown_ms;
            changes.push(change);
        }
        changes
    }

    /// 网络、5xx、流空闲：在飞数减一，连续数清零，cap 不变。
    pub fn failed_transient(&mut self, now: u64) -> Vec<Change> {
        let changes = self.idle_reset(now);
        self.in_flight = self.in_flight.saturating_sub(1);
        self.success_streak = 0;
        changes
    }

    /// 不是 provider 的并发信号的结束（配额、认证、取消……）：只减在飞数。
    pub fn ended(&mut self, now: u64) -> Vec<Change> {
        let changes = self.idle_reset(now);
        self.in_flight = self.in_flight.saturating_sub(1);
        changes
    }

    /// 排队人数（队列变化时由治理器给）。有需求才增长。
    pub fn waiters(&mut self, now: u64, count: u32) -> Vec<Change> {
        let changes = self.idle_reset(now);
        self.waiters = count;
        changes
    }

    /// 空闲重置（Node `idleReset`）：距上次请求满 5 分钟且没有在飞请求，cap 回到起始值，清掉学到的状态，epoch 加一。
    /// 惰性：只在有信号时检查，不用定时器。
    fn idle_reset(&mut self, now: u64) -> Vec<Change> {
        let idle = self
            .last_request_at
            .is_some_and(|at| now.saturating_sub(at) >= IDLE_RESET_MS);
        if !idle || self.in_flight != 0 {
            return Vec::new();
        }
        let untouched = self.cap == self.initial
            && self.success_streak == 0
            && self.cooldown_until.is_none()
            && self.last_good.is_none()
            && self.last_bad.is_none()
            && self.last_throttled_at.is_none();
        if untouched {
            return Vec::new();
        }
        let previous = self.cap;
        self.cap = self.initial;
        self.success_streak = 0;
        self.cooldown_until = None;
        self.last_good = None;
        self.last_bad = None;
        self.last_throttled_at = None;
        self.epoch += 1;
        if previous == self.cap {
            Vec::new()
        } else {
            vec![self.change(previous, ChangeReason::IdleReset)]
        }
    }

    /// 增长上限（Node `setGrowthLimit`）：抬高只记下，cap 一级一级爬；压低到 cap 之下时 cap 当场拉到新上限，
    /// 夹住 lastGood，清连续数，翻 epoch，发 `limit_lowered`。
    pub fn set_growth_limit(&mut self, now: u64, limit: u32) -> Vec<Change> {
        let mut changes = self.idle_reset(now);
        self.growth_limit = limit.max(self.initial);
        if self.cap <= self.growth_limit {
            return changes;
        }
        let previous = self.cap;
        self.cap = self.growth_limit;
        if self.last_good.is_some_and(|good| good > self.cap) {
            self.last_good = Some(self.cap);
        }
        self.success_streak = 0;
        self.epoch += 1;
        changes.push(self.change(previous, ChangeReason::LimitLowered));
        changes
    }

    /// 起跳（Node `seed`）：把 cap 当场拉到 `min(target, 增长上限)`，清 lastGood 与 lastBad（起跳点是新的起点，不是对已证明
    /// 水平的探测），清连续数，翻 epoch。目标不高于 cap，或五分钟内有过限流，就什么也不做。
    pub fn seed(&mut self, now: u64, target: u32) -> Vec<Change> {
        let mut changes = self.idle_reset(now);
        let next = target.min(self.growth_limit);
        if next <= self.cap {
            return changes;
        }
        if self
            .last_throttled_at
            .is_some_and(|at| now.saturating_sub(at) < IDLE_RESET_MS)
        {
            return changes;
        }
        let previous = self.cap;
        self.cap = next;
        self.last_good = None;
        self.last_bad = None;
        self.success_streak = 0;
        self.epoch += 1;
        changes.push(self.change(previous, ChangeReason::Seeded));
        changes
    }

    fn change(&self, previous: u32, reason: ChangeReason) -> Change {
        Change {
            previous,
            next: self.cap,
            reason,
            last_good: self.last_good,
            last_bad: self.last_bad,
            cooldown_ms: None,
        }
    }
}

#[cfg(test)]
#[path = "controller_tests.rs"]
mod tests;
