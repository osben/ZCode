//! AIMD 控制器的单元测试（Node `dynamic-workflow/src/engine/concurrency.ts` 的行为，常数同 Node：
//! 0.75、+1、K = 4、地板 1、空闲 5 分钟重置）。控制器是纯状态机，`now` 由调用方给。

use super::{Change, ChangeReason, Controller, IDLE_RESET_MS};
use crate::admission::ThrottleReason;

/// 一个在飞请求、它的 epoch，然后用 `ended` 之外的结局结束。
fn admit(controller: &mut Controller, now: u64) -> u64 {
    controller.observe(now);
    controller.admitted(now)
}

#[test]
fn a_throttle_without_a_last_good_multiplies_by_three_quarters() {
    let mut controller = Controller::new(8, 16);
    let epoch = admit(&mut controller, 0);
    let changes = controller.throttled(0, epoch, ThrottleReason::RateLimited, None);
    let snapshot = controller.snapshot();
    assert_eq!(snapshot.cap, 6);
    assert_eq!(snapshot.last_bad, Some(8));
    assert_eq!(snapshot.last_good, None);
    assert_eq!(snapshot.epoch, 1);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].previous, 8);
    assert_eq!(changes[0].next, 6);
    assert_eq!(changes[0].reason, ChangeReason::RateLimited);
}

#[test]
fn a_throttle_at_the_floor_changes_no_cap_and_emits_nothing_but_moves_the_epoch() {
    let mut controller = Controller::new(1, 2);
    let epoch = admit(&mut controller, 0);
    let changes = controller.throttled(0, epoch, ThrottleReason::RateLimited, None);
    assert_eq!(controller.snapshot().cap, 1);
    assert_eq!(controller.snapshot().epoch, 1);
    assert!(changes.is_empty());
}

#[test]
fn a_retry_after_sets_a_cooldown_that_a_later_shorter_one_does_not_shorten() {
    let mut controller = Controller::new(8, 16);
    let epoch = admit(&mut controller, 0);
    controller.throttled(0, epoch, ThrottleReason::RateLimited, Some(20_000));
    assert_eq!(controller.snapshot().cooldown_until, Some(20_000));
    assert!(!controller.can_admit(19_999));
    let epoch = admit(&mut controller, 1);
    controller.throttled(1, epoch, ThrottleReason::RateLimited, Some(5_000));
    assert_eq!(controller.snapshot().cooldown_until, Some(20_000));
    assert!(controller.can_admit(20_000));
}

#[test]
fn admission_needs_a_free_slot_and_no_cooldown() {
    let mut controller = Controller::new(2, 4);
    assert!(controller.can_admit(0));
    admit(&mut controller, 0);
    admit(&mut controller, 0);
    assert!(!controller.can_admit(0), "in flight equals the cap");
    controller.ended(0);
    assert!(controller.can_admit(0));
}

#[test]
fn growth_needs_waiters_and_k_successes_then_adds_one() {
    let mut controller = Controller::new(4, 8);
    for _ in 0..4 {
        let epoch = admit(&mut controller, 0);
        controller.waiters(0, 1);
        controller.succeeded(0, epoch);
    }
    let snapshot = controller.snapshot();
    assert_eq!(snapshot.cap, 5);
    assert_eq!(snapshot.success_streak, 0);
    assert_eq!(
        snapshot.last_good,
        Some(4),
        "a full streak proves the level it ran at"
    );
}

#[test]
fn without_waiters_the_streak_builds_but_the_cap_stays() {
    let mut controller = Controller::new(4, 8);
    for _ in 0..6 {
        let epoch = admit(&mut controller, 0);
        controller.succeeded(0, epoch);
    }
    let snapshot = controller.snapshot();
    assert_eq!(snapshot.cap, 4);
    assert_eq!(snapshot.success_streak, 6);
}

#[test]
fn a_success_from_an_old_epoch_does_not_count_toward_the_streak() {
    let mut controller = Controller::new(2, 4);
    let stale = admit(&mut controller, 0);
    let _other = admit(&mut controller, 0);
    controller.throttled(0, stale, ThrottleReason::RateLimited, None);
    assert_eq!(controller.snapshot().cap, 1);
    // The other request was sent under cap 2; its success proves nothing about cap 1.
    controller.succeeded(0, stale);
    assert_eq!(controller.snapshot().success_streak, 0);
}

#[test]
fn a_throttle_from_an_old_epoch_only_clears_the_streak_and_sets_the_cooldown() {
    let mut controller = Controller::new(2, 4);
    let stale = admit(&mut controller, 0);
    let fresh = admit(&mut controller, 0);
    controller.throttled(0, fresh, ThrottleReason::RateLimited, None);
    assert_eq!(controller.snapshot().cap, 1);
    let changes = controller.throttled(0, stale, ThrottleReason::RateLimited, Some(3_000));
    assert_eq!(
        controller.snapshot().cap,
        1,
        "an old-epoch 429 does not judge the new cap"
    );
    assert_eq!(controller.snapshot().cooldown_until, Some(3_000));
    assert!(changes.is_empty());
}

