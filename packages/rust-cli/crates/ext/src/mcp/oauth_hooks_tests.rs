//! Manager-level tests of the PR2 connection hooks (`specs/fork-rust-mcp-oauth.md`): a 401 starts one flow,
//! the bearer is added unless the server sets its own, a successful flow reconnects the server, and a
//! status snapshot starts nothing. The transport is `FakeMcp` (401 without a bearer); the flow runs on the
//! fake runtime and store from `oauth/flow_tests.rs`.

use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::mcp::McpTransportConfig;

use super::*;
use crate::clock_tests::clock;
use crate::mcp::config::{McpScope, McpServerOptions, McpSettings};
use crate::mcp::oauth::flow_tests::{FakeRuntime, MemoryStore, callback, expected_state};
use crate::mcp::oauth::{McpOAuthStore, McpOAuthWrite, credential_key, credential_key_prefix};
use crate::test_support::{FakeMcp, Handler, server, workspace};

const URL: &str = "https://mcp.example.test/mcp";

fn remote(name: &str, url: &str, headers: &[(&str, &str)]) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::User,
        transport: McpTransportConfig::http(
            url.to_owned(),
            headers
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
        ),
        options: McpServerOptions {
            timeout_ms: None,
            always_load: true,
        },
        machine: Default::default(),
        oauth: None,
    }
}

/// The credential prefix of a server without an `oauth` block (Node: no client id, scope or redirect path).
fn prefix(name: &str, url: &str) -> String {
    credential_key_prefix(name, url, None, None, None)
}

async fn until(mut condition: impl FnMut() -> bool) {
    for _ in 0..500 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached in time");
}

fn manager(fake: &Arc<FakeMcp>, scope: &TaskScope) -> McpManager {
    McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        clock(),
    )
}

#[tokio::test]
async fn a_401_starts_one_flow_and_the_flow_waits_for_the_browser() {
    let fake = Arc::new(
        FakeMcp::default()
            .challenged("remote")
            .with("remote", handler()),
    );
    let store = Arc::new(MemoryStore::default());
    let runtime = Arc::new(FakeRuntime::new(vec![]));
    let scope = TaskScope::root("test", |_| {});
    let manager = manager(&fake, &scope);
    manager.enable_oauth(store.clone(), runtime.clone());
    manager.start(workspace(), vec![remote("remote", URL, &[])]);
    manager.wait_ready().await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    until(|| runtime.listen_count() == 1).await;
    let pending = credential_key(&prefix("remote", URL), "pending_authorization");
    until(|| store.has_key(&pending)).await;
    // A further connect while the flow runs must not start another one.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(runtime.listen_count(), 1);

    let coordinator = manager.oauth_coordinator_for_test().expect("enabled");
    coordinator.cancel("remote");
    coordinator.wait_idle().await;
}

#[tokio::test]
async fn the_bearer_is_added_unless_the_server_sets_its_own_authorization() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("plain", handler())
            .with("own", handler()),
    );
    let store = Arc::new(MemoryStore::default());
    let runtime = Arc::new(FakeRuntime::new(vec![]));
    let canonical = serde_json::json!({
        "client_information": {"client_id": "c"},
        "tokens": {"access_token": "tok-fresh", "token_type": "Bearer"},
        "generation": "gen-1",
        "published_by": "att-1",
        "version": 2,
    })
    .to_string();
    for (name, url) in [
        ("plain", "https://mcp.example.test/plain"),
        ("own", "https://mcp.example.test/own"),
    ] {
        // The canonical record and its legacy mirror, as Node publishes them.
        store
            .apply(&[
                McpOAuthWrite::Put {
                    key: credential_key(&prefix(name, url), "authorization_credentials"),
                    value: canonical.clone(),
                },
                McpOAuthWrite::Put {
                    key: credential_key(&prefix(name, url), "client_information"),
                    value: r#"{"client_id":"c"}"#.to_owned(),
                },
                McpOAuthWrite::Put {
                    key: credential_key(&prefix(name, url), "tokens"),
                    value: r#"{"access_token":"tok-fresh","token_type":"Bearer"}"#.to_owned(),
                },
            ])
            .await
            .expect("seed");
    }
    let scope = TaskScope::root("test", |_| {});
    let manager = manager(&fake, &scope);
    manager.enable_oauth(store.clone(), runtime.clone());
    manager.start(
        workspace(),
        vec![
            remote("plain", "https://mcp.example.test/plain", &[]),
            remote(
                "own",
                "https://mcp.example.test/own",
                &[("Authorization", "Basic user-set")],
            ),
        ],
    );
    manager.wait_ready().await;

    let plain = fake.connect_headers_of("plain");
    assert_eq!(
        plain
            .last()
            .and_then(|h| h.get("Authorization"))
            .map(String::as_str),
        Some("Bearer tok-fresh")
    );
    let own = fake.connect_headers_of("own");
    assert_eq!(own.len(), 1);
    assert_eq!(
        own[0].get("Authorization").map(String::as_str),
        Some("Basic user-set")
    );
    // The bearer never starts a flow: the server answered without a challenge.
    assert_eq!(runtime.listen_count(), 0);
}

#[tokio::test]
async fn after_the_flow_succeeds_the_manager_reconnects_with_the_bearer() {
    let fake = Arc::new(
        FakeMcp::default()
            .challenged("remote")
            .with("remote", handler()),
    );
    let store = Arc::new(MemoryStore::default());
    let runtime = Arc::new(FakeRuntime::new(vec![callback(&expected_state())]));
    let scope = TaskScope::root("test", |_| {});
    let manager = manager(&fake, &scope);
    manager.enable_oauth(store.clone(), runtime.clone());
    manager.start(workspace(), vec![remote("remote", URL, &[])]);
    manager.wait_ready().await;

    // First attempt: no bearer, 401. The flow completes, the coordinator reconnects, and the second attempt
    // carries the freshly stored token.
    until(|| fake.connect_headers_of("remote").len() == 2).await;
    let attempts = fake.connect_headers_of("remote");
    assert!(!attempts[0].contains_key("Authorization"));
    assert_eq!(
        attempts[1].get("Authorization").map(String::as_str),
        Some("Bearer tok-access-1")
    );
    assert_eq!(runtime.listen_count(), 1);
    manager
        .oauth_coordinator_for_test()
        .expect("enabled")
        .wait_idle()
        .await;
}

#[tokio::test]
async fn a_status_snapshot_starts_no_flow_and_takes_no_lease() {
    let fake = Arc::new(
        FakeMcp::default()
            .challenged("remote")
            .with("remote", handler()),
    );
    let store = Arc::new(MemoryStore::default());
    let runtime = Arc::new(FakeRuntime::new(vec![]));
    let scope = TaskScope::root("test", |_| {});
    let manager = manager(&fake, &scope);
    manager.enable_oauth(store.clone(), runtime.clone());
    // Configured but not connected: a status read must not connect, start a flow, or take the lease.
    let _ = manager.server_infos();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(fake.connect_headers_of("remote").is_empty());
    assert_eq!(runtime.listen_count(), 0);
    assert_eq!(*store.lease_acquisitions.lock().unwrap(), 0);
}

/// A server that completes the handshake and lists no tools.
fn handler() -> Arc<Handler> {
    server(
        serde_json::json!({"tools": {}}),
        None,
        |method, _| match method {
            "tools/list" => Some(Ok(serde_json::json!({"tools": []}))),
            _ => None,
        },
    )
}
