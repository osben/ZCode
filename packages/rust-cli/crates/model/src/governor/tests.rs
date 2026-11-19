//! 进程级治理器的单元测试（Node `bootstrap/tests/workflow-concurrency-governor.test.ts` 的移植子集）：
//! 桶与门、公平（排队时不走快路径）、observer、按 key 分桶、run 间轮转、取消、Retry-After 冷却与定时唤醒、
//! 配额类失败不算并发信号、票的幂等结算、同一批 429 只减一次、子代理池、空闲重置。定时器与时钟都注入。

#![allow(
    clippy::unwrap_used,
    reason = "测试辅助不在 #[test] 里；失败即测试失败"
)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::testing::ManualClock;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use super::controller::Snapshot;
use super::{Governor, Scheduler, default_concurrency, model_key};
use crate::admission::{AdmissionScope, AdmissionTicket, AttemptSignal, ThrottleReason};

const KEY_A: &str = "prov/alpha";
const KEY_B: &str = "prov/beta";
const D: u32 = 8;

/// 排队中的一次准入：在后台取票，结束时用 `is_finished` 观察。
type Admit = JoinHandle<Result<Box<dyn AdmissionTicket>, ModelError>>;
/// 假定时器里的一次到期回调。
type Callback = Box<dyn FnOnce() + Send>;

/// 假定时器：`advance` 拨时钟并按到期时刻同步触发回调（回调在锁外跑）。
#[derive(Default)]
struct Timers {
    pending: Mutex<Vec<(u64, Callback)>>,
}

struct Harness {
    clock: Arc<ManualClock>,
    timers: Arc<Timers>,
    governor: Arc<Governor>,
}

fn harness(default: u32) -> Harness {
    let clock = Arc::new(ManualClock::new(1_000_000));
    let timers = Arc::new(Timers::default());
    let schedule: Scheduler = {
        let clock = clock.clone();
        let timers = timers.clone();
        Arc::new(move |delay: Duration, callback: Box<dyn FnOnce() + Send>| {
            let at = clock.now_ms() + u64::try_from(delay.as_millis()).unwrap_or(u64::MAX);
            timers.pending.lock().unwrap().push((at, callback));
        })
    };
    let governor = Governor::new(clock.clone(), default, schedule);
    Harness {
        clock,
        timers,
        governor,
    }
}

impl Harness {
    fn advance(&self, ms: u64) {
        self.clock.advance(ms);
        let now = self.clock.now_ms();
        let due: Vec<_> = {
            let mut pending = self.timers.pending.lock().unwrap();
            let (due, rest): (Vec<_>, Vec<_>) = pending.drain(..).partition(|(at, _)| *at <= now);
            *pending = rest;
            due
        };
        for (_, callback) in due {
            callback();
        }
    }

    fn pending_timers(&self) -> usize {
        self.timers.pending.lock().unwrap().len()
    }

    fn snapshot(&self, key: &str) -> Snapshot {
        self.governor.snapshot(key).unwrap()
    }
}

fn run(id: &str) -> AdmissionScope {
    AdmissionScope::Run(id.to_owned())
}

/// 等待者：在后台排队取票，结束时用 `is_finished` 观察。
fn queue(
    governor: &Arc<Governor>,
    scope: AdmissionScope,
    key: &str,
) -> JoinHandle<Result<Box<dyn AdmissionTicket>, ModelError>> {
    let governor = governor.clone();
    let key = key.to_owned();
    tokio::spawn(async move {
        governor
            .admit(&scope, &key, &CancellationToken::new())
            .await
    })
}

async fn settle_tasks() {
    for _ in 0..16 {
        tokio::task::yield_now().await;
    }
}

fn fast(governor: &Arc<Governor>, scope: &AdmissionScope, key: &str) -> Box<dyn AdmissionTicket> {
    governor
        .try_admit(scope, key)
        .expect("the fast path should hit: the gate is open and nobody is queued")
}

fn throttle(ticket: Box<dyn AdmissionTicket>, retry_after_ms: Option<u64>) {
    ticket.settle(AttemptSignal::Throttled {
        reason: ThrottleReason::RateLimited,
        retry_after_ms,
    });
}

