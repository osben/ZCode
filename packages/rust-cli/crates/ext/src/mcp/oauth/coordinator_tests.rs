//! Red tests for the PR2 connection hooks: bearer injection from canonical credentials, the flow
//! coordinator (one flow per credential key, reconnect after success, cancel), and the
//! `client_credentials` grant (`specs/fork-rust-mcp-oauth.md`, PR2 acceptance 9, 12, 13, 14).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::flow_tests::{FakeRuntime, MemoryStore, callback, expected_state};
use super::*;
use crate::mcp::oauth::coordinator::McpOAuthCoordinator;
use crate::mcp::oauth::protocol::{basic_auth, token_form_client_credentials};
use crate::mcp::oauth::refresh::RefreshInput;

const SERVER_URL: &str = "https://mcp.example.test/mcp";
const NOW: i64 = 1_700_000_000_000;

fn prefix() -> String {
    credential_key_prefix("e2e-remote", SERVER_URL, None, Some("mcp:tools"), None)
}

fn canonical_with(access: &str, expires_at: Option<i64>) -> String {
    let mut value = serde_json::json!({
        "client_information": {"client_id": "c"},
        "tokens": {"access_token": access, "token_type": "Bearer"},
        "generation": "gen-1",
        "published_by": "att-1",
        "version": 2,
    });
    if let Some(expires_at) = expires_at {
        value["expires_at"] = serde_json::json!(expires_at);
    }
    value.to_string()
}

/// The canonical record and its legacy mirror, as Node publishes them (see `refresh_tests::RefreshStore::seed`).
async fn seed(store: &MemoryStore, value: String) {
    let parsed: serde_json::Value = serde_json::from_str(&value).expect("canonical JSON");
    store
        .apply(&[
            McpOAuthWrite::Put {
                key: credential_key(&prefix(), "authorization_credentials"),
                value,
            },
            McpOAuthWrite::Put {
                key: credential_key(&prefix(), "client_information"),
                value: parsed["client_information"].to_string(),
            },
            McpOAuthWrite::Put {
                key: credential_key(&prefix(), "tokens"),
                value: parsed["tokens"].to_string(),
            },
        ])
        .await
        .expect("seed");
}

#[tokio::test]
async fn bearer_is_the_fresh_canonical_access_token() {
    let store = Arc::new(MemoryStore::default());
    seed(&store, canonical_with("tok-fresh", Some(NOW + 3_600_000))).await;
    let coordinator = McpOAuthCoordinator::new(
        store.clone(),
        Arc::new(FakeRuntime::new(vec![])),
        Arc::new(|_| {}),
    );
    assert_eq!(
        coordinator.fresh_bearer(&input()).await.expect("read"),
        Some("Bearer tok-fresh".to_owned())
    );
}

#[tokio::test]
async fn near_expiry_without_refresh_token_sends_the_current_token_as_node_does() {
    // Node `token()`: near expiry with no refresh token returns the current token; the server's 401 decides.
    let store = Arc::new(MemoryStore::default());
    seed(&store, canonical_with("tok-old", Some(NOW + 10_000))).await;
    let coordinator = McpOAuthCoordinator::new(
        store.clone(),
        Arc::new(FakeRuntime::new(vec![])),
        Arc::new(|_| {}),
    );
    assert_eq!(
        coordinator.fresh_bearer(&input()).await.expect("read"),
        Some("Bearer tok-old".to_owned())
    );
}

fn input() -> RefreshInput {
    RefreshInput {
        server_name: "e2e-remote".to_owned(),
        server_url: SERVER_URL.to_owned(),
        key_prefix: prefix(),
        static_client_id: None,
        client_secret: None,
        reactive: false,
    }
}

#[tokio::test]
async fn missing_credentials_give_no_bearer() {
    let store = Arc::new(MemoryStore::default());
    let coordinator = McpOAuthCoordinator::new(
        store.clone(),
        Arc::new(FakeRuntime::new(vec![])),
        Arc::new(|_| {}),
    );
    assert_eq!(
        coordinator.fresh_bearer(&input()).await.expect("read"),
        None
    );
}

#[tokio::test]
async fn one_flow_runs_per_server() {
    let store = Arc::new(MemoryStore::default());
    let runtime = Arc::new(FakeRuntime::new(vec![callback(&expected_state())]));
    let coordinator = Arc::new(McpOAuthCoordinator::new(
        store.clone(),
        runtime.clone(),
        Arc::new(|_| {}),
    ));
    assert!(coordinator.start("e2e-remote".into(), super::flow_tests::input()).await);
    assert!(!coordinator.start("e2e-remote".into(), super::flow_tests::input()).await);
    coordinator.wait_idle().await;
    assert_eq!(runtime.listen_count(), 1);
}

