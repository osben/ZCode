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

use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex, OnceLock, Weak, mpsc};
use std::time::{Duration, Instant};

use futures_util::future::BoxFuture;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::model::ModelError;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::admission::{AdmissionScope, AdmissionTicket, AttemptSignal, RequestAdmission, RunId};
use controller::{Change, Controller, Snapshot};

/// 定时器：`delay` 之后调用回调（生产用 tokio，测试用假的）。
///
/// 契约：调度器可以同步回调。这时调用方必须先让时钟越过截止时间再回调；否则回调会 `wake` → `drain` → `arm` → 再次
/// `fire`，在冷却期间无限递归。调用方（`fire`）在锁外调用调度器，所以同步回调不会死锁。
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
    /// 监听者（Node `listeners`）。与 `state` 分开加锁：扇出时在 `state` 的锁里读它，回调在两把锁都放掉之后才调用。
    listeners: Mutex<Listeners>,
}

/// 一次 cap 变化，连同它的桶的 key（Node `ConcurrencyChange`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapChange {
    pub key: String,
    pub change: Change,
}

/// 一个 run 的监听者：每次它 engaged 的 key 上有 cap 变化就调用一次。
pub type Listener = Arc<dyn Fn(&CapChange) + Send + Sync>;

/// 监听者表：按 run 分组，每个监听者带一个订阅号（退订用）。
#[derive(Default)]
struct Listeners {
    next: u64,
    by_run: HashMap<String, Vec<(u64, Listener)>>,
}

/// 订阅的句柄（Node 的退订函数）。不调用 `unsubscribe` 时监听者一直有效，与 Node 忽略返回值的行为一致。
pub struct Subscription {
    governor: Weak<Governor>,
    run: String,
    id: u64,
}

impl Subscription {
    /// 退订：之后这个 run 不再收到扇出（Node `subscribe` 返回的函数）。
    pub fn unsubscribe(self) {
        let Some(governor) = self.governor.upgrade() else {
            return;
        };
        let mut listeners = governor.listeners();
        if let Some(list) = listeners.by_run.get_mut(&self.run) {
            list.retain(|(id, _)| *id != self.id);
            if list.is_empty() {
                listeners.by_run.remove(&self.run);
            }
        }
    }
}

#[derive(Default)]
struct State {
    buckets: HashMap<String, Bucket>,
    next_waiter: u64,
    /// 各 run 登记的上界（Node `runBounds`）。
    run_bounds: HashMap<String, u32>,
}

/// 锁外要做的事：给监听者的 cap 变化，以及冷却到期的唤醒。
#[derive(Default)]
struct Effects {
    changes: Vec<(Listener, CapChange)>,
    wake: Option<Wake>,
}

struct Bucket {
    controller: Controller,
    /// 每个 run 的在飞数（Node `inFlightByRun`）。
    in_flight_by_run: HashMap<String, u32>,
    /// 按 run 排队。插入顺序就是轮转顺序（Node `queues` 的 Map 顺序）。
    queues: Vec<(String, VecDeque<Waiter>)>,
    last_granted_run: Option<String>,
    /// 用过这个 key 的 run（Node `runs`，不含观察者与子代理池）：它们登记的上界计入这个桶。
    runs: HashSet<String>,
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
///
/// 不变量：`defused` 只在取到名额（`admit` 的成功分支）时置位；此时名额已经属于票，丢弃什么也不做。
struct Queued {
    governor: Arc<Governor>,
    key: String,
    run: String,
    id: u64,
    rx: oneshot::Receiver<Grant>,
    defused: bool,
}

impl Drop for Queued {
    fn drop(&mut self) {
        if self.defused {
            return;
        }
        let now = self.governor.clock.now_ms();
        let (granted, effects) = {
            let mut state = self.governor.lock();
            let mut effects = Effects::default();
            let removed = self.governor.remove_waiter(
                &mut state,
                &self.key,
                &self.run,
                self.id,
                now,
                &mut effects,
            );
            let granted = if removed {
                None
            } else {
                // 已经发出了名额但没有被取走：收回来，以结束结算。
                self.rx.close();
                self.rx.try_recv().ok()
            };
            (granted, effects)
        };
        self.governor.fire(effects);
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
        AdmissionScope::Run(id) => id.as_str().to_owned(),
        AdmissionScope::SessionSubagents(parent) => {
            format!("{SUBAGENTS_PREFIX}{}", parent.as_str())
        }
    }
}

/// 桶（没有时建一个，起点是默认并发 D）。快路径不分配：只有第一次见到这个 key 时才拷贝 key。
fn bucket_in<'a>(
    buckets: &'a mut HashMap<String, Bucket>,
    default_concurrency: u32,
    key: &str,
) -> &'a mut Bucket {
    if !buckets.contains_key(key) {
        buckets.insert(key.to_owned(), Bucket::new(default_concurrency));
    }
    match buckets.get_mut(key) {
        Some(bucket) => bucket,
        None => unreachable!("the bucket was inserted above"),
    }
}

