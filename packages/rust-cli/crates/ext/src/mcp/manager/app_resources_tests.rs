//! Fork (F7 PR 4): resource subscriptions of a Rust-run server, through the fake transport: the registry, the server
//! requests, the notifications routed to the owner's listener, and the drops (reconnect, prefix).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::manage::McpAction;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::mcp_app::{
    McpAppConnection, McpAppError, McpResourceCallback, McpResourceNotice,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::ResourceSubscriptions;
use crate::mcp::McpScope;
use crate::mcp::config::{McpServer, McpSettings};
use crate::mcp::manager::McpManager;
use crate::test_support::{FakeMcp, Handler, server, workspace};

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

/// A server that declares `resources.subscribe` (or not) and answers the subscription requests with `answer`.
fn subscribing_server(capable: bool, answer: Result<Value, (i64, String)>) -> Arc<Handler> {
    let capabilities = if capable {
        json!({"resources": {"subscribe": true}})
    } else {
        json!({"resources": {}})
    };
    server(capabilities, None, move |method, _params| match method {
        "resources/subscribe" | "resources/unsubscribe" => Some(answer.clone()),
        _ => None,
    })
}

async fn connected(handler: Arc<Handler>) -> (McpManager, Arc<FakeMcp>, TaskScope) {
    let scope = TaskScope::root("test", |_| {});
    let fake = Arc::new(FakeMcp::default().with("files", handler));
    let manager = McpManager::new(
        fake.clone(),
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
    );
    manager.start(workspace(), vec![config("files")]);
    manager.wait_ready().await;
    (manager, fake, scope)
}

/// The requests of `method` the server received, in order.
fn sent(fake: &FakeMcp, method: &str) -> Vec<Value> {
    fake.received()
        .into_iter()
        .map(|(_, message)| message)
        .filter(|message| message["method"] == method)
        .collect()
}

fn key(session: &str, scope: &str, generation: u64) -> String {
    format!("{session}|{scope}|{generation}")
}

fn connection(manager: &McpManager) -> McpAppConnection {
    manager.app_connection("files").expect("connected")
}

/// The notices a listener received, in order.
fn listener() -> (Arc<Mutex<Vec<McpResourceNotice>>>, McpResourceCallback) {
    let notices = Arc::new(Mutex::new(Vec::new()));
    let sink = notices.clone();
    let callback: McpResourceCallback = Arc::new(move |notice| sink.lock().unwrap().push(notice));
    (notices, callback)
}

