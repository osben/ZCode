//! Revalidating a connection set in place (the settings lane's connect): unchanged connections stay, the rest follow
//! the new set, and a connected server is probed with `ping`.
use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::manage::McpServerState;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use serde_json::json;

use super::super::McpSettings;
use super::*;
use crate::mcp::McpScope;
use crate::test_support::{FakeMcp, server, workspace};

fn config(name: &str, command: &str) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::stdio(command.to_owned(), Vec::new()),
        options: crate::mcp::McpServerOptions {
            timeout_ms: Some(80),
            always_load: false,
        },
        oauth: None,
        machine: Default::default(),
    }
}

fn answering(
    ping: impl Fn() -> Option<Result<serde_json::Value, (i64, String)>> + Send + Sync + 'static,
) -> Arc<crate::test_support::Handler> {
    server(json!({"tools": {}}), None, move |method, _| match method {
        "tools/list" => Some(Ok(json!({"tools": [
            {"name": "read", "inputSchema": {"type": "object"}}
        ]}))),
        "ping" => ping(),
        _ => None,
    })
}

fn live(
    ping: impl Fn() -> Option<Result<serde_json::Value, (i64, String)>> + Send + Sync + 'static,
) -> Arc<crate::test_support::Handler> {
    answering(ping)
}

fn handshakes(fake: &FakeMcp, name: &str) -> usize {
    fake.received()
        .iter()
        .filter(|(server, message)| server == name && message["method"] == "initialize")
        .count()
}

fn manager(fake: &Arc<FakeMcp>) -> (TaskScope, McpManager) {
    let scope = TaskScope::root("test", |_| {});
    let manager = McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
    );
    (scope, manager)
}

async fn apply(manager: &McpManager, servers: Vec<McpServer>) {
    manager
        .reconcile(workspace(), servers)
        .settle(manager)
        .await;
    manager.wait_ready().await;
}

fn state_of(manager: &McpManager, name: &str) -> Option<McpServerState> {
    manager
        .server_infos()
        .into_iter()
        .find(|info| info.name == name)
        .map(|info| info.state)
}

#[tokio::test]
async fn an_unchanged_connected_server_keeps_its_connection() {
    let fake = Arc::new(FakeMcp::default().with("files", live(|| Some(Ok(json!({}))))));
    let (_scope, manager) = manager(&fake);
    apply(&manager, vec![config("files", "node")]).await;
    apply(&manager, vec![config("files", "node")]).await;
    assert_eq!(handshakes(&fake, "files"), 1);
    assert_eq!(state_of(&manager, "files"), Some(McpServerState::Connected));
}

#[tokio::test]
async fn a_server_that_answers_ping_with_an_error_is_alive() {
    let fake = Arc::new(
        FakeMcp::default().with("files", live(|| Some(Err((-32601, "no ping".to_owned()))))),
    );
    let (_scope, manager) = manager(&fake);
    apply(&manager, vec![config("files", "node")]).await;
    apply(&manager, vec![config("files", "node")]).await;
    assert_eq!(handshakes(&fake, "files"), 1);
}

#[tokio::test]
async fn a_server_that_stops_answering_ping_reconnects() {
    let fake = Arc::new(FakeMcp::default().with("files", live(|| None)));
    let (_scope, manager) = manager(&fake);
    apply(&manager, vec![config("files", "node")]).await;
    apply(&manager, vec![config("files", "node")]).await;
    assert_eq!(handshakes(&fake, "files"), 2);
    assert_eq!(state_of(&manager, "files"), Some(McpServerState::Connected));
}

#[tokio::test]
async fn changed_removed_and_new_servers_follow_the_set() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("files", live(|| Some(Ok(json!({})))))
            .with("gone", live(|| Some(Ok(json!({})))))
            .with("fresh", live(|| Some(Ok(json!({}))))),
    );
    let (_scope, manager) = manager(&fake);
    apply(
        &manager,
        vec![config("files", "node"), config("gone", "node")],
    )
    .await;
    apply(
        &manager,
        vec![config("files", "bun"), config("fresh", "node")],
    )
    .await;
    // The changed server reconnects once, the removed one is forgotten, the new one connects.
    assert_eq!(handshakes(&fake, "files"), 2);
    assert_eq!(handshakes(&fake, "gone"), 1);
    assert_eq!(handshakes(&fake, "fresh"), 1);
    assert_eq!(state_of(&manager, "gone"), None);
    assert_eq!(state_of(&manager, "files"), Some(McpServerState::Connected));
    assert_eq!(state_of(&manager, "fresh"), Some(McpServerState::Connected));
}

#[tokio::test]
async fn a_failed_server_is_tried_again() {
    let fake = Arc::new(
        FakeMcp::default()
            .with("files", live(|| None))
            .refusing("files"),
    );
    let (_scope, manager) = manager(&fake);
    apply(&manager, vec![config("files", "node")]).await;
    assert_eq!(state_of(&manager, "files"), Some(McpServerState::Failed));
    let attempts = fake.connect_headers_of("files").len();
    apply(&manager, vec![config("files", "node")]).await;
    assert_eq!(fake.connect_headers_of("files").len(), attempts + 1);
}

#[tokio::test]
async fn silent_servers_are_probed_at_the_same_time() {
    let silent = || live(|| None);
    let fake = Arc::new(
        FakeMcp::default()
            .with("a", silent())
            .with("b", silent())
            .with("c", silent()),
    );
    let (_scope, manager) = manager(&fake);
    let all = || {
        vec![
            config("a", "node"),
            config("b", "node"),
            config("c", "node"),
        ]
    };
    apply(&manager, all()).await;
    let started = std::time::Instant::now();
    manager.reconcile(workspace(), all()).settle(&manager).await;
    // Each probe waits 80 ms (the servers' own timeout); one after another they would take 240 ms.
    assert!(started.elapsed() < std::time::Duration::from_millis(200));
}

#[tokio::test]
async fn a_stale_probe_does_not_restart_a_newer_connection() {
    let fake = Arc::new(FakeMcp::default().with("files", live(|| None)));
    let (_scope, manager) = manager(&fake);
    apply(&manager, vec![config("files", "node")]).await;
    let stale = manager.reconcile(workspace(), vec![config("files", "node")]);
    let probing = stale.settle(&manager);
    let newer = async {
        // The probe is waiting for its ping when a newer connect changes the server's configuration.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let next = manager.reconcile(workspace(), vec![config("files", "bun")]);
        next.settle(&manager).await;
    };
    tokio::join!(probing, newer);
    manager.wait_ready().await;
    // The first handshake, then the changed configuration's: the stale probe adds none.
    assert_eq!(handshakes(&fake, "files"), 2);
}

#[tokio::test]
async fn a_retired_cua_server_never_starts() {
    let fake = Arc::new(FakeMcp::default().with("computer-use", live(|| None)));
    let (_scope, manager) = manager(&fake);
    apply(&manager, vec![config("computer-use", "node")]).await;
    assert_eq!(state_of(&manager, "computer-use"), None);
    assert_eq!(handshakes(&fake, "computer-use"), 0);
    manager.start(workspace(), vec![config("computer-use", "node")]);
    manager.register_disabled(vec![config("computer-use", "node")]);
    assert!(manager.server_infos().is_empty());
}
