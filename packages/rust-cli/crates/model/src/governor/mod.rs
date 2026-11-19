//! 进程级模型请求治理器（F5 W6b 第一部分；Node `workflow-concurrency-governor.ts`）。
//!
//! 同一个进程里的所有 run 与主代理共享一个 provider 配额，所以治理器是进程级的：每个 `provider/model` 一个桶，
//! 每个桶一个 AIMD 控制器（[`controller`]），准入按**每次模型请求尝试**做，退避睡眠不占名额。
//!
//! 三种准入范围（[`AdmissionScope`]）：`Observer` 永不排队（主代理），`SessionSubagents` 是主代理的子代理（同一父会话
//! 一条队列），`Run` 是工作流 run（队列按 run 轮转）。时钟与定时器都注入（测试用假的）。冷却到期的唤醒用定时器回调，
//! 回调带代数号：每次重新安排都加一，过期的回调什么也不做，所以取消或重排之后不会误唤醒。
//!
//! 锁只在同步段里持有，从不跨 `.await`（clippy 禁止持有 tokio 的 guard，这里用 std 的 `Mutex`，只在不 await 的段落里用）。
//! 等待者用 oneshot 收名额：治理器在锁内发出 [`Grant`]，取消时在锁内把自己从队列里移走或收回已发的名额。

pub mod controller;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use futures_util::future::BoxFuture;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::model::ModelError;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::admission::{AdmissionScope, AdmissionTicket, AttemptSignal, RequestAdmission};
use controller::{Controller, Snapshot};

/// 定时器：`delay` 之后调用回调（生产用 tokio，测试用假的）。
pub type Scheduler = Arc<dyn Fn(Duration, Box<dyn FnOnce() + Send>) + Send + Sync>;

/// 主代理的 run 标识（Node `OBSERVER_RUN_ID`，以 `\0` 开头，不会与 run 的 ID 冲突）。
const OBSERVER_RUN: &str = "\0observer";
/// 子代理池的 run 标识前缀（Node `SESSION_SUBAGENTS_RUN_PREFIX`）。
const SUBAGENTS_PREFIX: &str = "\0subagents:";
/// 默认并发的地板、上限与保留的核数（Node `workflow-default-concurrency.ts`）。
const DEFAULT_FLOOR: usize = 4;
const DEFAULT_CAP: usize = 16;
const RESERVED_CORES: usize = 2;
/// 自动增长的上限是 D 的这么多倍（Node `WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR`）。
const GROWTH_FACTOR: u32 = 2;

/// 桶的 key：`provider/model`（Node `workflowConcurrencyKey`）。
pub fn model_key(provider: &str, model: &str) -> String {
    format!("{provider}/{model}")
}

/// 默认并发 D：`max(4, min(16, cores − 2))`（Node `resolveWorkflowDefaultConcurrency`）。
pub fn default_concurrency(available_parallelism: usize) -> u32 {
    let usable = available_parallelism.saturating_sub(RESERVED_CORES);
    usable.clamp(DEFAULT_FLOOR, DEFAULT_CAP) as u32
}

pub struct Governor {
    me: Weak<Governor>,
    clock: Arc<dyn Clock>,
    default_concurrency: u32,
    schedule: Scheduler,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    buckets: HashMap<String, Bucket>,
    next_waiter: u64,
}

struct Bucket {
    controller: Controller,
    /// 每个 run 的在飞数（Node `inFlightByRun`）。
    in_flight_by_run: HashMap<String, u32>,
    /// 按 run 排队。插入顺序就是轮转顺序（Node `queues` 的 Map 顺序）。
    queues: Vec<(String, VecDeque<Waiter>)>,
    last_granted_run: Option<String>,
    /// 冷却唤醒的代数（见模块文档）。
    wake_generation: u64,
}

struct Waiter {
    id: u64,
    tx: oneshot::Sender<Grant>,
}

/// 一次准入的名额：送给等待者，它的 epoch 随票一起走。
struct Grant {
    epoch: u64,
}

/// 排队中的一个等待者。丢弃时（取消、或在拿到名额之前就被丢弃）：还在队列里就移走；名额已经发出但没有被取走的，
/// 把它收回来并以结束结算，否则 in_flight 会永远多一个（Codex P1）。取到名额后 `rx` 置空，丢弃什么也不做。
struct Queued {
    governor: Arc<Governor>,
    key: String,
    run: String,
    id: u64,
    rx: Option<oneshot::Receiver<Grant>>,
}