async fn wait_until(mut done: impl FnMut() -> bool) {
    for _ in 0..400 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

fn notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

#[test]
fn each_subscriber_of_a_uri_is_counted_once() {
    let mut subs = ResourceSubscriptions::default();
    assert!(subs.add("ui://a", "s1|a|1"), "the first subscriber");
    assert!(
        !subs.add("ui://a", "s2|b|1"),
        "a second subscriber is not the first"
    );
    assert!(
        !subs.add("ui://a", "s1|a|1"),
        "the same key again is not a new subscriber"
    );
    assert_eq!(subs.subscribers("ui://a"), ["s1|a|1", "s2|b|1"]);
    assert!(subs.subscribers("ui://missing").is_empty());
}

#[test]
fn removing_the_last_subscriber_of_a_uri_reports_last() {
    let mut subs = ResourceSubscriptions::default();
    subs.add("ui://a", "k1");
    subs.add("ui://a", "k2");
    assert_eq!(subs.remove("ui://a", "k1"), Some(false));
    assert_eq!(
        subs.remove("ui://a", "k1"),
        None,
        "a key not registered is reported as such"
    );
    assert_eq!(subs.remove("ui://a", "k2"), Some(true));
    assert!(subs.subscribers("ui://a").is_empty());
}

#[test]
fn a_prefix_release_reports_only_the_uris_it_emptied() {
    let mut subs = ResourceSubscriptions::default();
    subs.add("ui://a", "s1|x|1");
    subs.add("ui://a", "s2|y|1");
    subs.add("ui://b", "s1|x|1");
    assert_eq!(subs.remove_prefix("s1|"), ["ui://b"]);
    assert_eq!(subs.subscribers("ui://a"), ["s2|y|1"]);
    assert!(subs.remove_prefix("s1|").is_empty());
}

#[test]
fn the_server_lists_each_subscriber_once() {
    let mut subs = ResourceSubscriptions::default();
    subs.add("ui://a", "k1");
    subs.add("ui://b", "k1");
    subs.add("ui://b", "k2");
    assert_eq!(subs.all_subscribers(), ["k1", "k2"]);
    subs.clear();
    assert!(subs.all_subscribers().is_empty());
}

#[tokio::test]
async fn a_second_subscriber_of_a_uri_does_not_reach_the_server_again() {
    let (manager, fake, _scope) = connected(subscribing_server(true, Ok(json!({})))).await;
    let connection = connection(&manager);
    let cancel = CancellationToken::new();
    manager
        .app_subscribe(
            "files",
            &connection,
            "ui://a",
            &key("s1", "scope1", 1),
            &cancel,
        )
        .await
        .expect("subscribed");
    manager
        .app_subscribe(
            "files",
            &connection,
            "ui://a",
            &key("s2", "scope2", 1),
            &cancel,
        )
        .await
        .expect("subscribed");
    let asked = sent(&fake, "resources/subscribe");
    assert_eq!(asked.len(), 1, "one server subscription per uri: {asked:?}");
    assert_eq!(asked[0]["params"]["uri"], "ui://a");
}

#[tokio::test]
async fn a_server_without_the_subscribe_capability_refuses_the_subscription() {
    let (manager, fake, _scope) = connected(subscribing_server(false, Ok(json!({})))).await;
    let refused = manager
        .app_subscribe(
            "files",
            &connection(&manager),
            "ui://a",
            &key("s1", "scope1", 1),
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(
        refused,
        Err(McpAppError::NotSupported {
            server: "files".to_owned(),
            operation: "resources/subscribe".to_owned(),
        })
    );
    assert!(sent(&fake, "resources/subscribe").is_empty());
}

#[tokio::test]
async fn a_refused_server_subscription_leaves_no_subscriber_behind() {
    let refusal = Err((-32602, "no such resource".to_owned()));
    let (manager, fake, _scope) = connected(subscribing_server(true, refusal)).await;
    let connection = connection(&manager);
    let cancel = CancellationToken::new();
    let first = manager
        .app_subscribe(
            "files",
            &connection,
            "ui://a",
            &key("s1", "scope1", 1),
            &cancel,
        )
        .await;
    assert!(first.is_err(), "the server refused: {first:?}");
    // The failed subscriber is gone, so the same key is again the uri's first subscriber and reaches the server.
    let second = manager
        .app_subscribe(
            "files",
            &connection,
            "ui://a",
            &key("s1", "scope1", 1),
            &cancel,
        )
        .await;
    assert!(second.is_err());
    assert_eq!(sent(&fake, "resources/subscribe").len(), 2);
}

#[tokio::test]
async fn the_last_unsubscribe_reaches_the_server() {
    let (manager, fake, _scope) = connected(subscribing_server(true, Ok(json!({})))).await;
    let connection = connection(&manager);
    let cancel = CancellationToken::new();
    manager
        .app_subscribe("files", &connection, "ui://a", "k1", &cancel)
        .await
        .expect("subscribed");
    manager
        .app_subscribe("files", &connection, "ui://a", "k2", &cancel)
        .await
        .expect("subscribed");
    manager.app_unsubscribe("files", "ui://a", "k1").await;
    assert!(
        sent(&fake, "resources/unsubscribe").is_empty(),
        "k2 still subscribes"
    );
    manager.app_unsubscribe("files", "ui://a", "k2").await;
    wait_until(|| !sent(&fake, "resources/unsubscribe").is_empty()).await;
    let released = sent(&fake, "resources/unsubscribe");
    assert_eq!(released.len(), 1, "{released:?}");
    assert_eq!(released[0]["params"]["uri"], "ui://a");
}

#[tokio::test]
async fn an_update_reaches_the_listener_with_the_subscribers_of_its_uri() {
    let (manager, fake, _scope) = connected(subscribing_server(true, Ok(json!({})))).await;
    let connection = connection(&manager);
    let cancel = CancellationToken::new();
    manager
        .app_subscribe("files", &connection, "ui://a", "s1|scope1|1", &cancel)
        .await
        .expect("subscribed");
    manager
        .app_subscribe("files", &connection, "ui://b", "s2|scope2|1", &cancel)
        .await
        .expect("subscribed");
    let (notices, callback) = listener();
    let _subscription = manager
        .on_app_resource_notice("files", callback)
        .expect("known server");
    fake.push(
        "files",
        notification("notifications/resources/updated", json!({"uri": "ui://a"})),
    );
    wait_until(|| !notices.lock().unwrap().is_empty()).await;
    assert_eq!(
        *notices.lock().unwrap(),
        [McpResourceNotice::Updated {
            uri: "ui://a".to_owned(),
            subscribers: vec!["s1|scope1|1".to_owned()],
        }]
    );
}

#[tokio::test]
async fn a_list_change_reaches_the_listener_with_every_subscriber_of_the_server() {
    let (manager, fake, _scope) = connected(subscribing_server(true, Ok(json!({})))).await;
    let connection = connection(&manager);
    let cancel = CancellationToken::new();
    manager
        .app_subscribe("files", &connection, "ui://a", "s1|scope1|1", &cancel)
        .await
        .expect("subscribed");
    manager
        .app_subscribe("files", &connection, "ui://b", "s2|scope2|1", &cancel)
        .await
        .expect("subscribed");
    let (notices, callback) = listener();
    let _subscription = manager
        .on_app_resource_notice("files", callback)
        .expect("known server");
    fake.push(
        "files",
        notification("notifications/resources/list_changed", json!({})),
    );
    wait_until(|| !notices.lock().unwrap().is_empty()).await;
    assert_eq!(
        *notices.lock().unwrap(),
        [McpResourceNotice::ListChanged {
            subscribers: vec!["s1|scope1|1".to_owned(), "s2|scope2|1".to_owned()],
        }]
    );
}

#[tokio::test]
async fn an_update_of_a_uri_nobody_subscribes_reaches_no_listener() {
    let (manager, fake, _scope) = connected(subscribing_server(true, Ok(json!({})))).await;
    let connection = connection(&manager);
    manager
        .app_subscribe(
            "files",
            &connection,
            "ui://a",
            "s1|scope1|1",
            &CancellationToken::new(),
        )
        .await
        .expect("subscribed");
    let (notices, callback) = listener();
    let _subscription = manager
        .on_app_resource_notice("files", callback)
        .expect("known server");
    // The connection task handles the notices in order: once the subscribed uri arrives, the unsubscribed one has too.
    fake.push(
        "files",
        notification(
            "notifications/resources/updated",
            json!({"uri": "ui://nobody"}),
        ),
    );
    fake.push(
        "files",
        notification("notifications/resources/updated", json!({"uri": "ui://a"})),
    );
    wait_until(|| !notices.lock().unwrap().is_empty()).await;
    let seen = notices.lock().unwrap().clone();
    assert_eq!(
        seen,
        [McpResourceNotice::Updated {
            uri: "ui://a".to_owned(),
            subscribers: vec!["s1|scope1|1".to_owned()],
        }]
    );
}

#[tokio::test]
async fn a_reconnect_drops_the_subscriptions_and_replays_none() {
    let (manager, fake, _scope) = connected(subscribing_server(true, Ok(json!({})))).await;
    let connection = connection(&manager);
    manager
        .app_subscribe(
            "files",
            &connection,
            "ui://a",
            "s1|scope1|1",
            &CancellationToken::new(),
        )
        .await
        .expect("subscribed");
    manager
        .control(McpAction::Reconnect, &["files".to_owned()])
        .await;
    assert_eq!(
        sent(&fake, "resources/subscribe").len(),
        1,
        "the reconnect does not replay the subscription"
    );
    assert_eq!(
        manager.app_unsubscribe_prefix("s1|"),
        0,
        "the registry is empty after the reconnect"
    );
}

#[tokio::test]
async fn an_unsubscribe_by_prefix_drops_only_the_keys_it_names() {
    let (manager, fake, _scope) = connected(subscribing_server(true, Ok(json!({})))).await;
    let connection = connection(&manager);
    let cancel = CancellationToken::new();
    for (uri, subscriber) in [
        ("ui://a", "s1|scope1|1"),
        ("ui://a", "s2|scope2|1"),
        ("ui://b", "s1|scope1|1"),
    ] {
        manager
            .app_subscribe("files", &connection, uri, subscriber, &cancel)
            .await
            .expect("subscribed");
    }
    assert_eq!(
        manager.app_unsubscribe_prefix("s1|"),
        1,
        "only ui://b lost its last subscriber"
    );
    wait_until(|| !sent(&fake, "resources/unsubscribe").is_empty()).await;
    let released = sent(&fake, "resources/unsubscribe");
    assert_eq!(released.len(), 1, "{released:?}");
    assert_eq!(released[0]["params"]["uri"], "ui://b");
    assert_eq!(
        manager.app_unsubscribe_prefix("s1|"),
        0,
        "nothing of that prefix is left"
    );
}