/// 这个 run 在这个桶上是否 engaged（有在飞或排队的请求；或者登记过上界的 run，`also`）。Node `fanOut` 的判断。
fn engaged(bucket: &Bucket, run: &str, also: Option<&HashSet<String>>) -> bool {
    bucket
        .in_flight_by_run
        .get(run)
        .is_some_and(|count| *count > 0)
        || bucket
            .queues
            .iter()
            .any(|(name, queue)| name == run && !queue.is_empty())
        || also.is_some_and(|runs| runs.contains(run))
}

/// 冷却到期的唤醒要不要安排（Node `armCooldownWake`）：返回这次操作留下的唤醒，代数号已经推进。
fn arm(bucket: &mut Bucket, key: &str, now: u64) -> Option<Wake> {
    bucket.wake_generation += 1;
    if bucket.waiter_count() == 0 {
        return None;
    }
    let until = bucket.controller.snapshot().cooldown_until?;
    if until <= now {
        return None;
    }
    Some(Wake {
        delay: Duration::from_millis(until - now),
        key: key.to_owned(),
        generation: bucket.wake_generation,
    })
}

impl Bucket {
    fn new(default_concurrency: u32) -> Self {
        Self {
            controller: Controller::new(
                default_concurrency,
                default_concurrency.saturating_mul(GROWTH_FACTOR),
            ),
            in_flight_by_run: HashMap::new(),
            queues: Vec::new(),
            last_granted_run: None,
            runs: HashSet::new(),
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
            listeners: Mutex::new(Listeners::default()),
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
        let (epoch, effects) = {
            let mut state = self.lock();
            let mut effects = Effects::default();
            if matches!(scope, AdmissionScope::Run(_)) {
                self.note_run_used(&mut state, key, &run, now, &mut effects);
            }
            let bucket = bucket_in(&mut state.buckets, self.default_concurrency, key);
            let observed = bucket.controller.observe(now);
            self.publish(&mut effects, bucket, key, observed, None);
            if bucket.waiter_count() > 0 || !bucket.controller.can_admit(now) {
                (None, effects)
            } else {
                let epoch = self.grant(bucket, now, &run, key, &mut effects);
                (Some(epoch), effects)
            }
        };
        self.fire(effects);
        epoch.map(|epoch| self.ticket(key, run, epoch))
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
        // 入队与准入在同一个锁段里；唤醒与扇出在锁外做（调度器可能同步回调，回调要再拿锁）。
        let (mut queued, effects) = {
            let mut state = self.lock();
            let mut effects = Effects::default();
            let now = self.clock.now_ms();
            if matches!(scope, AdmissionScope::Run(_)) {
                self.note_run_used(&mut state, key, &run, now, &mut effects);
            }
            let id = state.next_waiter;
            state.next_waiter += 1;
            let (tx, rx) = oneshot::channel();
            let bucket = bucket_in(&mut state.buckets, self.default_concurrency, key);
            match bucket.queues.iter_mut().find(|(name, _)| *name == run) {
                Some((_, queue)) => queue.push_back(Waiter { id, tx }),
                None => bucket
                    .queues
                    .push((run.clone(), VecDeque::from([Waiter { id, tx }]))),
            }
            self.drain(&mut state, key, now, &mut effects);
            let queued = Queued {
                governor: self.clone(),
                key: key.to_owned(),
                run,
                id,
                rx,
                defused: false,
            };
            (queued, effects)
        };
        self.fire(effects);
        let received = tokio::select! {
            biased;
            received = &mut queued.rx => Some(received),
            () = cancel.cancelled() => None,
        };
        match received {
            Some(Ok(grant)) => {
                // 名额已经拿到：交给票，`Queued` 的丢弃路径不再做事。
                queued.defused = true;
                Ok(self.ticket(key, queued.run.clone(), grant.epoch))
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

    /// 订阅一个 run 的 cap 变化（Node `subscribe`）。扇出只到该 key 上 engaged 的 run。
    pub fn subscribe<F>(self: &Arc<Self>, run: &RunId, listener: F) -> Subscription
    where
        F: Fn(&CapChange) + Send + Sync + 'static,
    {
        let listener: Listener = Arc::new(listener);
        let mut listeners = self.listeners();
        let id = listeners.next;
        listeners.next += 1;
        listeners
            .by_run
            .entry(run.as_str().to_owned())
            .or_default()
            .push((id, listener));
        Subscription {
            governor: Arc::downgrade(self),
            run: run.as_str().to_owned(),
            id,
        }
    }

    /// 登记一个 run 的上界（Node `setRunBound`）：它用过的 key 的增长上限抬到 `max(2D, 这些 run 的上界最大值)`，
    /// 并起跳到上界（五分钟内有过限流则不起跳）。再次登记覆盖旧值。
    pub fn set_run_bound(&self, run: &RunId, bound: u32) {
        let now = self.clock.now_ms();
        let mut effects = Effects::default();
        {
            let mut state = self.lock();
            state.run_bounds.insert(run.as_str().to_owned(), bound);
            let State {
                buckets,
                run_bounds,
                ..
            } = &mut *state;
            for (key, bucket) in buckets.iter_mut() {
                if bucket.runs.contains(run.as_str()) {
                    self.refresh_growth_limit(bucket, run_bounds, key, now, &mut effects);
                }
            }
        }
        self.fire(effects);
    }

    /// 清掉一个 run 的上界（Node `clearRunBound`）：它不再计入任何桶，增长上限落回，高于它的 cap 被拉下来。
    pub fn clear_run_bound(&self, run: &RunId) {
        let now = self.clock.now_ms();
        let mut effects = Effects::default();
        {
            let mut state = self.lock();
            state.run_bounds.remove(run.as_str());
            let State {
                buckets,
                run_bounds,
                ..
            } = &mut *state;
            for (key, bucket) in buckets.iter_mut() {
                if bucket.runs.remove(run.as_str()) {
                    self.refresh_growth_limit(bucket, run_bounds, key, now, &mut effects);
                }
            }
        }
        self.fire(effects);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        // 锁中毒只可能来自 panic；治理器的状态仍可用，继续用它。
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn listeners(&self) -> std::sync::MutexGuard<'_, Listeners> {
        self.listeners
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 自动增长的基数：2D（Node `baseGrowthLimit`）。
    fn base_growth(&self) -> u32 {
        self.default_concurrency.saturating_mul(GROWTH_FACTOR)
    }

    /// 一个 run 第一次在这个 key 上请求准入（Node `noteRunUsed`）：记入桶的 `runs`；它已经登记过上界的话，
    /// 这个桶立刻按它的上界算增长上限（Node 的 run 先用 key、后登记上界，或反过来，结果一样）。
    fn note_run_used(
        &self,
        state: &mut State,
        key: &str,
        run: &str,
        now: u64,
        effects: &mut Effects,
    ) {
        let State {
            buckets,
            run_bounds,
            ..
        } = state;
        let bucket = bucket_in(buckets, self.default_concurrency, key);
        if bucket.runs.contains(run) {
            return;
        }
        bucket.runs.insert(run.to_owned());
        if run_bounds.contains_key(run) {
            self.refresh_growth_limit(bucket, run_bounds, key, now, effects);
        }
    }

    /// 按用过这个桶的 run 的上界重算增长上限，并起跳到最大的上界（Node `refreshGrowthLimit`）。
    /// 这些变化来自 run 的上界，不来自请求，所以扇出到所有登记在这个 key 上的 run（`runs`），哪怕它此刻没有在飞请求。
    fn refresh_growth_limit(
        &self,
        bucket: &mut Bucket,
        run_bounds: &HashMap<String, u32>,
        key: &str,
        now: u64,
        effects: &mut Effects,
    ) {
        let largest = bucket
            .runs
            .iter()
            .filter_map(|run| run_bounds.get(run))
            .copied()
            .max();
        let limit = self.base_growth().max(largest.unwrap_or(0));
        let mut changes = Vec::new();
        if limit != bucket.controller.snapshot().growth_limit {
            changes.extend(bucket.controller.set_growth_limit(now, limit));
        }
        if let Some(target) = largest {
            changes.extend(bucket.controller.seed(now, target));
        }
        self.publish(effects, bucket, key, changes, Some(&bucket.runs));
    }

    /// 把一个桶的 cap 变化排进待办（Node `fanOut`）：收件人是 engaged 的 run 的监听者；`also` 另加一组 run。
    /// 必须在状态锁里调用（engaged 要看当时的状态）；回调在锁外由 `fire` 调用。
    fn publish(
        &self,
        effects: &mut Effects,
        bucket: &Bucket,
        key: &str,
        changes: Vec<Change>,
        also: Option<&HashSet<String>>,
    ) {
        if changes.is_empty() {
            return;
        }
        let recipients: Vec<Listener> = {
            let listeners = self.listeners();
            listeners
                .by_run
                .iter()
                .filter(|(run, _)| engaged(bucket, run, also))
                .flat_map(|(_, list)| list.iter().map(|(_, listener)| listener.clone()))
                .collect()
        };
        for change in changes {
            let cap_change = CapChange {
                key: key.to_owned(),
                change,
            };
            for listener in &recipients {
                effects.changes.push((listener.clone(), cap_change.clone()));
            }
        }
    }

    fn grant_now(self: &Arc<Self>, key: &str, run: &str) -> Box<dyn AdmissionTicket> {
        let now = self.clock.now_ms();
        let (epoch, effects) = {
            let mut state = self.lock();
            let mut effects = Effects::default();
            let bucket = bucket_in(&mut state.buckets, self.default_concurrency, key);
            let epoch = self.grant(bucket, now, run, key, &mut effects);
            (epoch, effects)
        };
        self.fire(effects);
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

    /// 准入一个请求：先做空闲重置（并扇出它的变化），再记入在飞数与 epoch（Node `grant`）。
    fn grant(
        &self,
        bucket: &mut Bucket,
        now: u64,
        run: &str,
        key: &str,
        effects: &mut Effects,
    ) -> u64 {
        let observed = bucket.controller.observe(now);
        self.publish(effects, bucket, key, observed, None);
        let epoch = bucket.controller.admitted(now);
        bucket.bump(run, 1);
        bucket.last_granted_run = Some(run.to_owned());
        epoch
    }

    /// 一次尝试结束：把结局交给控制器，扇出它的变化（发生在减在飞数之前：这个 run 此刻仍 engaged），
    /// 减在飞数，然后尽量准入排队的人。
    fn finish(&self, key: &str, run: &str, epoch: u64, signal: AttemptSignal) {
        let now = self.clock.now_ms();
        let effects = {
            let mut state = self.lock();
            let mut effects = Effects::default();
            let Some(bucket) = state.buckets.get_mut(key) else {
                return;
            };
            let changes = match signal {
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
            self.publish(&mut effects, bucket, key, changes, None);
            bucket.bump(run, -1);
            self.drain(&mut state, key, now, &mut effects);
            effects
        };
        self.fire(effects);
    }

    /// 尽量准入：门开着且有人等，就按轮转发名额；然后同步等待者数，并安排冷却到期的唤醒（Node `drain`）。
    /// 整个操作只读一次时钟（`now`），准入与安排唤醒都用它：两次读数之间越过截止时间会丢掉唤醒（Codex #560 P1）。
    fn drain(&self, state: &mut State, key: &str, now: u64, effects: &mut Effects) {
        let Some(bucket) = state.buckets.get_mut(key) else {
            return;
        };
        let observed = bucket.controller.observe(now);
        self.publish(effects, bucket, key, observed, None);
        loop {
            let waiters = bucket.controller.waiters(now, bucket.waiter_count());
            self.publish(effects, bucket, key, waiters, None);
            if !bucket.controller.can_admit(now) {
                break;
            }
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
            let epoch = self.grant(bucket, now, &run, key, effects);
            if waiter.tx.send(Grant { epoch }).is_err() {
                // 等待者已经不在了：把刚给的名额还回去（以取消结束）。
                let changes = bucket.controller.ended(now);
                self.publish(effects, bucket, key, changes, None);
                bucket.bump(&run, -1);
            }
        }
        let waiters = bucket.controller.waiters(now, bucket.waiter_count());
        self.publish(effects, bucket, key, waiters, None);
        effects.wake = arm(bucket, key, now);
    }

    /// 把队列里的一个等待者移走（取消）。返回是否真的在队列里。
    fn remove_waiter(
        &self,
        state: &mut State,
        key: &str,
        run: &str,
        id: u64,
        now: u64,
        effects: &mut Effects,
    ) -> bool {
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
        let waiters = bucket.controller.waiters(now, bucket.waiter_count());
        self.publish(effects, bucket, key, waiters, None);
        // 离开队列后马上看看剩下的等待者能不能拿到名额（冷却可能已经过了截止时间，只是定时器还没跑）。
        self.drain(state, key, now, effects);
        true
    }

    /// 执行待办：先调用监听者（不持有任何锁），再安排唤醒。唤醒必须在锁外安排：调度器可能同步回调 `wake`，
    /// 回调要再拿锁（同步调度器的契约见 [`Scheduler`]）。
    fn fire(&self, effects: Effects) {
        for (listener, change) in &effects.changes {
            listener(change);
        }
        let Some(wake) = effects.wake else {
            return;
        };
        let me = self.me.clone();
        let Wake {
            delay,
            key,
            generation,
        } = wake;
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
        let effects = {
            let mut state = self.lock();
            let mut effects = Effects::default();
            let current = state
                .buckets
                .get(key)
                .is_some_and(|bucket| bucket.wake_generation == generation);
            if current {
                let now = self.clock.now_ms();
                self.drain(&mut state, key, now, &mut effects);
            }
            effects
        };
        self.fire(effects);
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

/// 待安排的唤醒：到期后按代数号回到治理器（过期的代数什么也不做）。
struct Wake {
    delay: Duration,
    key: String,
    generation: u64,
}

/// 生产用的定时器：有 tokio 运行时就用它；没有（票在普通线程上丢弃）就用一个线程睡到截止时间。
/// 两条路都不会丢唤醒（Codex #560 P2）。
pub fn scheduler() -> Scheduler {
    timer_scheduler(&TIMER_SENDER, start_timer_thread)
}

/// 调度器的实现：`slot` 是定时线程的发送端，`start` 负责启动一条（测试可以注入会失败的启动）。
fn timer_scheduler(
    slot: &'static Mutex<Option<mpsc::Sender<Timer>>>,
    start: fn() -> Option<mpsc::Sender<Timer>>,
) -> Scheduler {
    Arc::new(
        move |delay, callback| match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    tokio::time::sleep(delay).await;
                    callback();
                });
            }
            // 没有运行时（票在普通线程上丢弃）：交给进程里唯一的定时线程。
            Err(_) => {
                if let Some(sender) = timer_sender_in(slot, start) {
                    let seq = TIMER_SEQ.fetch_add(1, Ordering::Relaxed);
                    let at = Instant::now() + delay;
                    // 接收端只在进程结束时消失；发送失败就是进程在收尾，丢掉唤醒无妨。
                    let _ = sender.send(Timer { at, seq, callback });
                }
            }
        },
    )
}

/// 一个待触发的回调：到了 `at` 就调用。堆里按 (at, seq) 取最早的。
struct Timer {
    at: Instant,
    seq: u64,
    callback: Box<dyn FnOnce() + Send>,
}

impl PartialEq for Timer {
    fn eq(&self, other: &Self) -> bool {
        (self.at, self.seq) == (other.at, other.seq)
    }
}

impl Eq for Timer {}

impl PartialOrd for Timer {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Timer {
    /// 反过来比较：`BinaryHeap` 是大顶堆，这样堆顶是最早的那个。
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (other.at, other.seq).cmp(&(self.at, self.seq))
    }
}

/// 定时线程的序号（同一个截止时间按到达顺序触发）。
static TIMER_SEQ: AtomicU64 = AtomicU64::new(0);
/// 启动过的定时线程数（测试用：整个进程只应有一条）。
pub(crate) static TIMER_THREADS: AtomicUsize = AtomicUsize::new(0);
/// 定时线程的发送端。第一次需要时启动线程；启动失败时保持 None，下一次需要时再试（失败不缓存）。
static TIMER_SENDER: Mutex<Option<mpsc::Sender<Timer>>> = Mutex::new(None);

/// 取发送端；没有就用 `start` 启动一条并存下来。`start` 失败时什么都不缓存。
fn timer_sender_in(
    slot: &Mutex<Option<mpsc::Sender<Timer>>>,
    start: fn() -> Option<mpsc::Sender<Timer>>,
) -> Option<mpsc::Sender<Timer>> {
    let mut guard = slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(sender) = guard.as_ref() {
        return Some(sender.clone());
    }
    let sender = start()?;
    *guard = Some(sender.clone());
    Some(sender)
}

/// 启动定时线程并计数（进程里应只有一条）。
fn start_timer_thread() -> Option<mpsc::Sender<Timer>> {
    let started = spawn_timer_thread();
    if started.is_some() {
        TIMER_THREADS.fetch_add(1, Ordering::SeqCst);
    }
    started
}

/// 定时线程启动失败的日志是否已经记过（只记第一次）。
static SPAWN_WARNED: AtomicBool = AtomicBool::new(false);

fn spawn_timer_thread() -> Option<mpsc::Sender<Timer>> {
    let (tx, rx) = mpsc::channel::<Timer>();
    match std::thread::Builder::new()
        .name("governor-timer".to_owned())
        .spawn(move || run_timers(rx))
    {
        Ok(_) => Some(tx),
        Err(error) => {
            // 只在第一次失败时记日志：之后每次需要定时线程都会再试，失败会重复，不能每次都刷日志。
            if !SPAWN_WARNED.swap(true, Ordering::Relaxed) {
                tracing::warn!(%error, "governor timer thread did not start; off-runtime wakes are dropped until one starts");
            }
            None
        }
    }
}

/// panic 的文字（`&str` 或 `String` 的载荷；其他类型给占位文字）。
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic payload".to_owned())
}

/// 定时线程：堆里按截止时间排队，到期就调用。回调在这里（不持有任何治理器的锁）运行。
/// 单个回调的 panic 被截住，不能让整条定时线程死掉（否则之后的唤醒全部丢失）。
fn run_timers(rx: mpsc::Receiver<Timer>) {
    let mut heap: BinaryHeap<Timer> = BinaryHeap::new();
    loop {
        let now = Instant::now();
        while heap.peek().is_some_and(|next| next.at <= now) {
            let Some(due) = heap.pop() else {
                break;
            };
            if let Err(payload) =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(due.callback))
            {
                tracing::error!(
                    message = %panic_message(payload.as_ref()),
                    "governor timer callback panicked; that wake is dropped"
                );
            }
        }
        let incoming = match heap.peek() {
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(next) => rx.recv_timeout(next.at.saturating_duration_since(Instant::now())),
        };
        match incoming {
            Ok(timer) => heap.push(timer),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
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
                scheduler(),
            )
        })
        .clone()
}

#[cfg(test)]
mod tests;