/// 已结束的等待者取出它的票；没有结束时中止它并返回 None。
fn finished(
    handle: JoinHandle<Result<Box<dyn AdmissionTicket>, ModelError>>,
) -> Option<Box<dyn AdmissionTicket>> {
    if !handle.is_finished() {
        handle.abort();
        return None;
    }
    handle.now_or_never()?.ok()?.ok()
}

/// 取出第一个已经拿到名额的等待者（标签与票）。
fn take_finished(
    waiters: &mut Vec<(&'static str, Admit)>,
) -> Option<(&'static str, Box<dyn AdmissionTicket>)> {
    let index = waiters
        .iter()
        .position(|(_, handle)| handle.is_finished())?;
    let (label, handle) = waiters.remove(index);
    finished(handle).map(|ticket| (label, ticket))
}

#[test]
fn the_default_concurrency_is_floored_at_four_and_capped_at_sixteen() {
    assert_eq!(default_concurrency(1), 4);
    assert_eq!(default_concurrency(6), 4);
    assert_eq!(default_concurrency(8), 6);
    assert_eq!(default_concurrency(18), 16);
    assert_eq!(default_concurrency(64), 16);
}

#[test]
fn a_model_key_is_provider_and_model() {
    assert_eq!(model_key("prov", "alpha"), KEY_A);
}

#[tokio::test]
async fn the_first_d_fast_admissions_hit_and_the_next_waits_until_a_slot_frees() {
    let h = harness(D);
    let scope = run("A");
    let tickets: Vec<_> = (0..D).map(|_| fast(&h.governor, &scope, KEY_A)).collect();
    assert!(h.governor.try_admit(&scope, KEY_A).is_none());
    let waiting = queue(&h.governor, scope.clone(), KEY_A);
    settle_tasks().await;
    assert!(!waiting.is_finished());
    assert_eq!(h.snapshot(KEY_A).waiters, 1);

    let mut tickets = tickets;
    tickets.remove(0).settle(AttemptSignal::Completed);
    settle_tasks().await;
    let granted = finished(waiting);
    assert!(granted.is_some());
    assert_eq!(h.snapshot(KEY_A).in_flight, D);
    assert_eq!(h.snapshot(KEY_A).waiters, 0);
}

#[tokio::test]
async fn queued_waiters_close_the_fast_path_for_every_run() {
    let h = harness(1);
    let first = fast(&h.governor, &run("A"), KEY_A);
    let waiting = queue(&h.governor, run("B"), KEY_A);
    settle_tasks().await;
    first.settle(AttemptSignal::Completed);
    settle_tasks().await;
    let b = finished(waiting).expect("B is granted the slot first");
    assert!(
        h.governor.try_admit(&run("A"), KEY_A).is_none(),
        "A cannot overtake the queued work"
    );
    b.settle(AttemptSignal::Completed);
}

#[tokio::test]
async fn an_observer_admits_at_once_counts_in_flight_and_ignores_cooldown() {
    let h = harness(1);
    let busy = fast(&h.governor, &run("A"), KEY_A);
    let main = h
        .governor
        .admit(&AdmissionScope::Observer, KEY_A, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(h.snapshot(KEY_A).in_flight, 2, "the observer is counted");
    throttle(main, Some(30_000));
    assert!(h.snapshot(KEY_A).cooldown_until.is_some());
    // During the cooldown the observer still admits; a workflow run cannot.
    let again = h
        .governor
        .admit(&AdmissionScope::Observer, KEY_A, &CancellationToken::new())
        .await
        .unwrap();
    assert!(h.governor.try_admit(&run("A"), KEY_A).is_none());
    again.settle(AttemptSignal::Completed);
    busy.settle(AttemptSignal::Completed);
    assert_eq!(h.snapshot(KEY_A).in_flight, 0);
}

#[tokio::test]
async fn a_429_halves_the_bucket_to_three_quarters_and_other_models_are_untouched() {
    let h = harness(D);
    throttle(fast(&h.governor, &run("A"), KEY_A), None);
    assert_eq!(h.snapshot(KEY_A).cap, 6, "8 x 0.75");
    assert!(
        h.governor.snapshot(KEY_B).is_none(),
        "no bucket until B is used"
    );
    let hits: Vec<_> = (0..D)
        .map(|_| h.governor.try_admit(&run("B"), KEY_B))
        .collect();
    assert!(hits.iter().all(Option::is_some));
    assert_eq!(h.snapshot(KEY_B).cap, D);
}

#[tokio::test]
async fn a_success_grows_the_cap_only_with_demand_and_after_four_successes() {
    let h = harness(4);
    let scope = run("A");
    let mut live: Vec<_> = (0..4).map(|_| fast(&h.governor, &scope, KEY_A)).collect();
    // Keep one waiter queued so the streak applies; each success backfills it.
    let mut waiting = queue(&h.governor, scope.clone(), KEY_A);
    settle_tasks().await;
    for _ in 0..4 {
        let done = live.remove(0);
        done.settle(AttemptSignal::Completed);
        settle_tasks().await;
        let next = finished(waiting).expect("the waiter is backfilled");
        live.push(next);
        waiting = queue(&h.governor, scope.clone(), KEY_A);
        settle_tasks().await;
    }
    assert_eq!(h.snapshot(KEY_A).cap, 5);
    for ticket in live {
        ticket.settle(AttemptSignal::Completed);
    }
    waiting.abort();
}

#[tokio::test]
async fn runs_rotate_so_a_large_fan_out_cannot_starve_a_small_run() {
    let h = harness(1);
    let holder = fast(&h.governor, &run("holder"), KEY_A);
    let mut waiters = Vec::new();
    for _ in 0..10 {
        waiters.push(("A", queue(&h.governor, run("A"), KEY_A)));
    }
    waiters.push(("B", queue(&h.governor, run("B"), KEY_A)));
    settle_tasks().await;
    holder.settle(AttemptSignal::Completed);
    settle_tasks().await;
    // Each granted slot is settled so the next run in the rotation can take it.
    let (first_label, first) = take_finished(&mut waiters).expect("the first slot is granted");
    first.settle(AttemptSignal::Completed);
    settle_tasks().await;
    let (second_label, second) = take_finished(&mut waiters).expect("the second slot is granted");
    second.settle(AttemptSignal::Completed);
    assert_eq!(
        [first_label, second_label],
        ["A", "B"],
        "B's first request is not behind A's second"
    );
    for (_, handle) in waiters {
        handle.abort();
    }
}

#[tokio::test]
async fn cancelling_while_waiting_leaves_the_queue_and_the_slots_alone() {
    let h = harness(1);
    let first = fast(&h.governor, &run("A"), KEY_A);
    let cancel = CancellationToken::new();
    let governor = h.governor.clone();
    let token = cancel.clone();
    let waiting =
        tokio::spawn(async move { governor.admit(&run("A"), KEY_A, &token).await.map(|_| ()) });
    settle_tasks().await;
    assert_eq!(h.snapshot(KEY_A).waiters, 1);

    cancel.cancel();
    let result = waiting.await.unwrap();
    assert!(matches!(result, Err(ModelError::Cancelled)));
    assert_eq!(
        h.snapshot(KEY_A).waiters,
        0,
        "the cancelled request left the queue"
    );
    assert_eq!(
        h.snapshot(KEY_A).in_flight,
        1,
        "no slot was taken by the cancelled request"
    );
    first.settle(AttemptSignal::Completed);
    assert_eq!(h.snapshot(KEY_A).in_flight, 0);
}

#[tokio::test]
async fn retry_after_freezes_admission_until_the_deadline_then_the_timer_wakes_the_waiter() {
    let h = harness(D);
    throttle(fast(&h.governor, &run("A"), KEY_A), Some(20_000));
    let snapshot = h.snapshot(KEY_A);
    assert_eq!(snapshot.cap, 6);
    assert_eq!(snapshot.cooldown_until, Some(1_000_000 + 20_000));
    assert!(h.governor.try_admit(&run("A"), KEY_A).is_none());

    let waiting = queue(&h.governor, run("A"), KEY_A);
    settle_tasks().await;
    assert!(!waiting.is_finished());
    assert_eq!(h.pending_timers(), 1);

    h.advance(19_999);
    settle_tasks().await;
    assert!(!waiting.is_finished());
    h.advance(1);
    settle_tasks().await;
    assert!(finished(waiting).is_some());
}

#[tokio::test]
async fn a_quota_stop_failure_moves_neither_the_cap_nor_the_cooldown() {
    // 1308 类配额失败属于 Stop 集：只结束尝试（`Ended`），resume 立即准入。
    let h = harness(D);
    let ticket = fast(&h.governor, &run("A"), KEY_A);
    ticket.settle(AttemptSignal::of_error(&ModelError::QuotaExhausted {
        message: "5 小时的使用上限".into(),
    }));
    let snapshot = h.snapshot(KEY_A);
    assert_eq!((snapshot.cap, snapshot.in_flight), (D, 0));
    assert_eq!(snapshot.cooldown_until, None);
    assert!(h.governor.try_admit(&run("resumed"), KEY_A).is_some());
}

#[tokio::test]
async fn a_dropped_ticket_releases_its_slot_as_ended_and_a_settled_one_is_not_released_twice() {
    let h = harness(2);
    let ticket = fast(&h.governor, &run("A"), KEY_A);
    assert_eq!(h.snapshot(KEY_A).in_flight, 1);
    drop(ticket);
    assert_eq!(h.snapshot(KEY_A).in_flight, 0);

    let settled = fast(&h.governor, &run("A"), KEY_A);
    settled.settle(AttemptSignal::Completed);
    let other = fast(&h.governor, &run("A"), KEY_A);
    assert_eq!(
        h.snapshot(KEY_A).in_flight,
        1,
        "the settled ticket did not release the other one"
    );
    other.settle(AttemptSignal::Completed);
}

#[tokio::test]
async fn one_batch_of_429s_reduces_the_cap_once() {
    let h = harness(D);
    let batch: Vec<_> = (0..D)
        .map(|_| fast(&h.governor, &run("A"), KEY_A))
        .collect();
    for ticket in batch {
        throttle(ticket, None);
    }
    let snapshot = h.snapshot(KEY_A);
    assert_eq!((snapshot.cap, snapshot.epoch), (6, 1));
    // Only a request sent under the new cap judges it again.
    throttle(fast(&h.governor, &run("A"), KEY_A), None);
    assert_eq!(h.snapshot(KEY_A).cap, 4);
}

#[tokio::test]
async fn the_subagents_of_one_session_share_one_queue_and_sessions_do_not() {
    let h = harness(1);
    let busy = fast(&h.governor, &run("A"), KEY_A);
    let s1 = AdmissionScope::SessionSubagents("s1".into());
    let s2 = AdmissionScope::SessionSubagents("s2".into());
    let s1_first = queue(&h.governor, s1.clone(), KEY_A);
    let s1_second = queue(&h.governor, s1.clone(), KEY_A);
    let s2_first = queue(&h.governor, s2.clone(), KEY_A);
    settle_tasks().await;
    busy.settle(AttemptSignal::Completed);
    settle_tasks().await;
    let first = finished(s1_first).expect("s1 gets the first slot");
    assert!(!s2_first.is_finished() && !s1_second.is_finished());
    first.settle(AttemptSignal::Completed);
    settle_tasks().await;
    // The rotation moves to s2, the other session, before s1's second request.
    let second = finished(s2_first).expect("s2 is next, not s1's second request");
    assert!(!s1_second.is_finished());
    second.settle(AttemptSignal::Completed);
    settle_tasks().await;
    if let Some(third) = finished(s1_second) {
        third.settle(AttemptSignal::Completed);
    }
}

#[tokio::test]
async fn five_idle_minutes_with_nothing_in_flight_restore_the_default_cap() {
    let h = harness(D);
    throttle(fast(&h.governor, &run("A"), KEY_A), None);
    assert_eq!(h.snapshot(KEY_A).cap, 6);
    h.advance(300_000);
    let hits: Vec<_> = (0..D)
        .map(|_| h.governor.try_admit(&run("next"), KEY_A))
        .collect();
    assert!(hits.iter().all(Option::is_some));
    assert_eq!(h.snapshot(KEY_A).cap, D);
}

/// 等待者在拿到名额之后、被轮询之前就被丢弃（Codex P1）：名额必须还回去，后来的请求要能准入。
#[tokio::test]
async fn a_grant_sent_to_a_waiter_dropped_before_it_resumes_releases_its_slot() {
    use std::future::Future;
    use std::task::{Context, Waker};

    let h = harness(1);
    let holder = fast(&h.governor, &run("A"), KEY_A);
    let scope = run("B");
    let token = CancellationToken::new();
    let mut waiter = Box::pin(h.governor.admit(&scope, KEY_A, &token));
    let mut cx = Context::from_waker(Waker::noop());
    assert!(
        waiter.as_mut().poll(&mut cx).is_pending(),
        "B queues behind the holder"
    );

    // drain sends B its grant into the channel; B is dropped without being polled again.
    holder.settle(AttemptSignal::Completed);
    drop(waiter);

    assert_eq!(
        h.snapshot(KEY_A).in_flight,
        0,
        "the grant B never took is released"
    );
    assert!(
        h.governor.try_admit(&run("C"), KEY_A).is_some(),
        "a later request is admitted at cap 1"
    );
}

/// 冷却截止时间已过、但定时器回调还没跑时取消一个等待者（Codex P1）：剩下的等待者要马上拿到名额。
/// 用暂停的 tokio 时钟：定时器不前进，只有注入的时钟越过了截止时间。
#[tokio::test(start_paused = true)]
async fn a_cancel_after_the_cooldown_deadline_serves_the_next_waiter_without_the_timer() {
    let clock = Arc::new(ManualClock::new(1_000_000));
    let schedule: Scheduler = Arc::new(|delay, callback| {
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            callback();
        });
    });
    let governor = Governor::new(clock.clone(), 1, schedule);
    let holder = governor
        .try_admit(&run("holder"), KEY_A)
        .expect("the slot is free");
    holder.settle(AttemptSignal::Throttled {
        reason: ThrottleReason::RateLimited,
        retry_after_ms: Some(20_000),
    });

    let cancel_a = CancellationToken::new();
    let a = {
        let governor = governor.clone();
        let token = cancel_a.clone();
        tokio::spawn(async move { governor.admit(&run("A"), KEY_A, &token).await.map(drop) })
    };
    let b = queue(&governor, run("B"), KEY_A);
    settle_tasks().await;

    // The deadline passes on the injected clock; the tokio timer has not fired yet.
    clock.advance(20_000);
    cancel_a.cancel();
    settle_tasks().await;
    let _ = a.await;
    settle_tasks().await;
    assert!(
        b.is_finished(),
        "B takes the free slot at once instead of waiting for a timer that was superseded"
    );
}

