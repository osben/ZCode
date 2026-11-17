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

#[test]
fn revision_starts_at_zero_and_goes_up_on_each_change() {
    let store = CompositionStore::default();
    let session = SessionId::new("s");
    assert_eq!(store.snapshot(&session), (0, None));
    assert_eq!(store.record(&session, record("a")), 1);
    assert_eq!(store.invalidate(&session), 2);
    assert_eq!(store.revision(&session), 2);
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