#[test]
fn a_throttle_while_probing_above_last_good_reverts_to_last_good() {
    let mut controller = Controller::new(8, 16);
    for _ in 0..4 {
        let epoch = admit(&mut controller, 0);
        controller.waiters(0, 1);
        controller.succeeded(0, epoch);
    }
    // The four successes at cap 8 proved 8 and admitted one waiter, which put cap at 9.
    let snapshot = controller.snapshot();
    assert_eq!((snapshot.cap, snapshot.last_good), (9, Some(8)));
    let epoch = admit(&mut controller, 1);
    controller.throttled(1, epoch, ThrottleReason::RateLimited, None);
    let snapshot = controller.snapshot();
    assert_eq!(snapshot.cap, 8);
    assert_eq!(snapshot.last_bad, Some(9));
}

#[test]
fn a_transient_failure_clears_the_streak_and_keeps_the_cap() {
    let mut controller = Controller::new(4, 8);
    let epoch = admit(&mut controller, 0);
    controller.succeeded(0, epoch);
    let epoch = admit(&mut controller, 0);
    controller.failed_transient(0);
    let _ = epoch;
    let snapshot = controller.snapshot();
    assert_eq!(snapshot.cap, 4);
    assert_eq!(snapshot.success_streak, 0);
    assert_eq!(snapshot.in_flight, 0);
}

#[test]
fn five_idle_minutes_with_nothing_in_flight_return_to_the_default() {
    let mut controller = Controller::new(8, 16);
    let epoch = admit(&mut controller, 0);
    controller.throttled(0, epoch, ThrottleReason::RateLimited, None);
    assert_eq!(controller.snapshot().cap, 6);
    let changes = controller.observe(300_000);
    assert_eq!(controller.snapshot().cap, 8);
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].reason, ChangeReason::IdleReset);
}

#[test]
fn no_idle_reset_while_a_request_is_in_flight() {
    let mut controller = Controller::new(8, 16);
    let epoch = admit(&mut controller, 0);
    controller.throttled(0, epoch, ThrottleReason::RateLimited, None);
    admit(&mut controller, 1_000);
    controller.observe(600_000);
    assert_eq!(
        controller.snapshot().cap,
        6,
        "the learned cap is kept while busy"
    );
}

/// 超大的 Retry-After（饱和到 `u64::MAX`）不能让截止时间溢出或回绕，冷却被截到上限（Codex #560 P2）。
#[test]
fn a_huge_retry_after_cannot_overflow_the_deadline_and_is_capped() {
    let mut controller = Controller::new(8, 16);
    let epoch = admit(&mut controller, 10);
    controller.throttled(10, epoch, ThrottleReason::RateLimited, Some(u64::MAX));
    // 60 s is the cap (MAX_COOLDOWN_MS); written as a literal so the test also compiles against the old code.
    assert_eq!(
        controller.snapshot().cooldown_until,
        Some(10 + 60_000),
        "the cooldown is the cap, measured from now"
    );
}

/// 极大的 cap 上的限流：乘 3/4 不能溢出（Codex #560 P3）。
#[test]
fn a_throttle_at_a_huge_cap_does_not_overflow() {
    let mut controller = Controller::new(u32::MAX, u32::MAX);
    let epoch = admit(&mut controller, 0);
    controller.throttled(0, epoch, ThrottleReason::RateLimited, None);
    assert_eq!(
        controller.snapshot().cap,
        3_221_225_471,
        "floor(u32::MAX x 3 / 4)"
    );
}

// ——— 增长上限与起跳（Node concurrency.test.ts 的「增长上限」「seed」两组，W6b 第二部分） ———

/// `count` 次「准入再成功」，每次都是当前 epoch；返回这些成功带出的 cap 变化。
fn round_trips(controller: &mut Controller, count: u32) -> Vec<Change> {
    let mut changes = Vec::new();
    for _ in 0..count {
        let epoch = admit(controller, 0);
        changes.extend(controller.succeeded(0, epoch));
    }
    changes
}

#[test]
fn raising_the_growth_limit_changes_no_cap_and_the_cap_climbs_one_step_at_a_time() {
    let mut controller = Controller::new(4, 8);
    assert!(controller.set_growth_limit(0, 20).is_empty());
    let snapshot = controller.snapshot();
    assert_eq!((snapshot.growth_limit, snapshot.cap), (20, 4));
    controller.waiters(0, 1);
    let steps: Vec<u32> = round_trips(&mut controller, 4 * 20)
        .iter()
        .map(|change| change.next)
        .collect();
    assert_eq!(steps, (5..=20).collect::<Vec<u32>>());
    assert_eq!(controller.snapshot().cap, 20);
}

