use super::*;

fn record(model: &str) -> CompositionRecord {
    CompositionRecord {
        provider_id: "p".to_owned(),
        model_id: model.to_owned(),
        measured_at_ms: 1,
        estimated_tokens: 10,
        categories: Vec::new(),
        provider_usage: None,
    }
}

fn usage() -> ProviderUsage {
    ProviderUsage {
        input_tokens: 1,
        context_tokens: 2,
    }
}

#[test]
fn revision_starts_at_zero_and_each_single_change_is_its_own_batch() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    assert_eq!(store.snapshot(&session), (0, None));
    assert_eq!(store.record(&session, record("a")), 1);
    assert_eq!(store.invalidate(&session), 2);
    assert_eq!(store.revision(&session), 2);
}

/// Node `markChanged`: every change of one batch shares one revision bump and one notification, and the notification
/// is sent when the batch ends, so a subscriber reads the batch-final state.
#[test]
fn a_batch_bumps_once_and_publishes_once_with_its_final_state() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    let mut changes = store.subscribe();
    store.batch(&session, |batch| {
        batch.record(record("a"));
        batch.invalidate();
        batch.record(record("b"));
        // Nothing is published while the batch is open.
        assert!(changes.try_recv().is_err());
    });
    assert_eq!(store.revision(&session), 1);
    let change = changes.try_recv().expect("one notification for the batch");
    assert_eq!(change.revision, 1);
    assert!(changes.try_recv().is_err());
    assert_eq!(
        store.snapshot(&session).1.map(|r| r.model_id),
        Some("b".to_owned())
    );
}

/// A batch ends where its closure returns, so the next change is a new batch with the next revision. No runtime or
/// timer is involved: the same result on a current-thread and on a multi-thread runtime.
#[test]
fn the_next_change_after_a_batch_is_a_new_batch() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    let mut changes = store.subscribe();
    store.batch(&session, |batch| {
        batch.record(record("a"));
        batch.invalidate();
    });
    assert_eq!(store.record(&session, record("b")), 2);
    let revisions: Vec<u64> = std::iter::from_fn(|| changes.try_recv().ok())
        .map(|change| change.revision)
        .collect();
    assert_eq!(revisions, vec![1, 2]);
}

/// A batch whose changes are all no-ops (a usage with no record) moves nothing and publishes nothing.
#[test]
fn a_batch_without_a_change_publishes_nothing() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    let mut changes = store.subscribe();
    let applied = store.batch(&session, |batch| batch.set_usage(usage()));
    assert!(!applied);
    assert_eq!(store.revision(&session), 0);
    assert!(changes.try_recv().is_err());
}

/// Many batches run concurrently on a multi-thread runtime: each bumps once, so the revisions are 1..=N with one
/// notification each, and no batch is cut short by another worker.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_batches_on_a_multi_thread_runtime_bump_once_each() {
    use std::sync::Arc;
    const BATCHES: u64 = 100;
    let store = Arc::new(CompositionStore::default());
    let session = SessionId::new("s");
    let mut changes = store.subscribe();
    let mut tasks = Vec::new();
    for _ in 0..BATCHES {
        let store = store.clone();
        let session = session.clone();
        tasks.push(tokio::spawn(async move {
            store.batch(&session, |batch| {
                batch.record(record("a"));
                batch.invalidate();
                batch.record(record("b"));
            });
        }));
    }
    for task in tasks {
        task.await.unwrap();
    }
    let mut revisions = Vec::new();
    while let Ok(change) = changes.try_recv() {
        revisions.push(change.revision);
    }
    assert_eq!(revisions, (1..=BATCHES).collect::<Vec<_>>());
    assert_eq!(store.revision(&session), BATCHES);
    assert_eq!(
        store.snapshot(&session).1.map(|r| r.model_id),
        Some("b".to_owned())
    );
}

#[test]
fn invalidation_drops_the_record_and_a_new_request_replaces_it() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    store.record(&session, record("a"));
    store.invalidate(&session);
    assert_eq!(store.snapshot(&session).1, None);
    store.record(&session, record("b"));
    assert_eq!(
        store.snapshot(&session).1.map(|r| r.model_id),
        Some("b".to_owned())
    );
}

#[test]
fn usage_attaches_to_the_current_record_only() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    // No record: a late response after an invalidation must not create or fill one.
    assert_eq!(store.set_usage(&session, usage()), None);
    assert_eq!(store.snapshot(&session), (0, None));
    store.record(&session, record("a"));
    assert!(store.set_usage(&session, usage()).is_some());
    assert_eq!(
        store.snapshot(&session).1.and_then(|r| r.provider_usage),
        Some(usage())
    );
}

#[test]
fn sessions_are_independent() {
    let store = CompositionStore::default();
    let one = SessionId::new("one");
    let two = SessionId::new("two");
    store.record(&one, record("a"));
    assert_eq!(store.snapshot(&two), (0, None));
}

/// Every batch is published with its session and the new revision, in order. The protocol side coalesces them per tick.
#[test]
fn each_batch_is_published_once_with_its_revision() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    let mut changes = store.subscribe();
    store.record(&session, record("a"));
    store.set_usage(&session, usage());
    store.invalidate(&session);
    let mut seen = Vec::new();
    while let Ok(change) = changes.try_recv() {
        seen.push((change.session, change.revision));
    }
    assert_eq!(
        seen,
        vec![(session.clone(), 1), (session.clone(), 2), (session, 3)]
    );
}

/// A closed session's record is freed, and its revision is kept: a reopened session must not restart at 0.
#[test]
fn forget_drops_the_record_and_keeps_the_revision() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    store.record(&session, record("a"));
    store.forget(&session);
    assert_eq!(store.snapshot(&session), (1, None));
    assert_eq!(store.invalidate(&session), 2);
}

/// Writers on several threads publish their revisions in the order they were assigned: the subscriber's sequence is
/// strictly increasing. (Before the fix a publish after the lock was released could overtake a later one.)
#[test]
fn concurrent_writers_publish_in_revision_order() {
    let store = std::sync::Arc::new(CompositionStore::default());
    let session = SessionId::new("s");
    let mut changes = store.subscribe();
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let store = store.clone();
            let session = session.clone();
            std::thread::spawn(move || {
                // Kept under the channel capacity, so no change is dropped for lag.
                for _ in 0..20 {
                    store.invalidate(&session);
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    let mut last = 0;
    let mut count = 0;
    while let Ok(change) = changes.try_recv() {
        assert!(
            change.revision > last,
            "revision {} after {}",
            change.revision,
            last
        );
        last = change.revision;
        count += 1;
    }
    assert_eq!(count, 8 * 20);
    assert_eq!(last, 8 * 20);
}

/// A set_usage with no record publishes nothing: no revision moved.
#[test]
fn a_dropped_usage_publishes_nothing() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    let mut changes = store.subscribe();
    store.set_usage(&session, usage());
    assert!(changes.try_recv().is_err());
}
