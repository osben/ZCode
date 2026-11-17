//! `Topics` removal tests: a deleted session's live row is dropped, a started subscriber gets the
//! `session.removed` delta (Node `SessionsIndexPublisher.removeSession` + `flushIndex`), and a
//! later snapshot cannot resurrect the row.

use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::testing::FixedClock;
use rust_cli_protocol_core::connection::{self, Options};
use serde_json::{Value, json};

use super::*;

const TOPIC: &str = "sessions-index//w";

fn topics() -> Arc<Topics> {
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    Arc::new(Topics::new(context, &scope.spawner()))
}

fn row(session: &str) -> Value {
    json!({
        "sessionId": session,
        "workspaceId": "/w",
        "title": "t",
        "phase": "draft",
        "sessionEnded": false,
        "hasBackgroundWork": false,
        "lastActivityAt": 1,
        "createdAt": 1,
    })
}

/// Removing a session answers the started subscriber with `session.removed`, and the row is gone
/// from the topic's own state, so a subscriber arriving afterwards gets a snapshot without it
/// (the stored half excludes soft-deleted sessions, so it cannot reappear from there either).
#[tokio::test]
async fn a_removed_session_gets_a_removal_delta_and_cannot_come_back() {
    let topics = topics();
    topics.subscribe(TOPIC, "sub-1", "conn-1");
    let started = topics
        .snapshot(TOPIC, "sub-1", Vec::new(), Purpose::Online)
        .expect("the subscription is registered");
    assert_eq!(started.payload["kind"], "snapshot");
    assert_eq!(
        started.payload["snapshot"]["sessions"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );

    let upserts = topics.changed(TOPIC, row("s1"));
    assert_eq!(upserts.len(), 1);
    assert_eq!(
        upserts[0].payload["deltas"][0]["op"], "session.upserted",
        "the live row reaches the started subscriber"
    );

    let removed = topics.dropped(TOPIC, "s1");
    assert_eq!(removed.len(), 1);
    assert_eq!(
        removed[0].payload["deltas"][0],
        json!({"op": "session.removed", "sessionId": "s1"}),
        "the removal is a sessions-index delta like Node's"
    );

    topics.subscribe(TOPIC, "sub-2", "conn-2");
    let after = topics
        .snapshot(TOPIC, "sub-2", Vec::new(), Purpose::Online)
        .expect("the subscription is registered");
    assert_eq!(
        after.payload["snapshot"]["sessions"]
            .as_array()
            .map(Vec::len),
        Some(0),
        "a snapshot after the removal no longer carries the row"
    );
}

/// The removal is recorded even when the topic never held a live row: a subscriber's snapshot may
/// have carried the row from the stored half, and the delta is what removes it there too.
#[tokio::test]
async fn a_removal_without_a_live_row_still_answers_the_subscriber() {
    let topics = topics();
    topics.subscribe(TOPIC, "sub-1", "conn-1");
    topics
        .snapshot(TOPIC, "sub-1", Vec::new(), Purpose::Online)
        .expect("the subscription is registered");
    let removed = topics.dropped(TOPIC, "s1");
    assert_eq!(removed.len(), 1);
    assert_eq!(
        removed[0].payload["deltas"][0],
        json!({"op": "session.removed", "sessionId": "s1"})
    );
}

/// Fork: a subagent's child session publishes no sessions-index row (Node skips `subagent_child`); interactive and
/// forked sessions do.
#[test]
fn only_task_sessions_are_listed_in_the_sessions_index() {
    use rust_cli_kernel_api::store::SessionKind;
    assert!(!crate::live::listed_in_sessions_index(
        SessionKind::Subagent
    ));
    assert!(crate::live::listed_in_sessions_index(
        SessionKind::Interactive
    ));
    assert!(crate::live::listed_in_sessions_index(SessionKind::Fork));
}

/// Node `removeSession` is global: a session leaves every loaded sessions index, not only the index of the directory
/// the request named (the session's workspace is not known to the purge that removes it).
#[tokio::test]
async fn removing_a_session_drops_it_from_every_loaded_index() {
    // The scope must outlive the queued removal: the `topics()` helper drops it on return, which cancels the writer.
    let scope = TaskScope::root("test", |_| {});
    let (out, _reader) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let context = Arc::new(Context::new(peer, Arc::new(FixedClock(5))));
    let topics = Arc::new(Topics::new(context, &scope.spawner()));
    // Seeded synchronously, as the other index tests do: the rows live in the loaded tables before the removal.
    topics.changed("sessions-index//w1", row("sess_x"));
    topics.changed("sessions-index//w2", row("sess_x"));
    topics.changed("sessions-index//w2", row("sess_y"));
    topics.remove_everywhere("sess_x");
    for _ in 0..200 {
        if topics.live_rows("/w1").is_empty() && topics.live_rows("/w2") == ["sess_y".to_owned()] {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!(
        "sess_x stayed in a loaded index: /w1 {:?}, /w2 {:?}",
        topics.live_rows("/w1"),
        topics.live_rows("/w2")
    );
}
