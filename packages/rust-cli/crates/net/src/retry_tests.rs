use super::*;

/// Node `calculateRetryDelay`: `min(base * factor^(n-1), max)`, then a non-zero wait times `0.5 + 0.5 * random`.
#[test]
fn backoff_doubles_with_node_jitter_up_to_the_cap() {
    let policy = RetryPolicy::default();
    let ms = |attempt, random| policy.delay(attempt, None, random).map(|d| d.as_millis());
    assert_eq!(ms(1, 0.0), Some(1000));
    assert_eq!(ms(1, 0.999_999), Some(2000));
    assert_eq!(ms(2, 0.5), Some(3000));
    assert_eq!(ms(5, 0.0), Some(16_000));
    // 2000 * 2^5 = 64000 is cut to the 60 s cap before the jitter.
    assert_eq!(ms(6, 1.0), Some(60_000));
    assert_eq!(ms(6, 0.0), Some(30_000));
    assert_eq!(ms(u32::MAX, 0.0), Some(30_000));
}

#[test]
fn the_defaults_are_nodes() {
    let policy = RetryPolicy::default();
    assert_eq!(policy.max_retries, 10);
    assert_eq!(policy.base_delay, Duration::from_millis(2000));
    assert_eq!(policy.backoff_factor, 2.0);
    assert_eq!(policy.max_backoff, Duration::from_millis(60_000));
    assert!(policy.jitter);
}

#[test]
fn the_backoff_factor_and_the_cap_come_from_the_policy() {
    let policy = RetryPolicy {
        jitter: false,
        base_delay: Duration::from_millis(100),
        backoff_factor: 3.0,
        max_backoff: Duration::from_millis(1000),
        ..RetryPolicy::default()
    };
    let ms = |attempt| policy.delay(attempt, None, 0.0).map(|d| d.as_millis());
    assert_eq!(ms(1), Some(100));
    assert_eq!(ms(2), Some(300));
    assert_eq!(ms(3), Some(900));
    assert_eq!(ms(4), Some(1000));
    let fraction = RetryPolicy {
        backoff_factor: 1.5,
        ..policy
    };
    assert_eq!(
        fraction.delay(3, None, 0.0).map(|d| d.as_millis()),
        Some(225)
    );
}

#[test]
fn a_zero_base_or_a_zero_cap_waits_nothing() {
    let zero_base = RetryPolicy {
        base_delay: Duration::ZERO,
        ..RetryPolicy::default()
    };
    assert_eq!(zero_base.delay(4, None, 0.7), Some(Duration::ZERO));
    let zero_cap = RetryPolicy {
        max_backoff: Duration::ZERO,
        ..RetryPolicy::default()
    };
    assert_eq!(zero_cap.delay(4, None, 0.7), Some(Duration::ZERO));
}

#[test]
fn jitter_off_returns_the_capped_wait() {
    let policy = RetryPolicy {
        jitter: false,
        ..RetryPolicy::default()
    };
    assert_eq!(
        policy.delay(1, None, 0.9),
        Some(Duration::from_millis(2000))
    );
    assert_eq!(
        policy.delay(9, None, 0.1),
        Some(Duration::from_millis(60_000))
    );
}

/// A cap above the retry-after limit is not a reason to give up: only a server wait is checked against `max_wait`.
#[test]
fn a_backoff_above_max_wait_still_retries() {
    let policy = RetryPolicy {
        jitter: false,
        base_delay: Duration::from_secs(90),
        max_backoff: Duration::from_secs(120),
        ..RetryPolicy::default()
    };
    assert_eq!(policy.delay(1, None, 0.0), Some(Duration::from_secs(90)));
    assert_eq!(policy.delay(1, Some(Duration::from_secs(61)), 0.0), None);
}

#[test]
fn retry_after_wins_when_longer_and_too_long_gives_up() {
    let policy = RetryPolicy {
        jitter: false,
        ..RetryPolicy::default()
    };
    let secs = |s| Some(Duration::from_secs(s));
    assert_eq!(policy.delay(1, secs(3), 0.0), secs(3));
    // A server wait shorter than the backoff gives the backoff.
    assert_eq!(policy.delay(4, secs(1), 0.0), secs(16));
    assert_eq!(policy.delay(1, secs(60), 0.0), secs(60));
    assert_eq!(policy.delay(1, secs(61), 0.0), None);
}

#[test]
fn retry_after_header_forms_and_precedence() {
    let now = httpdate::parse_http_date("Wed, 21 Oct 2015 07:27:00 GMT").unwrap();
    let parse = |pairs: &[(&str, &str)]| {
        retry_after(&ResponseHeaders::from_pairs(pairs.iter().copied()), now).map(|d| d.as_millis())
    };
    assert_eq!(
        parse(&[("retry-after", "Wed, 21 Oct 2015 07:28:00 GMT")]),
        Some(60_000)
    );
    assert_eq!(
        parse(&[("retry-after", "Wed, 21 Oct 2015 07:00:00 GMT")]),
        Some(0)
    );
    assert_eq!(parse(&[("retry-after", " 2 ")]), Some(2000));
    assert_eq!(parse(&[("retry-after", "1.5")]), Some(1500));
    assert_eq!(parse(&[("retry-after", "-3")]), Some(0));
    assert_eq!(parse(&[("retry-after", "soon")]), None);
    assert_eq!(
        parse(&[("retry-after", "9"), ("retry-after-ms", "12.5")]),
        Some(13)
    );
    assert_eq!(parse(&[]), None);
}

#[test]
fn should_retry_header() {
    let header =
        |value: &str| should_retry(&ResponseHeaders::from_pairs([("x-should-retry", value)]));
    assert_eq!(header("true"), Some(true));
    assert_eq!(header(" false "), Some(false));
    assert_eq!(header("maybe"), None);
    assert_eq!(should_retry(&ResponseHeaders::default()), None);
}

#[test]
fn jitter_stays_in_range_and_varies() {
    let samples: Vec<f64> = (0..64).map(|_| jitter()).collect();
    assert!(samples.iter().all(|value| (0.0..1.0).contains(value)));
    assert!(samples.windows(2).any(|pair| pair[0] != pair[1]));
}