/// 注入的时钟：先按脚本给读数，脚本用完后一直给 `sticky`。用来让同一个操作的两次读数落在截止时间两侧（Codex #560 P1）。
struct ScriptedClock {
    script: Mutex<std::collections::VecDeque<u64>>,
    sticky: std::sync::atomic::AtomicU64,
}

impl ScriptedClock {
    fn new(now: u64) -> Self {
        Self {
            script: Mutex::new(std::collections::VecDeque::new()),
            sticky: std::sync::atomic::AtomicU64::new(now),
        }
    }

    fn script(&self, values: &[u64], sticky: u64) {
        self.script.lock().unwrap().extend(values.iter().copied());
        self.sticky
            .store(sticky, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Clock for ScriptedClock {
    fn now_ms(&self) -> u64 {
        self.script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| self.sticky.load(std::sync::atomic::Ordering::SeqCst))
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

/// 截止时间在一个操作的两次时钟读数之间越过：操作留下的唤醒必须仍然存在（或者已经把等待者服务掉）。
#[tokio::test]
async fn a_deadline_crossed_between_two_clock_reads_still_leaves_a_wake() {
    use std::future::Future;
    use std::task::{Context, Waker};

    const NOW: u64 = 1_000_000;
    let clock = Arc::new(ScriptedClock::new(NOW));
    let armed: Arc<Mutex<Vec<(Duration, Callback)>>> = Arc::default();
    let schedule: Scheduler = {
        let armed = armed.clone();
        Arc::new(move |delay, callback| armed.lock().unwrap().push((delay, callback)))
    };
    let governor = Governor::new(clock.clone(), 1, schedule);
    let holder = governor
        .try_admit(&run("holder"), KEY_A)
        .expect("the slot is free");
    holder.settle(AttemptSignal::Throttled {
        reason: ThrottleReason::RateLimited,
        retry_after_ms: Some(20_000),
    });

    // The first read is one millisecond before the deadline; every later read is at the deadline.
    clock.script(&[NOW + 20_000 - 1], NOW + 20_000);
    let scope = run("A");
    let token = CancellationToken::new();
    let mut waiter = Box::pin(governor.admit(&scope, KEY_A, &token));
    let mut cx = Context::from_waker(Waker::noop());
    assert!(
        waiter.as_mut().poll(&mut cx).is_pending(),
        "A waits out the cooldown"
    );

    let left: Vec<_> = armed.lock().unwrap().drain(..).collect();
    assert_eq!(left.len(), 1, "the operation left exactly one wake behind");
    let (delay, wake) = left.into_iter().next().unwrap();
    assert_eq!(
        delay,
        Duration::from_millis(1),
        "the wake is due at the deadline"
    );
    wake();
    assert!(
        waiter.as_mut().poll(&mut cx).is_ready(),
        "the wake serves A once the deadline has come"
    );
}

/// 定时器同步回调（测试替身：先把时钟拨到截止时间，再直接回调）。在锁里安排唤醒的旧实现会在这里死锁。
#[test]
fn a_scheduler_that_fires_synchronously_does_not_deadlock() {
    use std::future::Future;
    use std::task::{Context, Waker};

    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let clock = Arc::new(ManualClock::new(1_000_000));
        let schedule: Scheduler = {
            let clock = clock.clone();
            Arc::new(move |delay: Duration, callback: Box<dyn FnOnce() + Send>| {
                clock.advance(u64::try_from(delay.as_millis()).unwrap_or(u64::MAX));
                callback();
            })
        };
        let governor = Governor::new(clock, 1, schedule);
        let holder = governor
            .try_admit(&run("holder"), KEY_A)
            .expect("the slot is free");
        holder.settle(AttemptSignal::Throttled {
            reason: ThrottleReason::RateLimited,
            retry_after_ms: Some(20_000),
        });
        let token = CancellationToken::new();
        let scope = run("A");
        let mut waiter = Box::pin(governor.admit(&scope, KEY_A, &token));
        let mut cx = Context::from_waker(Waker::noop());
        // The wake fires inside the admission; the waiter is served by the time the poll returns.
        let ready = waiter.as_mut().poll(&mut cx).is_ready();
        let _ = done_tx.send(ready);
    });
    let ready = done_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("the admission finished: a synchronous wake must not deadlock");
    assert!(ready, "the waiter is served by the synchronous wake");
}

/// 票在没有 tokio 运行时的普通线程上丢弃（冷却还没到期，有人在等）：唤醒不能被丢掉（Codex #560 P2）。
/// 用的是生产调度器（scheduler）：修复前它在没有运行时时什么也不做，所以这个测试会失败。
#[tokio::test]
async fn a_ticket_dropped_off_the_runtime_still_wakes_a_queued_waiter() {
    use rust_cli_base::clock::SystemClock;

    let governor = Governor::new(Arc::new(SystemClock::utc()), 1, super::scheduler());
    let holder = governor
        .try_admit(&run("holder"), KEY_A)
        .expect("the slot is free");
    let waiter = {
        let governor = governor.clone();
        tokio::spawn(async move {
            governor
                .admit(&run("A"), KEY_A, &CancellationToken::new())
                .await
                .map(drop)
        })
    };
    settle_tasks().await;
    std::thread::spawn(move || {
        holder.settle(AttemptSignal::Throttled {
            reason: ThrottleReason::RateLimited,
            retry_after_ms: Some(50),
        });
    })
    .join()
    .expect("the holder thread settles");
    let served = tokio::time::timeout(Duration::from_secs(5), waiter).await;
    assert!(
        matches!(served, Ok(Ok(Ok(())))),
        "the waiter is served after the cooldown, not lost: {served:?}"
    );
}

/// 默认并发极大时自动增长上限不能溢出（Codex #560 P3）。
#[test]
fn an_absurd_default_concurrency_cannot_overflow_the_growth_limit() {
    let clock = Arc::new(ManualClock::new(1_000_000));
    let governor = Governor::new(clock, u32::MAX, Arc::new(|_, _| {}));
    assert!(
        governor.try_admit(&run("A"), KEY_A).is_some(),
        "a request is admitted at the default"
    );
    assert_eq!(governor.snapshot(KEY_A).unwrap().growth_limit, u32::MAX);
}
