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

// ocr review, finding 10: Node's `parseQuotaResetAt` cases. The epoch values are fixed: 2026-10-15T08:00:00Z is
// 1 792 051 200 s, and the Beijing wall times are 8 h ahead of UTC.
const NOW_MS: u64 = 1_792_051_200_000; // 2026-10-15T08:00:00Z (Beijing 16:00)

#[test]
fn the_reset_time_in_the_provider_text_is_read_as_beijing_time() {
    use super::parse_quota_reset_at;
    assert_eq!(
        parse_quota_reset_at(
            "[1308] 已达到 5 小时的使用上限。您的限额将在 2026-10-15 18:50:42 重置",
            NOW_MS
        ),
        Some(1_792_061_442_000) // 2026-10-15T10:50:42Z
    );
    assert_eq!(
        parse_quota_reset_at(
            "您已达到每周/每月使用上限，您的限额将在 2026-10-20 00:00:00 重置",
            NOW_MS
        ),
        Some(1_792_425_600_000) // 2026-10-19T16:00:00Z
    );
    // The full provider shape: the request id's digits are not a time.
    assert_eq!(
        parse_quota_reset_at(
            "[1308][已达到 5 小时的使用上限。您的限额将在 2026-10-15 18:50:42 重置。][20261015175300b9eb69fdbe0f4b93]",
            NOW_MS
        ),
        Some(1_792_061_442_000)
    );
}

#[test]
fn a_text_without_a_reset_time_or_outside_the_window_gives_none() {
    use super::parse_quota_reset_at;
    assert_eq!(parse_quota_reset_at("insufficient_quota", NOW_MS), None);
    assert_eq!(
        parse_quota_reset_at("您的限额将在 2019-01-01 00:00:00 重置", NOW_MS),
        None
    );
    assert_eq!(
        parse_quota_reset_at("您的限额将在 2027-06-01 00:00:00 重置", NOW_MS),
        None
    );
}

#[test]
fn retry_after_wins_and_an_implausible_one_falls_back_to_the_text() {
    use super::quota_reset_at;
    use rust_cli_kernel_api::model::ModelError;
    let rate_limited = |retry_after_ms| ModelError::RateLimited {
        message: "[1308]".into(),
        retry_after_ms,
    };
    assert_eq!(
        quota_reset_at(
            &rate_limited(Some(60_000)),
            "您的限额将在 2026-10-15 18:50:42 重置",
            NOW_MS
        ),
        Some(NOW_MS + 60_000)
    );
    let thirty_years = 30 * 365 * 24 * 60 * 60 * 1000;
    assert_eq!(
        quota_reset_at(
            &rate_limited(Some(thirty_years)),
            "您的限额将在 2026-10-15 18:50:42 重置",
            NOW_MS
        ),
        Some(1_792_061_442_000)
    );
    assert_eq!(
        quota_reset_at(&rate_limited(Some(thirty_years)), "x", NOW_MS),
        None
    );
}

#[test]
fn a_long_run_of_attempts_does_not_overflow() {
    assert_eq!(transient_backoff_ms(40, 1.0), 60_000);
    assert_eq!(transient_backoff_ms(u32::MAX, 1.0), 60_000);
}
