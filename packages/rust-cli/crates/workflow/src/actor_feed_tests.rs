//! The observation feed of an actor's ask (W7-3; Node `createActorModelActivity`, the part a Rust source feeds). Each
//! test names the Node rule it follows.
use crate::actor_feed::{AskFeed, FeedEvent};
use crate::model::{AskWait, WaitCause};
use rust_cli_kernel_api::model::{ModelError, ModelNotice};

fn slot() -> AskWait {
    AskWait::slot()
}

fn backoff(reason: &str, attempt: u64, retry_after_ms: Option<u64>) -> AskWait {
    AskWait {
        cause: WaitCause::Backoff,
        reason: Some(reason.to_owned()),
        attempt: Some(attempt),
        delay_ms: Some(2_000),
        retry_after_ms,
    }
}

/// Node `reportWaiting`: one waiting report per wait period; an identical wait is not reported again.
#[test]
fn a_wait_is_reported_once_per_wait_period() {
    let mut feed = AskFeed::new();
    assert_eq!(feed.waiting(slot()), Some(FeedEvent::Waiting(slot())));
    assert_eq!(feed.waiting(slot()), None);
}

/// Node `reportExecuting`: executing ends the wait period, so the next wait is reported again.
#[test]
fn executing_ends_the_wait_period_so_the_next_wait_is_reported() {
    let mut feed = AskFeed::new();
    feed.waiting(slot());
    assert_eq!(feed.executing(), Some(FeedEvent::Executing));
    assert_eq!(
        feed.executing(),
        None,
        "executing is reported on the transition only"
    );
    assert_eq!(feed.waiting(slot()), Some(FeedEvent::Waiting(slot())));
}

/// Node `sameWait`: a wait that differs in any field is a new report.
#[test]
fn a_wait_with_other_fields_is_reported_again() {
    let mut feed = AskFeed::new();
    feed.waiting(backoff("rate_limited", 2, None));
    assert_eq!(
        feed.waiting(backoff("rate_limited", 3, None)),
        Some(FeedEvent::Waiting(backoff("rate_limited", 3, None)))
    );
}

/// Node `model_retry_scheduled`: the reason counts for the stall clock, and the ask waits in backoff with the retry's
/// attempt, delay and Retry-After.
#[test]
fn a_retry_counts_its_reason_and_waits_in_backoff() {
    let mut feed = AskFeed::new();
    assert_eq!(
        feed.retry("rate_limited", 2, 2_000, Some(5_000)),
        vec![
            FeedEvent::RetryScheduled("rate_limited".to_owned()),
            FeedEvent::Waiting(backoff("rate_limited", 2, Some(5_000))),
        ]
    );
}

/// Node drops `reasoning_signature_repair` and `auth_refresh` before any handler: they are not failures.
#[test]
fn the_non_failure_retries_are_not_reported() {
    let mut feed = AskFeed::new();
    assert!(feed.retry("auth_refresh", 2, 1_000, None).is_empty());
    assert!(
        feed.retry("reasoning_signature_repair", 2, 1_000, None)
            .is_empty()
    );
}

/// The runtime's `Retrying` notice names the failed attempt; Node's `nextAttempt` is the one after it. The reason is the
/// policy table's, and a rate limit's Retry-After comes from the error.
#[test]
fn a_retry_notice_reads_the_reason_and_the_next_attempt() {
    let mut feed = AskFeed::new();
    let notice = ModelNotice::Retrying {
        attempt: 1,
        max_retries: 10,
        delay_ms: 2_000,
        error: ModelError::RateLimited {
            message: "slow down".to_owned(),
            retry_after_ms: Some(7_000),
        },
    };
    let events = feed.notice(&notice);
    assert_eq!(events.len(), 2, "{events:?}");
    assert!(matches!(&events[0], FeedEvent::RetryScheduled(reason) if reason == "rate_limited"));
    assert_eq!(
        events[1],
        FeedEvent::Waiting(backoff("rate_limited", 2, Some(7_000)))
    );
}

/// A resumed request is executing; a stall notice has no Node counterpart and reports nothing.
#[test]
fn resumed_is_executing_and_a_stall_is_silent() {
    let mut feed = AskFeed::new();
    assert!(
        feed.notice(&ModelNotice::Stalled { retry_in_ms: 1_000 })
            .is_empty()
    );
    assert_eq!(
        feed.notice(&ModelNotice::Resumed),
        vec![FeedEvent::Executing]
    );
}

/// Node `reset`: a new ask does not inherit the previous ask's wait state.
#[test]
fn reset_forgets_the_previous_ask() {
    let mut feed = AskFeed::new();
    feed.waiting(slot());
    feed.reset();
    assert_eq!(feed.waiting(slot()), Some(FeedEvent::Waiting(slot())));
}
