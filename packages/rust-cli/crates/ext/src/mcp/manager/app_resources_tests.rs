//! Fork (F7 PR 4): resource subscriptions of a Rust-run server, through the fake transport: the registry, the server
//! requests, the notifications routed to the owner's listener, and the drops (reconnect, prefix).

use std::sync::atomic::{AtomicUsize, Ordering};
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

use super::{Join, Outcome, ResourceSubscriptions};
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

/// The ticket of a uri's first subscriber.
fn ask(join: Join) -> u64 {
    let Join::Ask(ticket) = join else {
        panic!("the first subscriber asks the server");
    };
    ticket
}

/// F7 PR 4 (review, round 5): after a clear (a reconnect), a fresh ask owns the uri, and the old ticket's settle changes
/// nothing (the ticket guard). Regression check: the guard existed before; this pins it.
#[test]
fn a_clear_leaves_the_old_ticket_nothing_to_settle() {
    let mut subs = ResourceSubscriptions::default();
    let old = ask(subs.join("ui://a", "k1"));
    subs.clear();
    let fresh = ask(subs.join("ui://a", "k2"));
    assert!(
        !subs.settle("ui://a", old, Ok(()), true).release,
        "the old ticket is not the uri's"
    );
    assert!(
        matches!(subs.join("ui://a", "k3"), Join::Wait(_)),
        "the fresh request is still in flight"
    );
    assert!(!subs.settle("ui://a", fresh, Ok(()), false).release);
    assert!(matches!(subs.join("ui://a", "k4"), Join::Done));
}

#[test]
fn the_first_subscriber_asks_and_the_others_wait_for_its_outcome() {
    let mut subs = ResourceSubscriptions::default();
    let ticket = ask(subs.join("ui://a", "s1|a|1"));
    assert!(matches!(subs.join("ui://a", "s2|b|1"), Join::Wait(_)));
    assert!(
        matches!(subs.join("ui://a", "s1|a|1"), Join::Wait(_)),
        "the same key again waits too"
    );
    assert_eq!(subs.subscribers("ui://a"), ["s1|a|1", "s2|b|1"]);
    assert!(!subs.settle("ui://a", ticket, Ok(()), false).release);
}

#[test]
fn a_settled_uri_joins_without_a_request() {
    let mut subs = ResourceSubscriptions::default();
    let ticket = ask(subs.join("ui://a", "s1|a|1"));
    drop(subs.settle("ui://a", ticket, Ok(()), false));
    assert!(matches!(subs.join("ui://a", "s3|c|1"), Join::Done));
    assert_eq!(subs.subscribers("ui://a"), ["s1|a|1", "s3|c|1"]);
}

#[test]
fn a_failed_first_request_removes_every_subscriber_and_tells_the_waiters() {
    let mut subs = ResourceSubscriptions::default();
    let ticket = ask(subs.join("ui://a", "s1|a|1"));
    let Join::Wait(waiter) = subs.join("ui://a", "s2|b|1") else {
        panic!("a joiner waits");
    };
    let error = McpAppError::Failed {
        code: Some(-32602),
        message: "no such resource".to_owned(),
    };
    assert!(
        !subs
            .settle("ui://a", ticket, Err(error.clone()), false)
            .release
    );
    assert!(
        subs.subscribers("ui://a").is_empty(),
        "the joiner keeps nothing either"
    );
    assert_eq!(*waiter.borrow(), Outcome::Failed(error));
}

#[test]
fn removing_the_last_subscriber_of_a_subscribed_uri_reports_last() {
    let mut subs = ResourceSubscriptions::default();
    let ticket = ask(subs.join("ui://a", "k1"));
    drop(subs.settle("ui://a", ticket, Ok(()), false));
    assert!(matches!(subs.join("ui://a", "k2"), Join::Done));
    assert_eq!(subs.remove("ui://a", "k1"), Some(false));
    assert_eq!(subs.remove("ui://a", "k2"), Some(true));
    assert_eq!(
        subs.remove("ui://a", "k2"),
        None,
        "a key not registered is reported as such"
    );
    assert!(subs.subscribers("ui://a").is_empty());
}