#[test]
fn lowering_the_growth_limit_below_the_cap_pulls_the_cap_down_at_once() {
    let mut controller = Controller::new(4, 20);
    controller.waiters(0, 1);
    round_trips(&mut controller, 4 * 12); // cap 16, lastGood 15
    assert_eq!(controller.snapshot().cap, 16);
    round_trips(&mut controller, 2); // streak 2
    let stale = admit(&mut controller, 0); // sent under the cap of 16
    let epoch_before = controller.snapshot().epoch;
    assert_eq!(
        controller.set_growth_limit(0, 8),
        vec![Change {
            previous: 16,
            next: 8,
            reason: ChangeReason::LimitLowered,
            last_good: Some(8),
            last_bad: None,
            cooldown_ms: None,
        }]
    );
    let snapshot = controller.snapshot();
    assert_eq!(
        (snapshot.growth_limit, snapshot.cap, snapshot.last_good),
        (8, 8, Some(8))
    );
    assert_eq!(
        (snapshot.success_streak, snapshot.epoch),
        (0, epoch_before + 1)
    );
    // The request sent under the old cap is not a verdict on the new one.
    assert!(
        controller
            .throttled(0, stale, ThrottleReason::RateLimited, None)
            .is_empty()
    );
    assert_eq!(controller.snapshot().cap, 8);
}

#[test]
fn lowering_the_growth_limit_to_a_value_not_below_the_cap_changes_nothing() {
    let mut controller = Controller::new(4, 20);
    let epoch = controller.snapshot().epoch;
    assert!(controller.set_growth_limit(0, 8).is_empty());
    let snapshot = controller.snapshot();
    assert_eq!(
        (snapshot.growth_limit, snapshot.cap, snapshot.epoch),
        (8, 4, epoch)
    );
}

#[test]
fn the_growth_limit_never_goes_below_initial() {
    let mut controller = Controller::new(6, 12);
    assert!(controller.set_growth_limit(0, 2).is_empty());
    assert_eq!(controller.snapshot().growth_limit, 6);
    assert_eq!(controller.snapshot().cap, 6);
}

#[test]
fn seed_jumps_the_cap_to_the_target_and_clears_the_proof_of_the_old_level() {
    let mut controller = Controller::new(8, 32);
    controller.waiters(0, 1);
    round_trips(&mut controller, 4 + 2); // cap 9, lastGood 8, streak 2
    let epoch = controller.snapshot().epoch;
    assert_eq!(
        controller.seed(0, 32),
        vec![Change {
            previous: 9,
            next: 32,
            reason: ChangeReason::Seeded,
            last_good: None,
            last_bad: None,
            cooldown_ms: None,
        }]
    );
    let snapshot = controller.snapshot();
    assert_eq!(
        (snapshot.cap, snapshot.success_streak, snapshot.epoch),
        (32, 0, epoch + 1)
    );
    assert_eq!((snapshot.last_good, snapshot.last_bad), (None, None));
}

#[test]
fn a_seed_target_above_the_growth_limit_stops_at_the_growth_limit() {
    let mut controller = Controller::new(8, 20);
    let changes = controller.seed(0, 50);
    assert_eq!(changes.len(), 1);
    assert_eq!((changes[0].previous, changes[0].next), (8, 20));
    assert_eq!(changes[0].reason, ChangeReason::Seeded);
}

#[test]
fn a_seed_target_not_above_the_cap_does_nothing() {
    let mut controller = Controller::new(8, 32);
    let epoch = controller.snapshot().epoch;
    assert!(controller.seed(0, 8).is_empty());
    assert!(controller.seed(0, 3).is_empty());
    assert_eq!(controller.snapshot().epoch, epoch);
    assert_eq!(controller.snapshot().cap, 8);
}

#[test]
fn a_rejection_within_five_minutes_refuses_the_seed_and_the_cap_climbs_as_usual() {
    let mut controller = Controller::new(8, 32);
    let epoch = admit(&mut controller, 0);
    controller.throttled(0, epoch, ThrottleReason::RateLimited, None); // cap 6
    assert!(controller.seed(IDLE_RESET_MS - 1, 32).is_empty());
    assert_eq!(controller.snapshot().cap, 6);
    // The cap still climbs by probing: a waiter, then K current-epoch successes, lift it by one.
    controller.waiters(IDLE_RESET_MS - 1, 1);
    let changes = round_trips(&mut controller, 4);
    assert_eq!(controller.snapshot().cap, 7);
    assert_eq!(
        changes.iter().map(|c| c.next).collect::<Vec<u32>>(),
        vec![7]
    );
}
