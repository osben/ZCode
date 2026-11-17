//! Red tests for the Node-compatible MCP OAuth state (`specs/fork-rust-mcp-oauth.md`).
//! The fixture `testdata/node_fixture.json` was written by Node's own `saveDiscoveryRecord`,
//! `publishPendingAuthorization` and credential key helpers, so the bytes here are Node's.

use std::collections::BTreeMap;

use super::*;

const FIXTURE: &str = include_str!("testdata/node_fixture.json");
const NODE_PREFIX: &str = "mcp:oauth:169077245c7eff5a2c01d143";
const FIXTURE_NOW: i64 = 1_700_000_000_000;

#[derive(Default)]
struct MemoryStore(BTreeMap<String, String>);

#[async_trait::async_trait]
impl McpOAuthStore for MemoryStore {
    async fn load(&self, key: &str) -> Result<Option<String>, McpOAuthStoreError> {
        Ok(self.0.get(key).cloned())
    }
}

fn node_store() -> MemoryStore {
    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture json");
    let raw = fixture["raw"].as_object().expect("raw map");
    MemoryStore(
        raw.iter()
            .map(|(key, value)| (key.clone(), value.as_str().expect("string").to_owned()))
            .collect(),
    )
}

fn node_prefix() -> String {
    // Inputs of the fixture: serverName, serverUrl, clientId, scope, redirectPath.
    credential_key_prefix(
        "e2e-remote",
        "https://mcp.example.test/mcp",
        Some("client-1"),
        Some("read write"),
        Some("/cb"),
    )
}

#[test]
fn key_prefix_matches_node_hash() {
    assert_eq!(node_prefix(), NODE_PREFIX);
}

#[test]
fn key_prefix_treats_missing_fields_as_empty_strings() {
    // Node: `config.clientId ?? ""`, `config.scope ?? ""`, `config.redirectPath ?? ""`.
    let with_empty = credential_key_prefix("s", "https://x", None, None, None);
    let with_blank = credential_key_prefix("s", "https://x", Some(""), Some(""), Some(""));
    assert_eq!(with_empty, with_blank);
}

#[test]
fn credential_keys_and_lease_basename_match_node() {
    assert_eq!(
        credential_key(NODE_PREFIX, "pending_authorization"),
        format!("{NODE_PREFIX}:pending_authorization")
    );
    let lease = lease_path(
        std::path::Path::new("/home/u/.zcode/v2/credentials.json"),
        NODE_PREFIX,
    );
    assert_eq!(
        lease,
        std::path::Path::new("/home/u/.zcode/v2/mcp-oauth-169077245c7eff5a2c01d143.authz")
    );
}

#[tokio::test]
async fn pending_record_written_by_node_is_read_while_unexpired() {
    let store = node_store();
    let pending = load_pending(&store, NODE_PREFIX, FIXTURE_NOW + 1_000)
        .await
        .expect("read")
        .expect("pending");
    assert_eq!(pending.attempt_id, "attempt-fixture-1");
    assert_eq!(
        pending.authorization_url,
        "https://auth.example.test/authorize?state=s1"
    );
    assert_eq!(pending.state, "s1");
    assert_eq!(
        pending.baseline_generation.as_deref(),
        Some("gen-fixture-1")
    );
}

#[tokio::test]
async fn expired_pending_record_is_absent() {
    // Node: `if (parsed.expires_at <= now) return undefined`.
    let store = node_store();
    let at_expiry = load_pending(&store, NODE_PREFIX, 1_700_000_300_000)
        .await
        .expect("read");
    assert!(at_expiry.is_none());
}

#[tokio::test]
async fn malformed_pending_record_is_absent() {
    let mut store = node_store();
    store.0.insert(
        credential_key(NODE_PREFIX, "pending_authorization"),
        r#"{"attempt_id":1}"#.to_owned(),
    );
    assert!(
        load_pending(&store, NODE_PREFIX, FIXTURE_NOW)
            .await
            .expect("read")
            .is_none()
    );
}

#[tokio::test]
async fn discovery_record_written_by_node_is_fresh_within_ttl() {
    let store = node_store();
    let state = load_discovery(&store, NODE_PREFIX, None, FIXTURE_NOW + 60_000)
        .await
        .expect("read")
        .expect("fresh");
    assert_eq!(state["authorizationServerUrl"], "https://auth.example.test");
}

#[tokio::test]
async fn discovery_record_expires_after_24_hours() {
    // Node: `now - fetchedAt >= ttl` is stale.
    let store = node_store();
    let stale = load_discovery(&store, NODE_PREFIX, None, FIXTURE_NOW + 24 * 60 * 60 * 1000)
        .await
        .expect("read");
    assert!(stale.is_none());
}

#[tokio::test]
async fn discovery_issuer_mismatch_invalidates_cache() {
    let store = node_store();
    let other = load_discovery(
        &store,
        NODE_PREFIX,
        Some("https://other.example.test"),
        FIXTURE_NOW,
    )
    .await
    .expect("read");
    assert!(other.is_none());
    let same = load_discovery(
        &store,
        NODE_PREFIX,
        Some("https://auth.example.test/"),
        FIXTURE_NOW,
    )
    .await
    .expect("read");
    assert!(same.is_some(), "a trailing slash is normalised, as in Node");
}

#[tokio::test]
async fn canonical_v2_record_reads_generation_and_expiry() {
    let store = node_store();
    let canonical = load_canonical(&store, NODE_PREFIX)
        .await
        .expect("read")
        .expect("canonical");
    assert_eq!(canonical.generation, "gen-fixture-1");
    assert_eq!(canonical.expires_at, Some(FIXTURE_NOW + 3_600_000));
    assert_eq!(canonical.obtained_at, Some(FIXTURE_NOW));
}

#[tokio::test]
async fn canonical_record_without_generation_gets_legacy_hash_generation() {
    let mut store = node_store();
    let key = credential_key(NODE_PREFIX, "authorization_credentials");
    let raw = r#"{"client_information":{"client_id":"c"},"published_by":"t","tokens":{"access_token":"a","token_type":"Bearer"},"version":1}"#;
    store.0.insert(key, raw.to_owned());
    let canonical = load_canonical(&store, NODE_PREFIX)
        .await
        .expect("read")
        .expect("canonical");
    assert!(canonical.generation.starts_with("legacy-"));
    assert_eq!(canonical.generation.len(), "legacy-".len() + 32);
}

#[tokio::test]
async fn authorization_status_is_reported_only_for_a_live_pending_record() {
    let store = node_store();
    let live = pending_authorization_for(
        &store,
        &ServerOAuthIdentity {
            name: "e2e-remote".to_owned(),
            url: "https://mcp.example.test/mcp".to_owned(),
            client_id: Some("client-1".to_owned()),
            scope: Some("read write".to_owned()),
            redirect_path: Some("/cb".to_owned()),
        },
        FIXTURE_NOW,
    )
    .await
    .expect("read")
    .expect("authorization");
    assert_eq!(
        live.authorization_url,
        "https://auth.example.test/authorize?state=s1"
    );
    let expired = pending_authorization_for(
        &store,
        &ServerOAuthIdentity {
            name: "e2e-remote".to_owned(),
            url: "https://mcp.example.test/mcp".to_owned(),
            client_id: Some("client-1".to_owned()),
            scope: Some("read write".to_owned()),
            redirect_path: Some("/cb".to_owned()),
        },
        1_700_000_300_000,
    )
    .await
    .expect("read");
    assert!(expired.is_none());
}