#[test]
fn removing_the_last_subscriber_of_a_uri_in_flight_asks_for_a_release_only_if_it_lands() {
    let mut subs = ResourceSubscriptions::default();
    let ticket = ask(subs.join("ui://a", "k1"));
    assert_eq!(
        subs.remove("ui://a", "k1"),
        Some(false),
        "the server holds nothing yet"
    );
    assert!(
        subs.settle("ui://a", ticket, Ok(()), false).release,
        "the request landed for nobody: the caller unsubscribes"
    );
}

#[test]
fn a_prefix_release_reports_only_the_uris_the_server_holds_that_it_emptied() {
    let mut subs = ResourceSubscriptions::default();
    let a = ask(subs.join("ui://a", "s1|x|1"));
    drop(subs.settle("ui://a", a, Ok(()), false));
    subs.join("ui://a", "s2|y|1");
    let b = ask(subs.join("ui://b", "s1|x|1"));
    drop(subs.settle("ui://b", b, Ok(()), false));
    let c = ask(subs.join("ui://c", "s1|x|1"));
    assert_eq!(
        subs.remove_prefix("s1|"),
        ["ui://b"],
        "ui://c is still in flight"
    );
    assert_eq!(subs.subscribers("ui://a"), ["s2|y|1"]);
    assert!(subs.remove_prefix("s1|").is_empty());
    assert!(
        subs.settle("ui://c", c, Ok(()), false).release,
        "c's request lands for nobody"
    );
}

#[test]
fn the_server_lists_each_subscriber_once() {
    let mut subs = ResourceSubscriptions::default();
    let a = ask(subs.join("ui://a", "k1"));
    drop(subs.settle("ui://a", a, Ok(()), false));
    let b = ask(subs.join("ui://b", "k1"));
    drop(subs.settle("ui://b", b, Ok(()), false));
    assert!(matches!(subs.join("ui://b", "k2"), Join::Done));
    assert_eq!(subs.all_subscribers(), ["k1", "k2"]);
    subs.clear();
    assert!(subs.all_subscribers().is_empty());
}

