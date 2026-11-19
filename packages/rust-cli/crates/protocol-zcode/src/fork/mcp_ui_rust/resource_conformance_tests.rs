//! Fork (F7 PR 4): runs `tests/fixtures/mcp_ui_resource_subscriptions_conformance.json` against the Rust owner of the
//! panels: the protocol methods through the server's router, and a host whose registry follows the extension layer's
//! rules (one server subscription per uri, the last unsubscribe reaches the server, a reconnect clears it). The same
//! file runs against Node's handlers, registry and notification routing
//! (`apps/zcode-cli/packages/bootstrap/tests/fork-rust-helper/mcp-ui-resource-conformance.test.ts`); every step's
//! outcome must match in both.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, Weak};

use async_trait::async_trait;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_app::{
    McpAppConnection, McpAppError, McpAppHost, McpAppOwner, McpAppSubscription,
    McpResourceCallback, McpResourceNotice,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::super::legacy_session::tests::{automation_create, call, server};
use super::super::node_helper::HelperRequests;
use super::RustMcpUi;
use crate::server::Server;

const FIXTURE: &str =
    include_str!("../../../tests/fixtures/mcp_ui_resource_subscriptions_conformance.json");

/// The server's subscriptions as the extension layer keeps them: subscriber keys by uri, and the server requests made.
#[derive(Default)]
struct Registry {
    by_uri: BTreeMap<String, BTreeSet<String>>,
    subscribes: usize,
    unsubscribes: usize,
}

/// The server's connection and its registry. A reconnect publishes a new connection and clears the registry, as the
/// connection change of the extension layer does.
struct Host {
    connection: Mutex<McpAppConnection>,
    registry: Mutex<Registry>,
    listeners: Mutex<Vec<Arc<dyn Fn() + Send + Sync>>>,
    callbacks: Mutex<Vec<McpResourceCallback>>,
}

impl Host {
    fn new() -> Self {
        Self {
            connection: Mutex::new(connection(1)),
            registry: Mutex::new(Registry::default()),
            listeners: Mutex::new(Vec::new()),
            callbacks: Mutex::new(Vec::new()),
        }
    }

    fn current(&self) -> McpAppConnection {
        self.connection.lock().unwrap().clone()
    }

    /// A reconnect: the generation moves on, the registry is cleared, and the connection listeners run.
    fn reconnect(&self) {
        let next = connection(self.current().generation + 1);
        *self.connection.lock().unwrap() = next;
        *self.registry.lock().unwrap() = Registry::default();
        let listeners = self.listeners.lock().unwrap().clone();
        for listener in listeners {
            listener();
        }
    }

    /// A resource notice of the server, as the connection task delivers it to the owner's callbacks.
    fn notify(&self, notice: McpResourceNotice) {
        let callbacks = self.callbacks.lock().unwrap().clone();
        for callback in callbacks {
            callback(notice.clone());
        }
    }

    fn subscribers_of(&self, uri: &str) -> Vec<String> {
        self.registry
            .lock()
            .unwrap()
            .by_uri
            .get(uri)
            .map(|keys| keys.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn all_subscribers(&self) -> Vec<String> {
        let mut keys: BTreeSet<String> = BTreeSet::new();
        for set in self.registry.lock().unwrap().by_uri.values() {
            keys.extend(set.iter().cloned());
        }
        keys.into_iter().collect()
    }
}

fn connection(generation: u64) -> McpAppConnection {
    McpAppConnection {
        identity: "id-files".to_owned(),
        generation,
    }
}

#[async_trait]
impl McpAppHost for Host {
    fn owner(&self, _session: &SessionId, server: &str) -> Option<McpAppOwner> {
        (server == "files").then_some(McpAppOwner::Rust)
    }

    fn connection(&self, _session: &SessionId, _server: &str) -> Option<McpAppConnection> {
        Some(self.current())
    }

    async fn wait_connection(
        &self,
        session: &SessionId,
        server: &str,
        _cancel: &CancellationToken,
    ) -> Option<McpAppConnection> {
        self.connection(session, server)
    }

    fn on_connection_changed(
        &self,
        _session: &SessionId,
        _server: &str,
        callback: Arc<dyn Fn() + Send + Sync>,
    ) -> Option<McpAppSubscription> {
        self.listeners.lock().unwrap().push(callback);
        Some(Box::new(()))
    }

    fn tool_visibility(
        &self,
        _session: &SessionId,
        _server: &str,
        _tool: &str,
    ) -> Option<Vec<String>> {
        Some(vec!["app".to_owned()])
    }

    async fn request(
        &self,
        _session: &SessionId,
        _server: &str,
        _expected: &McpAppConnection,
        _method: &str,
        _params: Value,
        _cancel: &CancellationToken,
    ) -> Result<Value, McpAppError> {
        Ok(json!({"content": []}))
    }

    async fn subscribe(
        &self,
        _session: &SessionId,
        _server: &str,
        expected: &McpAppConnection,
        uri: &str,
        subscriber: &str,
        _cancel: &CancellationToken,
    ) -> Result<(), McpAppError> {
        if &self.current() != expected {
            return Err(McpAppError::Changed);
        }
        let mut registry = self.registry.lock().unwrap();
        let keys = registry.by_uri.entry(uri.to_owned()).or_default();
        let first = keys.is_empty();
        keys.insert(subscriber.to_owned());
        if first {
            registry.subscribes += 1;
        }
        Ok(())
    }

    async fn unsubscribe(&self, _session: &SessionId, _server: &str, uri: &str, subscriber: &str) {
        let mut registry = self.registry.lock().unwrap();
        let Some(keys) = registry.by_uri.get_mut(uri) else {
            return;
        };
        if !keys.remove(subscriber) {
            return;
        }
        if keys.is_empty() {
            registry.by_uri.remove(uri);
            registry.unsubscribes += 1;
        }
    }

    fn unsubscribe_prefix(&self, _session: &SessionId, prefix: &str) -> usize {
        let mut registry = self.registry.lock().unwrap();
        let mut emptied = Vec::new();
        for (uri, keys) in registry.by_uri.iter_mut() {
            keys.retain(|key| !key.starts_with(prefix));
            if keys.is_empty() {
                emptied.push(uri.clone());
            }
        }
        for uri in &emptied {
            registry.by_uri.remove(uri);
        }
        registry.unsubscribes += emptied.len();
        emptied.len()
    }

    fn on_resource_notice(
        &self,
        _session: &SessionId,
        _server: &str,
        callback: McpResourceCallback,
    ) -> Option<McpAppSubscription> {
        self.callbacks.lock().unwrap().push(callback);
        Some(Box::new(()))
    }
}

/// Records the `pluginUi.*` deltas the owner sends, in order.
#[derive(Default)]
struct RecordingAnswers {
    deltas: Mutex<Vec<(String, Value)>>,
}

#[async_trait]
impl HelperRequests for RecordingAnswers {
    async fn authorize_app_tool(
        &self,
        _params: Value,
        _cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    async fn sample_model(
        &self,
        _params: Value,
        _cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        Err(RpcError::internal("not used"))
    }

    async fn session_workspace(&self, _session: &str) -> Option<Value> {
        None
    }

    fn session_delta(&self, session: &str, delta: Value) {
        self.deltas
            .lock()
            .unwrap()
            .push((session.to_owned(), delta));
    }
}

/// The sessions whose deltas of `ops` arrived after `mark`, sorted and without repeats.
fn sessions_since(answers: &RecordingAnswers, mark: usize, ops: &[&str]) -> Vec<String> {
    let deltas = answers.deltas.lock().unwrap();
    let mut sessions: BTreeSet<String> = BTreeSet::new();
    for (session, delta) in deltas.iter().skip(mark) {
        if delta["op"].as_str().is_some_and(|op| ops.contains(&op)) {
            sessions.insert(session.clone());
        }
    }
    sessions.into_iter().collect()
}

fn delivered(sessions: &[String]) -> String {
    if sessions.is_empty() {
        "none".to_owned()
    } else {
        sessions.join(",")
    }
}

/// The outcome word of a failed protocol call.
fn classify(error: &RpcError) -> String {
    if error
        .message
        .contains("Invalid MCP App subscription binding")
    {
        "refused:binding".to_owned()
    } else if error.message == "MCP App instance is no longer authorized" {
        "unauthorized".to_owned()
    } else {
        format!("error:{}", error.message)
    }
}

fn lease_named(leases: &BTreeMap<String, (String, Value)>, name: &str) -> (String, Value) {
    leases.get(name).cloned().expect("an opened lease")
}

async fn run(server: &Arc<Server>, host: &Arc<Host>, answers: &RecordingAnswers) -> Vec<String> {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the fixture parses");
    let mut leases: BTreeMap<String, (String, Value)> = BTreeMap::new();
    let mut outcomes = Vec::new();
    for step in fixture["steps"].as_array().expect("steps") {
        let op = step["op"].as_str().expect("op");
        let outcome = match op {
            "openPanel" => {
                let session = step["session"].as_str().expect("session").to_owned();
                call(server, "session/create", automation_create(&session))
                    .await
                    .expect("the session exists");
                let params = json!({
                    "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
                    "sessionId": session,
                    "pluginId": "p",
                    "serverName": "files",
                    "scopeId": step["scope"],
                    "resourceUri": "ui://a",
                    "ownerWebContentsId": 7,
                });
                match server.dispatch("mcp/uiOpenInstance", params).await {
                    Ok(reply) => {
                        leases.insert(
                            step["as"].as_str().expect("as").to_owned(),
                            (session, reply.result),
                        );
                        "opened".to_owned()
                    }
                    Err(error) => classify(&error),
                }
            }
            "subscribe" | "unsubscribe" => {
                let (session, lease) = lease_named(&leases, step["lease"].as_str().expect("lease"));
                let scope_id = step["scopeOverride"]
                    .as_str()
                    .map_or_else(|| lease["token"].clone(), |scope| json!(scope));
                let params = json!({
                    "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
                    "sessionId": session,
                    "pluginId": "p",
                    "serverName": "files",
                    "instance": lease,
                    "scopeId": scope_id,
                    "generation": lease["generation"],
                    "uri": step["uri"],
                });
                let method = if op == "subscribe" {
                    "mcp/uiSubscribeResource"
                } else {
                    "mcp/uiUnsubscribeResource"
                };
                match server.dispatch(method, params).await {
                    Ok(_) if op == "subscribe" => "subscribed".to_owned(),
                    Ok(_) => "unsubscribed".to_owned(),
                    Err(error) => classify(&error),
                }
            }
            "serverRequests" => {
                let registry = host.registry.lock().unwrap();
                format!(
                    "server:subscribe={},unsubscribe={}",
                    registry.subscribes, registry.unsubscribes
                )
            }
            "notifyUpdated" => {
                let uri = step["uri"].as_str().expect("uri").to_owned();
                let mark = answers.deltas.lock().unwrap().len();
                host.notify(McpResourceNotice::Updated {
                    uri: uri.clone(),
                    subscribers: host.subscribers_of(&uri),
                });
                format!(
                    "delivered:{}",
                    delivered(&sessions_since(
                        answers,
                        mark,
                        &["pluginUi.resourceUpdated"]
                    ))
                )
            }
            "notifyListChanged" => {
                let mark = answers.deltas.lock().unwrap().len();
                host.notify(McpResourceNotice::ListChanged {
                    subscribers: host.all_subscribers(),
                });
                format!(
                    "delivered:{}",
                    delivered(&sessions_since(
                        answers,
                        mark,
                        &["pluginUi.resourceListChanged"]
                    ))
                )
            }
            "closePanel" => {
                let (session, lease) = lease_named(&leases, step["lease"].as_str().expect("lease"));
                let params = json!({
                    "workspace": {"workspacePath": "/w", "workspaceKey": "/w"},
                    "sessionId": session,
                    "pluginId": "p",
                    "serverName": "files",
                    "instance": lease,
                });
                match server.dispatch("mcp/uiCloseInstance", params).await {
                    Ok(reply) if reply.result["closed"] == json!(true) => "closed".to_owned(),
                    Ok(_) => "not-closed".to_owned(),
                    Err(error) => classify(&error),
                }
            }
            "reconnect" => {
                let mark = answers.deltas.lock().unwrap().len();
                host.reconnect();
                format!(
                    "revoked:{}",
                    delivered(&sessions_since(answers, mark, &["pluginUi.instanceClosed"]))
                )
            }
            other => format!("unknown op {other}"),
        };
        outcomes.push(outcome);
    }
    outcomes
}

#[tokio::test]
async fn the_rust_owner_matches_the_shared_resource_subscription_fixture() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("the fixture parses");
    let (_scope, server, _kernel) = server();
    let host = Arc::new(Host::new());
    server.context.set_mcp_app_host(host.clone());
    let answers = Arc::new(RecordingAnswers::default());
    let weak: Weak<dyn HelperRequests> = Arc::downgrade(&answers) as _;
    server.context.set_mcp_ui(RustMcpUi::new(weak));

    let outcomes = run(&server, &host, &answers).await;
    let expected: Vec<String> = fixture["steps"]
        .as_array()
        .expect("steps")
        .iter()
        .map(|step| step["expect"].as_str().expect("expect").to_owned())
        .collect();
    assert_eq!(outcomes, expected, "every step's outcome");
}
