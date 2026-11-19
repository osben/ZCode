//! Fork (specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted servers (F7)", PR 4): the resource subscriptions of a
//! server's connection. Port of Node `adapters/src/mcp/resource-subscriptions.ts` (the registry) and the subscribe,
//! unsubscribe and notification paths of `adapters/src/mcp/index.ts`.
//!
//! The registry lives on the server's entry. A new published client clears it, so a reconnect drops every
//! subscription (Node replays them, then the panels that made them are revoked by the same reconnect; the net effect on
//! the server is the same, and no replay is made here). Subscriber keys are `sessionId|scopeId|generation`; a session or
//! a lease ends by its key prefix.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Weak};
use std::time::Duration;

use rust_cli_kernel_api::mcp_app::{
    McpAppConnection, McpAppError, McpResourceCallback, McpResourceNotice,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{Inner, McpManager};

/// A resource notification callback of one server (the owner of the subscriptions it names).
pub(crate) type ResourceListener = McpResourceCallback;

/// Whether the server's capabilities declare `resources.subscribe` (Node `getServerCapabilities()?.resources?.subscribe`).
pub(super) fn resource_subscribes(capabilities: &Value) -> bool {
    capabilities
        .pointer("/resources/subscribe")
        .is_some_and(|value| !value.is_null() && value.as_bool() != Some(false))
}

/// The subscribers of each uri of one server (Node `McpResourceSubscriptionRegistry`, one server's part).
#[derive(Default, Debug)]
pub(crate) struct ResourceSubscriptions {
    by_uri: BTreeMap<String, BTreeSet<String>>,
}

impl ResourceSubscriptions {
    /// Registers `key` for `uri`; `true` when it is the uri's first subscriber (the server must be asked).
    pub(crate) fn add(&mut self, uri: &str, key: &str) -> bool {
        let keys = self.by_uri.entry(uri.to_owned()).or_default();
        let first = keys.is_empty();
        keys.insert(key.to_owned());
        first
    }

    /// Removes `key` from `uri`: `None` when it was not registered, else whether it was the last subscriber.
    pub(crate) fn remove(&mut self, uri: &str, key: &str) -> Option<bool> {
        let keys = self.by_uri.get_mut(uri)?;
        if !keys.remove(key) {
            return None;
        }
        if keys.is_empty() {
            self.by_uri.remove(uri);
            return Some(true);
        }
        Some(false)
    }

    /// Removes every key that starts with `prefix`; returns the uris that lost their last subscriber.
    pub(crate) fn remove_prefix(&mut self, prefix: &str) -> Vec<String> {
        let mut released = Vec::new();
        self.by_uri.retain(|uri, keys| {
            keys.retain(|key| !key.starts_with(prefix));
            if keys.is_empty() {
                released.push(uri.clone());
                false
            } else {
                true
            }
        });
        released
    }

    /// The subscribers of `uri`, in key order.
    pub(crate) fn subscribers(&self, uri: &str) -> Vec<String> {
        self.by_uri
            .get(uri)
            .map(|keys| keys.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Every subscriber of the server, each once, in key order.
    pub(crate) fn all_subscribers(&self) -> Vec<String> {
        let mut all: BTreeSet<String> = BTreeSet::new();
        for keys in self.by_uri.values() {
            all.extend(keys.iter().cloned());
        }
        all.into_iter().collect()
    }

    /// Forgets every subscription (a new published client).
    pub(crate) fn clear(&mut self) {
        self.by_uri.clear();
    }
}

/// The subscription of one resource listener: dropping it removes the listener.
pub(crate) struct ResourceSubscription {
    inner: Weak<Inner>,
    name: String,
    id: u64,
}

impl Drop for ResourceSubscription {
    fn drop(&mut self) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        if let Some(server) = inner.servers().get_mut(&self.name) {
            server.resource_listeners.retain(|(id, _)| *id != self.id);
        }
    }
}

/// Node `McpPort.unsubscribeResource`'s server side: `resources/unsubscribe` on the server's current connection. Failures
/// are logged only (Node does), so no caller waits on the registry's answer.
async fn send_unsubscribe(inner: Arc<Inner>, name: String, uri: String) {
    let (client, timeout) = {
        let servers = inner.servers();
        let Some(server) = servers.get(&name) else {
            return;
        };
        if !server.status.connected() {
            return;
        }
        let Some(client) = server.client.clone() else {
            return;
        };
        let timeout = Duration::from_millis(inner.settings.tool_timeout_for(server.config.options));
        (client, timeout)
    };
    match client
        .request(
            "resources/unsubscribe",
            json!({"uri": uri}),
            timeout,
            &CancellationToken::new(),
        )
        .await
    {
        Ok(_) => tracing::info!(server = %name, %uri, "MCP resource unsubscribed"),
        Err(error) => {
            tracing::warn!(server = %name, %uri, %error, "MCP resource unsubscribe failed");
        }
    }
}

impl Inner {
    /// Node `notifications.ts`'s input: a resource notice of server `name`, to the listeners of that server. Nothing is
    /// delivered when no subscriber is left (Node drops it at the same place). Runs after the servers lock is released.
    pub(super) fn deliver_resource_notice(&self, name: &str, uri: Option<String>) {
        let (notice, listeners) = {
            let servers = self.servers();
            let Some(server) = servers.get(name) else {
                return;
            };
            let subscribers = match &uri {
                Some(uri) => server.resource_subs.subscribers(uri),
                None => server.resource_subs.all_subscribers(),
            };
            if subscribers.is_empty() {
                return;
            }
            let notice = match uri {
                Some(uri) => McpResourceNotice::Updated { uri, subscribers },
                None => McpResourceNotice::ListChanged { subscribers },
            };
            let listeners: Vec<ResourceListener> = server
                .resource_listeners
                .iter()
                .map(|(_, listener)| listener.clone())
                .collect();
            (notice, listeners)
        };
        for listener in listeners {
            listener(notice.clone());
        }
    }
}

impl McpManager {
    /// Node `subscribeResource`: registers `subscriber` for `uri` on server `name`'s connection, which must still be
    /// `expected`. The server is asked only for the uri's first subscriber. `NotSupported` when the server does not
    /// declare `resources.subscribe`; a refused server subscription leaves no subscriber behind.
    pub(crate) async fn app_subscribe(
        &self,
        name: &str,
        expected: &McpAppConnection,
        uri: &str,
        subscriber: &str,
        cancel: &CancellationToken,
    ) -> Result<(), McpAppError> {
        if self.app_connection(name).as_ref() != Some(expected) {
            return Err(McpAppError::Changed);
        }
        let supported = self
            .0
            .servers()
            .get(name)
            .ok_or(McpAppError::Changed)?
            .resources_subscribe;
        if !supported {
            return Err(McpAppError::NotSupported {
                server: name.to_owned(),
                operation: "resources/subscribe".to_owned(),
            });
        }
        let first = self
            .0
            .servers()
            .get_mut(name)
            .ok_or(McpAppError::Changed)?
            .resource_subs
            .add(uri, subscriber);
        if !first {
            return Ok(());
        }
        match self
            .app_request(
                name,
                expected,
                "resources/subscribe",
                json!({"uri": uri}),
                cancel,
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => {
                self.remove_subscriber(name, uri, subscriber);
                Err(error)
            }
        }
    }

    /// Node `unsubscribeResource`: removes `subscriber` for `uri`; the server is unsubscribed when it was the last.
    pub(crate) async fn app_unsubscribe(&self, name: &str, uri: &str, subscriber: &str) {
        if self.remove_subscriber(name, uri, subscriber) == Some(true) {
            send_unsubscribe(self.0.clone(), name.to_owned(), uri.to_owned()).await;
        }
    }

    /// Node `unsubscribeResourcesBySubscriber`: removes every key under `prefix` on every server of this group. Returns
    /// the number of (server, uri) pairs it emptied; their server unsubscribes run in the background.
    pub(crate) fn app_unsubscribe_prefix(&self, prefix: &str) -> usize {
        let released: Vec<(String, String)> = {
            let mut servers = self.0.servers();
            servers
                .iter_mut()
                .flat_map(|(name, server)| {
                    server
                        .resource_subs
                        .remove_prefix(prefix)
                        .into_iter()
                        .map(move |uri| (name.clone(), uri))
                })
                .collect()
        };
        let count = released.len();
        for (name, uri) in released {
            // Detached: the task ends by its own request (the caller does not wait for the server).
            drop(self.0.spawner.spawn(
                "mcp-resource-unsubscribe",
                send_unsubscribe(self.0.clone(), name, uri),
            ));
        }
        count
    }

    /// Calls `callback` on each resource notification of server `name`. `None` when the server is unknown.
    pub(crate) fn on_app_resource_notice(
        &self,
        name: &str,
        callback: ResourceListener,
    ) -> Option<ResourceSubscription> {
        let mut servers = self.0.servers();
        let server = servers.get_mut(name)?;
        server.resource_next_listener += 1;
        let id = server.resource_next_listener;
        server.resource_listeners.push((id, callback));
        Some(ResourceSubscription {
            inner: Arc::downgrade(&self.0),
            name: name.to_owned(),
            id,
        })
    }

    /// Removes `subscriber` for `uri` from server `name`'s registry (see [`ResourceSubscriptions::remove`]).
    fn remove_subscriber(&self, name: &str, uri: &str, subscriber: &str) -> Option<bool> {
        self.0
            .servers()
            .get_mut(name)?
            .resource_subs
            .remove(uri, subscriber)
    }
}

#[cfg(test)]
#[path = "app_resources_tests.rs"]
mod tests;