/// F7 PR 4 (review): a uri whose request is in flight keeps its entry when its last subscriber leaves, so the next
/// subscriber joins that request instead of starting a second one (no stale ticket can then land).
#[test]
fn a_removed_in_flight_uri_keeps_its_request_for_the_next_joiner() {
    let mut subs = ResourceSubscriptions::default();
    let ticket = ask(subs.join("ui://a", "k1"));
    assert_eq!(subs.remove("ui://a", "k1"), Some(false));
    assert!(
        matches!(subs.join("ui://a", "k2"), Join::Wait(_)),
        "the request in flight is still the uri's"
    );
    assert!(
        !subs.settle("ui://a", ticket, Ok(()), false).release,
        "k2 keeps the subscription"
    );
    assert!(matches!(subs.join("ui://a", "k3"), Join::Done));
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

/// F7 PR 4 (review): a joiner of a uri whose first request fails gets that failure and keeps nothing. Only the first
/// subscriber reached the server.
#[tokio::test]
async fn a_joiner_of_a_failed_first_request_fails_too_and_keeps_nothing() {
    let refusal = Err((-32602, "no such resource".to_owned()));
    let (manager, fake, _scope) = connected(subscribing_server(true, refusal)).await;
    let connection = connection(&manager);
    let cancel = CancellationToken::new();
    let (first, joiner) = tokio::join!(
        manager.app_subscribe("files", &connection, "ui://a", "s1|scope1|1", &cancel),
        manager.app_subscribe("files", &connection, "ui://a", "s2|scope2|1", &cancel),
    );
    assert!(first.is_err(), "{first:?}");
    assert!(
        joiner.is_err(),
        "the joiner must not succeed without the server: {joiner:?}"
    );
    assert_eq!(sent(&fake, "resources/subscribe").len(), 1);
    assert_eq!(
        manager.app_unsubscribe_prefix("s2|"),
        0,
        "the joiner keeps nothing"
    );
}

/// F7 PR 4 (review): a joiner of a successful first request shares its success, and the server is asked once.
#[tokio::test]
async fn a_joiner_of_a_successful_first_request_shares_its_success() {
    let (manager, fake, _scope) = connected(subscribing_server(true, Ok(json!({})))).await;
    let connection = connection(&manager);
    let cancel = CancellationToken::new();
    let (first, joiner) = tokio::join!(
        manager.app_subscribe("files", &connection, "ui://a", "s1|scope1|1", &cancel),
        manager.app_subscribe("files", &connection, "ui://a", "s2|scope2|1", &cancel),
    );
    assert!(first.is_ok(), "{first:?}");
    assert!(joiner.is_ok(), "{joiner:?}");
    assert_eq!(sent(&fake, "resources/subscribe").len(), 1);
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

/// F7 PR 4 (review): an unsubscribe does not wait for the server's reply (the prefix path does not either).
#[tokio::test]
async fn an_unsubscribe_does_not_wait_for_the_server_reply() {
    let handler = server(
        json!({"resources": {"subscribe": true}}),
        None,
        |method, _| {
            match method {
                "resources/subscribe" => Some(Ok(json!({}))),
                // The unsubscribe is never answered.
                _ => None,
            }
        },
    );
    let (manager, _fake, _scope) = connected(handler).await;
    let connection = connection(&manager);
    manager
        .app_subscribe(
            "files",
            &connection,
            "ui://a",
            "k1",
            &CancellationToken::new(),
        )
        .await
        .expect("subscribed");
    let done = tokio::time::timeout(
        Duration::from_secs(2),
        manager.app_unsubscribe("files", "ui://a", "k1"),
    )
    .await;
    assert!(
        done.is_ok(),
        "the unsubscribe waited for a reply the server never sent"
    );
}

/// F7 PR 4 (review): the capability is read as Node reads it, a JavaScript truthy value.
#[test]
fn the_subscribe_capability_is_read_as_node_reads_it() {
    use super::super::app_resources::resource_subscribes;
    assert!(resource_subscribes(
        &json!({"resources": {"subscribe": true}})
    ));
    assert!(resource_subscribes(
        &json!({"resources": {"subscribe": {}}})
    ));
    assert!(resource_subscribes(
        &json!({"resources": {"subscribe": "yes"}})
    ));
    assert!(!resource_subscribes(
        &json!({"resources": {"subscribe": false}})
    ));
    assert!(!resource_subscribes(
        &json!({"resources": {"subscribe": 0}})
    ));
    assert!(!resource_subscribes(
        &json!({"resources": {"subscribe": ""}})
    ));
    assert!(!resource_subscribes(
        &json!({"resources": {"subscribe": null}})
    ));
    assert!(!resource_subscribes(&json!({"resources": {}})));
}

/// F7 PR 4 (review, round 4): an asker dropped while its request is in flight settles its uri, so a joiner gets an error
/// and the uri is not left pending. The server never answers here.
#[tokio::test]
async fn a_dropped_asker_settles_its_uri_and_its_joiner_gets_an_error() {
    let handler = server(
        json!({"resources": {"subscribe": true}}),
        None,
        |_method, _| None,
    );
    let (manager, fake, _scope) = connected(handler).await;
    let connection = connection(&manager);
    let never = CancellationToken::new();
    let asker = tokio::time::timeout(
        Duration::from_secs(3),
        manager.app_subscribe("files", &connection, "ui://a", "s1|scope1|1", &never),
    );
    let joiner = async {
        // Joins once the asker's request is on the wire (review, round 5: no sleep-based ordering).
        wait_for_request(&fake, "resources/subscribe", 1).await;
        manager
            .app_subscribe("files", &connection, "ui://a", "s2|scope2|1", &never)
            .await
    };
    let both = tokio::time::timeout(Duration::from_secs(8), async {
        tokio::join!(asker, joiner)
    })
    .await;
    let (asked, joined) = both.expect("the joiner must not wait for ever on a dropped asker");
    assert!(asked.is_err(), "the asker timed out");
    assert!(joined.is_err(), "the joiner gets an error: {joined:?}");
    assert_eq!(
        manager.app_unsubscribe_prefix("s2|"),
        0,
        "the joiner keeps nothing"
    );
    // The dropped asker's request may have reached the server, so the server is released (review, round 5).
    wait_for_request(&fake, "resources/unsubscribe", 1).await;
    assert_eq!(
        sent(&fake, "resources/unsubscribe").len(),
        1,
        "the unsubscribe reaches the server"
    );
}

/// F7 PR 4 (review, round 4): a joiner that is cancelled stops waiting for the first request at its own cancel.
#[tokio::test]
async fn a_cancelled_joiner_stops_waiting_for_the_first_request() {
    let handler = server(
        json!({"resources": {"subscribe": true}}),
        None,
        |_method, _| None,
    );
    let (manager, fake, _scope) = connected(handler).await;
    let connection = connection(&manager);
    let joiner_cancel = CancellationToken::new();
    let start = std::time::Instant::now();
    let never = CancellationToken::new();
    let asker = tokio::time::timeout(
        Duration::from_secs(5),
        manager.app_subscribe("files", &connection, "ui://a", "s1|scope1|1", &never),
    );
    let joiner = async {
        wait_for_request(&fake, "resources/subscribe", 1).await;
        let cancel_later = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            joiner_cancel.cancel();
        };
        let (result, ()) = tokio::join!(
            manager.app_subscribe(
                "files",
                &connection,
                "ui://a",
                "s2|scope2|1",
                &joiner_cancel
            ),
            cancel_later,
        );
        (result, start.elapsed())
    };
    let both = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(asker, joiner)
    })
    .await;
    let (_asked, (joined, joined_after)) = both.expect("the cancelled joiner must return");
    assert_eq!(joined, Err(McpAppError::Cancelled));
    assert!(
        joined_after < Duration::from_secs(2),
        "the joiner stopped at its cancel, not at the asker's timeout: {joined_after:?}"
    );
}

