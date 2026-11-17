//! Red tests for the PR2 lease and pending record (`specs/fork-rust-mcp-oauth.md`, PR2 acceptance 1, 2, 8, 9).
//! `testdata/node_pr2_fixture.json` was written by Node's `publishPendingAuthorization` and
//! `resolveAuthorizationLeasePath`, so the expected bytes are Node's.

use std::collections::BTreeMap;
use std::sync::Mutex;

use super::*;

const FIXTURE: &str = include_str!("testdata/node_pr2_fixture.json");

#[derive(Default)]
struct FakeStore {
    raw: Mutex<BTreeMap<String, String>>,
    lease_calls: Mutex<u32>,
}

#[async_trait::async_trait]
impl McpOAuthStore for FakeStore {
    async fn load(&self, key: &str) -> Result<Option<String>, McpOAuthStoreError> {
        Ok(self.raw.lock().unwrap().get(key).cloned())
    }

    async fn apply(&self, writes: &[McpOAuthWrite]) -> Result<(), McpOAuthStoreError> {
        let mut raw = self.raw.lock().unwrap();
        for write in writes {
            match write {
                McpOAuthWrite::Put { key, value } => {
                    raw.insert(key.clone(), value.clone());
                }
                McpOAuthWrite::DeleteIfValue { key, expected } => {
                    if raw.get(key) == Some(expected) {
                        raw.remove(key);
                    }
                }
            }
        }
        Ok(())
    }

    async fn try_acquire_lease(
        &self,
        _key_prefix: &str,
    ) -> Result<Option<Box<dyn AuthorizationLease>>, McpOAuthStoreError> {
        *self.lease_calls.lock().unwrap() += 1;
        Ok(None)
    }
}

fn fixture_raw() -> BTreeMap<String, String> {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture json");
    fixture["raw"]
        .as_object()
        .expect("raw map")
        .iter()
        .map(|(key, value)| (key.clone(), value.as_str().expect("string").to_owned()))
        .collect()
}

fn fixture_prefix() -> String {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture json");
    fixture["keyPrefix"].as_str().expect("prefix").to_owned()
}

fn node_pending() -> PendingAuthorization {
    PendingAuthorization {
        attempt_id: "att-1".to_owned(),
        authorization_url: "https://auth.example.test/authorize?state=abc".to_owned(),
        baseline_generation: Some("gen-0".to_owned()),
        expires_at: 1_700_000_300_000,
        state: "abc".to_owned(),
    }
}

#[test]
fn pending_record_json_is_byte_identical_to_node() {
    // Node: JSON.stringify({attempt_id, authorization_url, baseline_generation?, expires_at, state}).
    let key = credential_key(&fixture_prefix(), "pending_authorization");
    let expected = &fixture_raw()[&key];
    assert_eq!(&pending_record_json(&node_pending()), expected);
}

#[test]
fn pending_record_without_baseline_omits_the_key_as_node_does() {
    // The fixture stores this record under the prefix `<prefix>x` (a second Node-written entry).
    let key = format!("{}x:pending_authorization", fixture_prefix());
    let expected = &fixture_raw()[&key];
    let record = PendingAuthorization {
        attempt_id: "att-2".to_owned(),
        authorization_url: "https://auth.example.test/authorize?state=def".to_owned(),
        baseline_generation: None,
        expires_at: 1_700_000_300_000,
        state: "def".to_owned(),
    };
    assert_eq!(&pending_record_json(&record), expected);
}

#[tokio::test]
async fn publish_writes_the_node_record_under_the_node_key() {
    let store = FakeStore::default();
    publish_pending(&store, &fixture_prefix(), &node_pending())
        .await
        .expect("publish");
    let key = credential_key(&fixture_prefix(), "pending_authorization");
    let raw = store.raw.lock().unwrap().get(&key).cloned();
    assert_eq!(raw.as_deref(), Some(fixture_raw()[&key].as_str()));
}

#[tokio::test]
async fn delete_removes_only_the_record_published_by_the_same_attempt() {
    let store = FakeStore::default();
    publish_pending(&store, &fixture_prefix(), &node_pending())
        .await
        .expect("publish");
    // A newer leader (attempt-2) has replaced the record: the old leader must not erase it.
    let other = PendingAuthorization {
        attempt_id: "att-2".to_owned(),
        ..node_pending()
    };
    publish_pending(&store, &fixture_prefix(), &other)
        .await
        .expect("publish");
    let deleted = delete_pending_if_owned(&store, &fixture_prefix(), "att-1")
        .await
        .expect("delete");
    assert!(!deleted, "a stale attempt must not delete the new record");
    let deleted = delete_pending_if_owned(&store, &fixture_prefix(), "att-2")
        .await
        .expect("delete");
    assert!(deleted);
}

#[tokio::test]
async fn live_pending_record_written_by_node_is_found_by_lookup() {
    let store = FakeStore {
        raw: Mutex::new(fixture_raw().into_iter().collect()),
        ..FakeStore::default()
    };
    let key = credential_key(&fixture_prefix(), "pending_authorization");
    assert!(store.load(&key).await.expect("read").is_some());
}

#[tokio::test]
async fn status_lookup_never_takes_the_lease() {
    // Acceptance 9: a read-only lookup must not call `try_acquire_lease`.
    let store = FakeStore::default();
    let identity = ServerOAuthIdentity {
        name: "e2e-remote".to_owned(),
        url: "https://mcp.example.test/mcp".to_owned(),
        client_id: None,
        scope: None,
        redirect_path: None,
    };
    let _ = pending_authorization_for(&store, &identity, 0).await;
    assert_eq!(*store.lease_calls.lock().unwrap(), 0);
}