#[tokio::test]
async fn successful_flow_reconnects_the_server_once() {
    let store = Arc::new(MemoryStore::default());
    let runtime = Arc::new(FakeRuntime::new(vec![callback(&expected_state())]));
    let reconnects = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = reconnects.clone();
    let coordinator = Arc::new(McpOAuthCoordinator::new(
        store.clone(),
        runtime.clone(),
        Arc::new(move |name: &str| sink.lock().unwrap().push(name.to_owned())),
    ));
    coordinator.start("e2e-remote".into(), super::flow_tests::input()).await;
    coordinator.wait_idle().await;
    assert_eq!(*reconnects.lock().unwrap(), vec!["e2e-remote".to_owned()]);
}

#[tokio::test]
async fn cancel_ends_the_flow_and_removes_its_pending_record() {
    // No callback ever arrives: the listener waits; cancel must end the wait and clean up.
    let store = Arc::new(MemoryStore::default());
    let runtime = Arc::new(FakeRuntime::new(vec![]));
    let coordinator = Arc::new(McpOAuthCoordinator::new(
        store.clone(),
        runtime.clone(),
        Arc::new(|_| {}),
    ));
    coordinator.start("e2e-remote".into(), super::flow_tests::input()).await;
    for _ in 0..200 {
        if store.has_key(&credential_key(&prefix(), "pending_authorization")) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(store.has_key(&credential_key(&prefix(), "pending_authorization")));
    coordinator.cancel("e2e-remote");
    coordinator.wait_idle().await;
    assert!(!store.has_key(&credential_key(&prefix(), "pending_authorization")));
    // A cancelled flow is not a successful one: no canonical record was written.
    assert!(!store.has_key(&credential_key(&prefix(), "authorization_credentials")));
    // The slot is free again.
    assert!(coordinator.start("e2e-remote".into(), super::flow_tests::input()).await);
    coordinator.cancel("e2e-remote");
    coordinator.wait_idle().await;
}

#[test]
fn basic_auth_header_is_base64_of_client_id_and_secret() {
    // client_secret_basic (RFC 6749 2.3.1): base64("id:sec") = "aWQ6c2Vj".
    assert_eq!(basic_auth("id", "sec"), "Basic aWQ6c2Vj");
}

#[test]
fn client_credentials_token_form_carries_grant_and_scope() {
    // SDK ClientCredentialsProvider.prepareTokenRequest: grant_type, then scope when set.
    assert_eq!(
        token_form_client_credentials(Some("a b")),
        "grant_type=client_credentials&scope=a+b"
    );
    assert_eq!(
        token_form_client_credentials(None),
        "grant_type=client_credentials"
    );
}

#[tokio::test]
async fn client_credentials_bearer_uses_basic_auth_and_is_kept_in_memory() {
    let store = Arc::new(MemoryStore::default());
    let runtime = Arc::new(FakeRuntime::new(vec![]));
    let coordinator = McpOAuthCoordinator::new(store.clone(), runtime.clone(), Arc::new(|_| {}));
    let config = McpOAuthConfig::ClientCredentials {
        client_id: "id".into(),
        client_secret: "sec".into(),
        client_name: None,
        scope: Some("mcp:tools".into()),
    };
    let bearer = coordinator
        .client_credentials_bearer("cc", SERVER_URL, &config)
        .await
        .expect("token");
    assert_eq!(bearer, "Bearer tok-access-1");
    let requests = runtime.requests();
    let token = requests
        .iter()
        .find(|r| r.url.ends_with("/token"))
        .expect("token request");
    assert_eq!(
        token.body.as_deref(),
        Some("grant_type=client_credentials&scope=mcp%3Atools")
    );
    assert!(
        token
            .headers
            .iter()
            .any(|(name, value)| name == "Authorization" && value == "Basic aWQ6c2Vj")
    );
    // Client-credentials tokens are never written to the credential file.
    assert!(!store.has_key(&credential_key(&prefix(), "authorization_credentials")));
    // A second call within the lifetime reuses the cached token (no second token request).
    coordinator
        .client_credentials_bearer("cc", SERVER_URL, &config)
        .await
        .expect("cached");
    assert_eq!(
        runtime
            .requests()
            .iter()
            .filter(|r| r.url.ends_with("/token"))
            .count(),
        1
    );
}