/// F7 PR 4 (review, round 5): an asker cancelled while its request is in flight returns, and the server may have taken the
/// request, so the unsubscribe reaches the server (as a dropped asker's does).
#[tokio::test]
async fn a_cancelled_asker_releases_the_server_it_may_have_reached() {
    let handler = server(
        json!({"resources": {"subscribe": true}}),
        None,
        |method, _| match method {
            "resources/unsubscribe" => Some(Ok(json!({}))),
            // The subscribe is never answered.
            _ => None,
        },
    );
    let (manager, fake, _scope) = connected(handler).await;
    let connection = connection(&manager);
    let cancel = CancellationToken::new();
    let asker = manager.app_subscribe("files", &connection, "ui://a", "s1|scope1|1", &cancel);
    let stopper = async {
        wait_for_request(&fake, "resources/subscribe", 1).await;
        cancel.cancel();
    };
    let (result, ()) = tokio::join!(asker, stopper);
    assert_eq!(result, Err(McpAppError::Cancelled));
    wait_for_request(&fake, "resources/unsubscribe", 1).await;
    assert_eq!(
        sent(&fake, "resources/unsubscribe").len(),
        1,
        "the cancelled request is released on the server"
    );
}

/// F7 PR 4 (review, round 5): an asker dropped on an old connection never unsubscribes a uri that a newer connection holds.
#[tokio::test]
async fn an_asker_dropped_on_an_old_connection_never_unsubscribes_a_newer_one() {
    let asks = Arc::new(AtomicUsize::new(0));
    let counter = asks.clone();
    let handler = server(
        json!({"resources": {"subscribe": true}}),
        None,
        move |method, _| match method {
            // The first subscribe hangs (its asker is dropped); the later ones answer.
            "resources/subscribe" => {
                if counter.fetch_add(1, Ordering::SeqCst) == 0 {
                    None
                } else {
                    Some(Ok(json!({})))
                }
            }
            "resources/unsubscribe" => Some(Ok(json!({}))),
            _ => None,
        },
    );
    let (manager, fake, _scope) = connected(handler).await;
    let old = connection(&manager);
    let dropped = tokio::time::timeout(
        Duration::from_millis(100),
        manager.app_subscribe(
            "files",
            &old,
            "ui://a",
            "s1|scope1|1",
            &CancellationToken::new(),
        ),
    )
    .await;
    assert!(
        dropped.is_err(),
        "the first request hangs and its asker is dropped"
    );
    manager
        .control(McpAction::Reconnect, &["files".to_owned()])
        .await;
    let new = connection(&manager);
    // The dropped asker's release (if any) runs once the new connection is up; it must not reach that connection.
    tokio::time::sleep(Duration::from_millis(100)).await;
    manager
        .app_subscribe(
            "files",
            &new,
            "ui://a",
            "s2|scope2|1",
            &CancellationToken::new(),
        )
        .await
        .expect("subscribed on the new connection");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        sent(&fake, "resources/unsubscribe").is_empty(),
        "no unsubscribe reached the new connection: {:?}",
        sent(&fake, "resources/unsubscribe")
    );
}