impl Drop for Queued {
    fn drop(&mut self) {
        let Some(mut rx) = self.rx.take() else {
            return;
        };
        let granted = {
            let mut state = self.governor.lock();
            if self
                .governor
                .remove_waiter(&mut state, &self.key, &self.run, self.id)
            {
                None
            } else {
                rx.close();
                rx.try_recv().ok()
            }
        };
        if let Some(grant) = granted {
            drop(
                self.governor
                    .ticket(&self.key, self.run.clone(), grant.epoch),
            );
        }
    }
}

fn run_id(scope: &AdmissionScope) -> String {
    match scope {
        AdmissionScope::Observer => OBSERVER_RUN.to_owned(),
        AdmissionScope::Run(id) => id.clone(),
        AdmissionScope::SessionSubagents(parent) => format!("{SUBAGENTS_PREFIX}{parent}"),
    }
}

impl Bucket {
    fn new(default_concurrency: u32) -> Self {
        Self {
            controller: Controller::new(default_concurrency, default_concurrency * GROWTH_FACTOR),
            in_flight_by_run: HashMap::new(),
            queues: Vec::new(),
            last_granted_run: None,
            wake_generation: 0,
        }
    }

    fn waiter_count(&self) -> u32 {
        self.queues
            .iter()
            .map(|(_, queue)| queue.len() as u32)
            .sum()
    }

    fn bump(&mut self, run: &str, delta: i64) {
        let entry = self.in_flight_by_run.entry(run.to_owned()).or_insert(0);
        let next = i64::from(*entry) + delta;
        if next <= 0 {
            self.in_flight_by_run.remove(run);
        } else {
            *entry = u32::try_from(next).unwrap_or(u32::MAX);
        }
    }

    /// 轮到哪个 run：有等待者的 run 按插入顺序，取上一个被准入的 run 之后的那个（Node `nextRunWithWaiters`）。
    fn next_run_with_waiters(&self) -> Option<usize> {
        let runs: Vec<usize> = self
            .queues
            .iter()
            .enumerate()
            .filter(|(_, (_, queue))| !queue.is_empty())
            .map(|(index, _)| index)
            .collect();
        if runs.is_empty() {
            return None;
        }
        let position = self
            .last_granted_run
            .as_ref()
            .and_then(|last| runs.iter().position(|index| self.queues[*index].0 == *last));
        let next = position.map_or(0, |p| (p + 1) % runs.len());
        Some(runs[next])
    }
}

