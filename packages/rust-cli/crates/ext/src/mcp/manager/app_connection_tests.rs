//! Fork (F7 PR 1): the connection identity, the guarded request and the generation bump of a server's connection.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::manage::McpAction;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::mcp_app::{McpAppConnection, McpAppError};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{canonical_json, identity_of};
use crate::mcp::McpScope;
use crate::mcp::config::{McpServer, McpSettings};
use crate::mcp::manager::McpManager;
use crate::test_support::{FakeMcp, server, workspace};

fn config(name: &str) -> McpServer {
    McpServer {
        name: name.to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
        options: Default::default(),
        oauth: None,
        machine: Default::default(),
    }
}

/// A server that answers the listing and a call, and leaves a call with no handler unanswered (a hung call).
fn answering_server() -> Arc<crate::test_support::Handler> {
    server(json!({"tools": {}}), None, |method, _params| match method {
        "tools/list" => Some(Ok(json!({"tools": [
            {"name": "read", "inputSchema": {"type": "object"}, "_meta": {"ui": {"visibility": ["app"]}}},
        ]}))),
        "tools/call" => Some(Ok(json!({"content": []}))),
        _ => None,
    })
}

fn hanging_server() -> Arc<crate::test_support::Handler> {
    server(json!({"tools": {}}), None, |method, _params| match method {
        "tools/list" => Some(Ok(json!({"tools": []}))),
        _ => None,
    })
}

fn manager(fake: Arc<FakeMcp>, scope: &TaskScope) -> McpManager {
    McpManager::new(
        fake,
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
    )
}

async fn connected(handler: Arc<crate::test_support::Handler>) -> (McpManager, TaskScope) {
    let scope = TaskScope::root("test", |_| {});
    let fake = Arc::new(FakeMcp::default().with("files", handler));
    let manager = manager(fake, &scope);
    manager.start(workspace(), vec![config("files")]);
    manager.wait_ready().await;
    (manager, scope)
}

#[test]
fn canonical_json_does_not_depend_on_the_order_of_keys() {
    let first: Value =
        serde_json::from_str(r#"{"b": {"y": 1, "x": 2}, "a": [{"d": 1, "c": 2}]}"#).unwrap();
    let second: Value =
        serde_json::from_str(r#"{"a": [{"c": 2, "d": 1}], "b": {"x": 2, "y": 1}}"#).unwrap();
    assert_eq!(canonical_json(&first), canonical_json(&second));
    let changed: Value =
        serde_json::from_str(r#"{"a": [{"c": 3, "d": 1}], "b": {"x": 2, "y": 1}}"#).unwrap();
    assert_ne!(canonical_json(&first), canonical_json(&changed));
}

#[test]
fn equal_configurations_hash_equal_whatever_order_their_maps_were_built_in() {
    let headers_a = [("Authorization", "t"), ("X-Trace", "1")];
    let headers_b = [("X-Trace", "1"), ("Authorization", "t")];
    let build = |pairs: &[(&str, &str)]| {
        let mut server = config("remote");
        server.transport = McpTransportConfig::http(
            "https://mcp.example.com/mcp".to_owned(),
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
        );
        server
    };
    assert_eq!(
        identity_of("/w", "remote", &build(&headers_a)),
        identity_of("/w", "remote", &build(&headers_b)),
    );
    let mut changed = build(&headers_a);
    changed.transport = McpTransportConfig::http(
        "https://mcp.example.com/mcp".to_owned(),
        [("Authorization".to_owned(), "other".to_owned())]
            .into_iter()
            .collect(),
    );
    assert_ne!(
        identity_of("/w", "remote", &build(&headers_a)),
        identity_of("/w", "remote", &changed),
    );
    assert_ne!(
        identity_of("/w", "remote", &build(&headers_a)),
        identity_of("/other", "remote", &build(&headers_a))
    );
}

#[tokio::test]
async fn a_connected_server_reports_its_connection_and_tool_visibility() {
    let (manager, _scope) = connected(answering_server()).await;
    let connection = manager.app_connection("files").expect("connected");
    assert!(connection.generation >= 1);
    assert_eq!(
        manager.tool_visibility("files", "read"),
        Some(vec!["app".to_owned()])
    );
    assert_eq!(manager.tool_visibility("files", "missing"), None);
    assert!(manager.app_connection("unknown").is_none());
}

#[tokio::test]
async fn a_guarded_request_passes_while_the_connection_is_unchanged() {
    let (manager, _scope) = connected(answering_server()).await;
    let connection = manager.app_connection("files").expect("connected");
    let answer = manager
        .app_request(
            "files",
            &connection,
            "tools/call",
            json!({"name": "read", "arguments": {}}),
            &CancellationToken::new(),
        )
        .await;
    assert!(answer.is_ok(), "{answer:?}");
    // The same request from a stale connection (an older generation) is refused before it is sent.
    let stale = McpAppConnection {
        identity: connection.identity.clone(),
        generation: connection.generation + 1,
    };
    assert_eq!(
        manager
            .app_request(
                "files",
                &stale,
                "tools/call",
                json!({}),
                &CancellationToken::new()
            )
            .await,
        Err(McpAppError::Changed)
    );
}

#[tokio::test]
async fn a_reconnect_during_a_call_fails_the_call_and_runs_the_listeners() {
    let (manager, _scope) = connected(hanging_server()).await;
    let connection = manager.app_connection("files").expect("connected");
    let fired = Arc::new(AtomicUsize::new(0));
    let counter = fired.clone();
    let subscription = manager
        .on_app_connection_changed(
            "files",
            Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .expect("known server");
    let reconnect = vec!["files".to_owned()];
    let cancel = CancellationToken::new();
    let (answer, _) = tokio::join!(
        manager.app_request(
            "files",
            &connection,
            "tools/call",
            json!({"name": "read", "arguments": {}}),
            &cancel,
        ),
        manager.control(McpAction::Reconnect, &reconnect),
    );
    assert!(
        answer.is_err(),
        "a call that outlived its connection must fail: {answer:?}"
    );
    assert!(
        fired.load(Ordering::SeqCst) >= 1,
        "the connection change ran the listener"
    );
    let after = manager.app_connection("files");
    assert!(
        after
            .as_ref()
            .is_none_or(|next| next.generation > connection.generation)
    );

    drop(subscription);
    let before = fired.load(Ordering::SeqCst);
    manager
        .control(McpAction::Reconnect, &["files".to_owned()])
        .await;
    assert_eq!(
        fired.load(Ordering::SeqCst),
        before,
        "a dropped subscription is not called"
    );
}
