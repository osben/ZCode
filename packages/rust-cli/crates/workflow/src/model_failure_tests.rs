//! The transient backoff curve (Node `transientBackoffMs`, `workflow-driver-helpers.ts`).

use super::transient_backoff_ms;

#[test]
fn the_backoff_starts_at_two_seconds_and_doubles_to_a_minute() {
    // Full jitter factor (random 1.0 gives the raw curve).
    let curve: Vec<u64> = (1..=7)
        .map(|attempt| transient_backoff_ms(attempt, 1.0))
        .collect();
    assert_eq!(
        curve,
        vec![2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]
    );
}

#[test]
fn the_jitter_takes_between_half_and_all_of_the_raw_delay() {
    // random 0.0 gives half the raw delay, random 0.5 gives three quarters.
    assert_eq!(transient_backoff_ms(1, 0.0), 1_000);
    assert_eq!(transient_backoff_ms(1, 0.5), 1_500);
    assert_eq!(transient_backoff_ms(3, 0.0), 4_000);
    assert_eq!(transient_backoff_ms(9, 0.0), 30_000);
}

#[test]
fn a_long_run_of_attempts_does_not_overflow() {
    assert_eq!(transient_backoff_ms(40, 1.0), 60_000);
    assert_eq!(transient_backoff_ms(u32::MAX, 1.0), 60_000);
}