/// F7 PR 4 (review, round 5): a joiner cancelled while it waits leaves no key behind: when the first request later
/// succeeds, the uri's subscribers are the first subscriber only.
#[tokio::test]
async fn a_cancelled_joiner_leaves_no_key_behind() {
    let handler = server(
        json!({"resources": {"subscribe": true}}),
        None,
        |_method, _| None,
    );
    let (manager, fake, _scope) = connected(handler).await;
    let connection = connection(&manager);
    let joiner_cancel = CancellationToken::new();
    let never = CancellationToken::new();
    let asker = manager.app_subscribe("files", &connection, "ui://a", "s1|scope1|1", &never);
    let joiner = async {
        wait_for_request(&fake, "resources/subscribe", 1).await;
        let cancel_later = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            joiner_cancel.cancel();
        };
        let (result, ()) = tokio::join!(
            manager.app_subscribe(
                "files",
                &connection,
                "ui://a",
                "s2|scope2|1",
                &joiner_cancel
            ),
            cancel_later,
        );
        result
    };
    // The first request is answered after the joiner has left.
    let answer = async {
        wait_for_request(&fake, "resources/subscribe", 1).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        let id = sent(&fake, "resources/subscribe")[0]["id"].clone();
        fake.push("files", json!({"jsonrpc": "2.0", "id": id, "result": {}}));
    };
    let (asked, joined, ()) = tokio::join!(asker, joiner, answer);
    assert!(asked.is_ok(), "{asked:?}");
    assert_eq!(joined, Err(McpAppError::Cancelled));

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

/// Waits until the fake server has received `count` requests of `method`.
async fn wait_for_request(fake: &FakeMcp, method: &str, count: usize) {
    wait_until(|| sent(fake, method).len() >= count).await;
}

/// Regression (review): a subscription guarded by a connection that has since changed is refused before it is added.
#[tokio::test]
async fn a_subscription_on_a_changed_connection_is_refused() {
    let (manager, fake, _scope) = connected(subscribing_server(true, Ok(json!({})))).await;
    let old = connection(&manager);
    manager
        .control(McpAction::Reconnect, &["files".to_owned()])
        .await;
    let refused = manager
        .app_subscribe(
            "files",
            &old,
            "ui://a",
            "s1|scope1|1",
            &CancellationToken::new(),
        )
        .await;
    assert_eq!(refused, Err(McpAppError::Changed));
    assert!(sent(&fake, "resources/subscribe").is_empty());
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
