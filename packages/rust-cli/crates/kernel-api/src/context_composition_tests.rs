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

/// Node's tracker ends a batch with a microtask. Here the batch ends when the mutating task yields to the runtime.
async fn end_batch() {
    tokio::task::yield_now().await;
}

#[tokio::test]
async fn revision_starts_at_zero_and_goes_up_once_per_batch() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    assert_eq!(store.snapshot(&session), (0, None));
    assert_eq!(store.record(&session, record("a")), 1);
    end_batch().await;
    assert_eq!(store.invalidate(&session), 2);
    assert_eq!(store.revision(&session), 2);
}

/// Node `markChanged`: a second change in the same batch leaves the revision alone and publishes nothing more.
#[tokio::test]
async fn changes_in_one_batch_share_one_revision_and_one_publish() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    let mut changes = store.subscribe();
    assert_eq!(store.record(&session, record("a")), 1);
    assert_eq!(store.invalidate(&session), 1);
    assert_eq!(store.revision(&session), 1);
    assert_eq!(changes.try_recv().map(|c| c.revision).ok(), Some(1));
    assert!(changes.try_recv().is_err());
    // The invalidation in the same batch dropped the record.
    assert_eq!(store.snapshot(&session).1, None);
    end_batch().await;
    assert_eq!(store.record(&session, record("b")), 2);
}

/// Without a Tokio runtime there is no batch to wait for, so every change bumps.
#[test]
fn without_a_runtime_every_change_bumps() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    assert_eq!(store.record(&session, record("a")), 1);
    assert_eq!(store.invalidate(&session), 2);
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
    let usage = ProviderUsage {
        input_tokens: 5,
        context_tokens: 7,
    };
    // No record: a late response after an invalidation must not create or fill one.
    assert_eq!(store.set_usage(&session, usage), None);
    assert_eq!(store.snapshot(&session), (0, None));
    store.record(&session, record("a"));
    assert!(store.set_usage(&session, usage).is_some());
    assert_eq!(
        store.snapshot(&session).1.and_then(|r| r.provider_usage),
        Some(usage)
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
#[tokio::test]
async fn each_batch_is_published_once_with_its_revision() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    let mut changes = store.subscribe();
    store.record(&session, record("a"));
    end_batch().await;
    store.set_usage(
        &session,
        ProviderUsage {
            input_tokens: 1,
            context_tokens: 2,
        },
    );
    end_batch().await;
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

/// A set_usage with no record publishes nothing: no revision moved.
#[test]
fn a_dropped_usage_publishes_nothing() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    let mut changes = store.subscribe();
    store.set_usage(
        &session,
        ProviderUsage {
            input_tokens: 1,
            context_tokens: 1,
        },
    );
    assert!(changes.try_recv().is_err());
}