impl Governor {
    /// `default_concurrency` 是起始值与空闲重置的落点（D）；自动增长上限是 2D。
    pub fn new(clock: Arc<dyn Clock>, default_concurrency: u32, schedule: Scheduler) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            clock,
            default_concurrency,
            schedule,
            state: Mutex::new(State::default()),
        })
    }

    /// 快路径：门开着且没有人排队时才给票（Node `tryAdmit`）。`Observer` 总是给。
    pub fn try_admit(
        self: &Arc<Self>,
        scope: &AdmissionScope,
        key: &str,
    ) -> Option<Box<dyn AdmissionTicket>> {
        let run = run_id(scope);
        if *scope == AdmissionScope::Observer {
            return Some(self.grant_now(key, &run));
        }
        let now = self.clock.now_ms();
        let mut state = self.lock();
        let bucket = self.bucket(&mut state, key);
        bucket.controller.observe(now);
        if bucket.waiter_count() > 0 || !bucket.controller.can_admit(now) {
            return None;
        }
        let epoch = Self::grant(bucket, now, &run);
        drop(state);
        Some(self.ticket(key, run, epoch))
    }

    /// 排队准入（Node `admit`）：等到门开着、冷却过期、轮到这个 run。`cancel` 中断时离开队列、不占名额。
    /// 主代理（`Observer`）不排队，立即给票。
    pub async fn admit(
        self: &Arc<Self>,
        scope: &AdmissionScope,
        key: &str,
        cancel: &CancellationToken,
    ) -> Result<Box<dyn AdmissionTicket>, ModelError> {
        if cancel.is_cancelled() {
            return Err(ModelError::Cancelled);
        }
        let run = run_id(scope);
        if *scope == AdmissionScope::Observer {
            return Ok(self.grant_now(key, &run));
        }
        let mut queued = {
            let mut state = self.lock();
            let id = state.next_waiter;
            state.next_waiter += 1;
            let (tx, rx) = oneshot::channel();
            let bucket = self.bucket(&mut state, key);
            match bucket.queues.iter_mut().find(|(name, _)| *name == run) {
                Some((_, queue)) => queue.push_back(Waiter { id, tx }),
                None => bucket
                    .queues
                    .push((run.clone(), VecDeque::from([Waiter { id, tx }]))),
            }
            let now = self.clock.now_ms();
            self.drain(&mut state, key, now);
            Queued {
                governor: self.clone(),
                key: key.to_owned(),
                run,
                id,
                rx: Some(rx),
            }
        };
        let received = match queued.rx.as_mut() {
            None => None,
            Some(rx) => tokio::select! {
                biased;
                received = rx => Some(received),
                () = cancel.cancelled() => None,
            },
        };
        match received {
            Some(Ok(grant)) => {
                // 名额已经拿到：不再需要收回，交给票。
                let run = queued.run.clone();
                queued.rx = None;
                Ok(self.ticket(key, run, grant.epoch))
            }
            // 取消，或发送端被丢弃：`Queued` 的丢弃路径负责离开队列或还回名额。
            Some(Err(_)) | None => Err(ModelError::Cancelled),
        }
    }

    /// 只读快照（Node `snapshot`）；没有这个 key 的桶时 None。
    pub fn snapshot(&self, key: &str) -> Option<Snapshot> {
        self.lock()
            .buckets
            .get(key)
            .map(|bucket| bucket.controller.snapshot())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // 锁中毒只可能来自 panic；治理器的状态仍可用，继续用它。
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn bucket<'a>(&self, state: &'a mut State, key: &str) -> &'a mut Bucket {
        state
            .buckets
            .entry(key.to_owned())
            .or_insert_with(|| Bucket::new(self.default_concurrency))
    }

    /// 准入一个请求：先做空闲重置，再记入在飞数与 epoch（Node `grant`）。
    fn grant(bucket: &mut Bucket, now: u64, run: &str) -> u64 {
        bucket.controller.observe(now);
        let epoch = bucket.controller.admitted(now);
        bucket.bump(run, 1);
        bucket.last_granted_run = Some(run.to_owned());
        epoch
    }

    fn grant_now(self: &Arc<Self>, key: &str, run: &str) -> Box<dyn AdmissionTicket> {
        let now = self.clock.now_ms();
        let epoch = {
            let mut state = self.lock();
            let bucket = self.bucket(&mut state, key);
            Self::grant(bucket, now, run)
        };
        self.ticket(key, run.to_owned(), epoch)
    }

    fn ticket(self: &Arc<Self>, key: &str, run: String, epoch: u64) -> Box<dyn AdmissionTicket> {
        Box::new(Ticket {
            governor: self.clone(),
            key: key.to_owned(),
            run,
            epoch,
            done: false,
        })
    }

    /// 一次尝试结束：把结局交给控制器，减在飞数，然后尽量准入排队的人。
    fn finish(&self, key: &str, run: &str, epoch: u64, signal: AttemptSignal) {
        let now = self.clock.now_ms();
        let mut state = self.lock();
        let Some(bucket) = state.buckets.get_mut(key) else {
            return;
        };
        // 控制器返回的 cap 变化在 W6b 第二部分才扇出成事件（见 9.9）：这里只要它的状态效果。
        let _changes = match signal {
            AttemptSignal::Completed => bucket.controller.succeeded(now, epoch),
            AttemptSignal::Throttled {
                reason,
                retry_after_ms,
            } => bucket
                .controller
                .throttled(now, epoch, reason, retry_after_ms),
            AttemptSignal::FailedTransient => bucket.controller.failed_transient(now),
            AttemptSignal::Ended => bucket.controller.ended(now),
        };
        bucket.bump(run, -1);
        self.drain(&mut state, key, now);
    }

    /// 尽量准入：门开着且有人等，就按轮转发名额；然后同步等待者数，并安排冷却到期的唤醒（Node `drain`）。
    /// 整个操作只读一次时钟（`now`），准入与安排唤醒都用它：两次读数之间越过截止时间会丢掉唤醒（Codex #560 P1）。
    fn drain(&self, state: &mut State, key: &str, now: u64) {
        let Some(bucket) = state.buckets.get_mut(key) else {
            return;
        };
        bucket.controller.observe(now);
        bucket.controller.waiters(now, bucket.waiter_count());
        while bucket.controller.can_admit(now) {
            let Some(index) = bucket.next_run_with_waiters() else {
                break;
            };
            let run = bucket.queues[index].0.clone();
            let waiter = bucket.queues[index].1.pop_front();
            if bucket.queues[index].1.is_empty() {
                bucket.queues.remove(index);
            }
            let Some(waiter) = waiter else {
                continue;
            };
            let epoch = Self::grant(bucket, now, &run);
            if waiter.tx.send(Grant { epoch }).is_err() {
                // 等待者已经不在了：把刚给的名额还回去（以取消结束）。
                bucket.controller.ended(now);
                bucket.bump(&run, -1);
            }
        }
        bucket.controller.waiters(now, bucket.waiter_count());
        self.arm(state, key, now);
    }

    /// 把队列里的一个等待者移走（取消）。返回是否真的在队列里。
    fn remove_waiter(&self, state: &mut State, key: &str, run: &str, id: u64) -> bool {
        let now = self.clock.now_ms();
        let Some(bucket) = state.buckets.get_mut(key) else {
            return false;
        };
        let Some(index) = bucket.queues.iter().position(|(name, _)| name == run) else {
            return false;
        };
        let queue = &mut bucket.queues[index].1;
        let Some(position) = queue.iter().position(|waiter| waiter.id == id) else {
            return false;
        };
        queue.remove(position);
        if queue.is_empty() {
            bucket.queues.remove(index);
        }
        bucket.controller.waiters(now, bucket.waiter_count());
        // 离开队列后马上看看剩下的等待者能不能拿到名额（冷却可能已经过了截止时间，只是定时器还没跑）。
        self.drain(state, key, now);
        true
    }

    /// 冷却到期时唤醒这个桶的等待者（Node `armCooldownWake`）。只在冷却还没到期、且有人等时安排。
    fn arm(&self, state: &mut State, key: &str, now: u64) {
        let Some(bucket) = state.buckets.get_mut(key) else {
            return;
        };
        bucket.wake_generation += 1;
        if bucket.waiter_count() == 0 {
            return;
        }
        let Some(until) = bucket.controller.snapshot().cooldown_until else {
            return;
        };
        if until <= now {
            return;
        }
        let delay = Duration::from_millis(until - now);
        let generation = bucket.wake_generation;
        let me = self.me.clone();
        let key = key.to_owned();
        (self.schedule)(
            delay,
            Box::new(move || {
                if let Some(governor) = me.upgrade() {
                    governor.wake(&key, generation);
                }
            }),
        );
    }

    /// 定时器到期：代数还对得上才准入（过期的回调什么也不做）。
    fn wake(&self, key: &str, generation: u64) {
        let mut state = self.lock();
        let current = state
            .buckets
            .get(key)
            .is_some_and(|bucket| bucket.wake_generation == generation);
        if current {
            let now = self.clock.now_ms();
            self.drain(&mut state, key, now);
        }
    }
}

