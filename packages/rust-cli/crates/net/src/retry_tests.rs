use super::*;

fn ms(delay: Duration) -> u128 {
    delay.as_millis()
}

/// Node `calculateRetryDelay`: `min(base * factor^(n-1), max)`, then a non-zero wait times `0.5 + 0.5 * random`.
#[test]
fn backoff_doubles_with_node_jitter_up_to_the_cap() {
    let policy = RetryPolicy::default();
    let at = |attempt, random| ms(policy.delay(attempt, None, random));
    assert_eq!(at(1, 0.0), 1000);
    assert_eq!(at(1, 0.999_999), 2000);
    assert_eq!(at(2, 0.5), 3000);
    assert_eq!(at(5, 0.0), 16_000);
    // 2000 * 2^5 = 64000 is cut to the 60 s cap before the jitter.
    assert_eq!(at(6, 1.0), 60_000);
    assert_eq!(at(6, 0.0), 30_000);
    assert_eq!(at(u32::MAX, 0.0), 30_000);
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
    let at = |attempt| ms(policy.delay(attempt, None, 0.0));
    assert_eq!(at(1), 100);
    assert_eq!(at(2), 300);
    assert_eq!(at(3), 900);
    assert_eq!(at(4), 1000);
    let fraction = RetryPolicy {
        backoff_factor: 1.5,
        ..policy
    };
    assert_eq!(ms(fraction.delay(3, None, 0.0)), 225);
}

#[test]
fn a_zero_base_or_a_zero_cap_waits_nothing() {
    let zero_base = RetryPolicy {
        base_delay: Duration::ZERO,
        ..RetryPolicy::default()
    };
    assert_eq!(zero_base.delay(4, None, 0.7), Duration::ZERO);
    let zero_cap = RetryPolicy {
        max_backoff: Duration::ZERO,
        ..RetryPolicy::default()
    };
    assert_eq!(zero_cap.delay(4, None, 0.7), Duration::ZERO);
}

#[test]
fn jitter_off_returns_the_capped_wait() {
    let policy = RetryPolicy {
        jitter: false,
        ..RetryPolicy::default()
    };
    assert_eq!(policy.delay(1, None, 0.9), Duration::from_millis(2000));
    assert_eq!(policy.delay(9, None, 0.1), Duration::from_millis(60_000));
}

/// Node: a reasonable Retry-After is the wait itself, not the larger of it and the backoff.
#[test]
fn a_retry_after_replaces_the_backoff_even_when_shorter() {
    let policy = RetryPolicy {
        jitter: false,
        ..RetryPolicy::default()
    };
    let secs = |s| Some(Duration::from_secs(s));
    assert_eq!(policy.delay(1, secs(3), 0.0), Duration::from_secs(3));
    assert_eq!(policy.delay(4, secs(1), 0.0), Duration::from_secs(1));
    assert_eq!(policy.delay(1, Some(Duration::ZERO), 0.0), Duration::ZERO);
}

/// Node: with jitter on, a Retry-After gets forward jitter of at most 20%, capped at 5 s, and never less than itself.
#[test]
fn a_retry_after_gets_forward_only_jitter() {
    let policy = RetryPolicy::default();
    let after = |s| Some(Duration::from_secs(s));
    assert_eq!(policy.delay(1, after(10), 0.0), Duration::from_secs(10));
    assert_eq!(
        policy.delay(1, after(10), 1.0),
        Duration::from_millis(12_000)
    );
    // 20% of 100 s is 20 s, cut to 5 s.
    assert_eq!(
        policy.delay(1, after(100), 1.0),
        Duration::from_millis(105_000)
    );
    assert_eq!(
        policy.delay(1, after(100), 0.5),
        Duration::from_millis(102_500)
    );
    assert_eq!(policy.delay(1, Some(Duration::ZERO), 1.0), Duration::ZERO);
}

/// Node `isReasonableRetryAfterMs`: up to 5 minutes is honoured; longer only when it is shorter than the uncapped
/// backoff; otherwise the local backoff is used. Nothing here ends the retries.
#[test]
fn a_retry_after_beyond_five_minutes_is_ignored_unless_shorter_than_the_backoff() {
    let policy = RetryPolicy {
        jitter: false,
        ..RetryPolicy::default()
    };
    let secs = |s| Some(Duration::from_secs(s));
    assert_eq!(policy.delay(1, secs(300), 0.0), Duration::from_secs(300));
    // 301 s at attempt 1: the uncapped backoff is 2 s, so the header is dropped.
    assert_eq!(policy.delay(1, secs(301), 0.0), Duration::from_secs(2));
    // A huge backoff (cap raised, base large) makes a long Retry-After shorter than it and so honoured.
    let slow = RetryPolicy {
        jitter: false,
        base_delay: Duration::from_secs(1000),
        max_backoff: Duration::from_secs(1000),
        ..RetryPolicy::default()
    };
    assert_eq!(slow.delay(1, secs(400), 0.0), Duration::from_secs(400));
    assert_eq!(slow.delay(1, secs(2000), 0.0), Duration::from_secs(1000));
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

/// Node `parseRetryAfterMs`: `x-should-retry` of `false` or `0` (any case, trimmed) makes the Retry-After diagnostic only.
#[test]
fn x_should_retry_false_or_zero_drops_the_retry_after() {
    let now = SystemTime::UNIX_EPOCH;
    let parse = |value: &str| {
        retry_after(
            &ResponseHeaders::from_pairs([("retry-after", "5"), ("x-should-retry", value)]),
            now,
        )
    };
    assert_eq!(parse("false"), None);
    assert_eq!(parse(" FALSE "), None);
    assert_eq!(parse("0"), None);
    assert_eq!(parse("true"), Some(Duration::from_secs(5)));
    assert_eq!(parse("1"), Some(Duration::from_secs(5)));
    let ms_header =
        ResponseHeaders::from_pairs([("retry-after-ms", "500"), ("x-should-retry", "false")]);
    assert_eq!(retry_after(&ms_header, now), None);
}