impl RequestAdmission for Governor {
    fn acquire<'a>(
        &'a self,
        scope: AdmissionScope,
        key: String,
        cancel: CancellationToken,
    ) -> BoxFuture<'a, Result<Box<dyn AdmissionTicket>, ModelError>> {
        Box::pin(async move {
            let me = self.me.upgrade().ok_or(ModelError::Cancelled)?;
            me.admit(&scope, &key, &cancel).await
        })
    }
}

/// 一张票：结算一次；丢弃时按 `Ended` 结束（Node `release()`）。
struct Ticket {
    governor: Arc<Governor>,
    key: String,
    run: String,
    epoch: u64,
    done: bool,
}

impl AdmissionTicket for Ticket {
    fn settle(mut self: Box<Self>, signal: AttemptSignal) {
        self.done = true;
        self.governor
            .finish(&self.key, &self.run, self.epoch, signal);
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if !self.done {
            self.governor
                .finish(&self.key, &self.run, self.epoch, AttemptSignal::Ended);
        }
    }
}

/// 进程级的治理器（Node `getWorkflowConcurrencyGovernor`）：第一次取时按 CPU 算 D。
pub fn process() -> Arc<Governor> {
    static PROCESS: OnceLock<Arc<Governor>> = OnceLock::new();
    PROCESS
        .get_or_init(|| {
            let cores = std::thread::available_parallelism().map_or(1, usize::from);
            Governor::new(
                Arc::new(rust_cli_base::clock::SystemClock::utc()),
                default_concurrency(cores),
                Arc::new(|delay, callback| {
                    if let Ok(handle) = tokio::runtime::Handle::try_current() {
                        handle.spawn(async move {
                            tokio::time::sleep(delay).await;
                            callback();
                        });
                    }
                }),
            )
        })
        .clone()
}

#[cfg(test)]
mod tests;
