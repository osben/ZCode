//! Fork (specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted servers (F7)", PR 4): the resource subscriptions of a
//! server's connection. Port of Node `adapters/src/mcp/resource-subscriptions.ts` (the registry) and the subscribe,
//! unsubscribe and notification paths of `adapters/src/mcp/index.ts`.
//!
//! The registry lives on the server's entry. A new published client clears it, so a reconnect drops every
//! subscription (Node replays them, then the panels that made them are revoked by the same reconnect; the net effect on
//! the server is the same, and no replay is made here). Subscriber keys are `sessionId|scopeId|generation`; a session or
//! a lease ends by its key prefix.
//!
//! Review (F7 PR 4): the guard (the connection), the capability and the registry add are one critical section. The first
//! subscriber of a uri asks the server, and the others wait for its outcome: a joiner gets the same success or failure,
//! and a failed first request removes every subscriber it gathered. A settle that finds the uri gone or of another
//! request does not touch it. Every unsubscribe the server may need is sent only to the connection it was decided on.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Weak};
use std::time::Duration;

use rust_cli_kernel_api::mcp_app::{
    McpAppConnection, McpAppError, McpResourceCallback, McpResourceNotice,
};
use serde_json::{Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::{Inner, McpManager, Server};

/// A resource notification callback of one server (the owner of the subscriptions it names).
pub(crate) type ResourceListener = McpResourceCallback;

/// Whether the server's capabilities declare `resources.subscribe`, read as Node reads it: a JavaScript truthy value
/// (`{}`, `"yes"` and `true` count; `false`, `0`, `""` and `null` do not).
pub(super) fn resource_subscribes(capabilities: &Value) -> bool {
    capabilities
        .pointer("/resources/subscribe")
        .is_some_and(js_truthy)
}

/// JavaScript truthiness of a JSON value.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The outcome of a uri's first request, as the subscribers waiting on it see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    Pending,
    Subscribed,
    Failed(McpAppError),
}

/// What a subscriber does after [`ResourceSubscriptions::join`].
pub(crate) enum Join {
    /// The uri's first subscriber: it asks the server, then settles the outcome with this ticket.
    Ask(u64),
    /// The server's subscription of the uri is in flight: wait for its outcome.
    Wait(watch::Receiver<Outcome>),
    /// The server has the subscription already.
    Done,
}

enum State {
    /// The first request is in flight (`ticket` names it), and its outcome goes to the waiters on `sender`.
    Pending {
        ticket: u64,
        sender: watch::Sender<Outcome>,
    },
    /// The server holds the subscription.
    Subscribed,
}

struct Entry {
    keys: BTreeSet<String>,
    state: State,
}

/// The result of settling a uri's first request. `release` says the server must be unsubscribed (the caller sends it
/// before the waiters go on, so their next step cannot overtake it). The waiters are woken when this drops.
#[must_use = "dropping the settlement wakes the waiters"]
pub(crate) struct Settlement {
    pub(crate) release: bool,
    waiters: Option<(watch::Sender<Outcome>, Outcome)>,
}

impl Drop for Settlement {
    fn drop(&mut self) {
        if let Some((sender, outcome)) = self.waiters.take() {
            sender.send_replace(outcome);
        }
    }
}

/// The subscribers of each uri of one server (Node `McpResourceSubscriptionRegistry`, one server's part).
#[derive(Default)]
pub(crate) struct ResourceSubscriptions {
    by_uri: BTreeMap<String, Entry>,
    tickets: u64,
}

impl ResourceSubscriptions {
    /// Registers `key` for `uri`. The first subscriber asks the server ([`Join::Ask`]); a subscriber while the request is
    /// in flight waits for its outcome; a later one finds the subscription in place.
    pub(crate) fn join(&mut self, uri: &str, key: &str) -> Join {
        if let Some(entry) = self.by_uri.get_mut(uri) {
            entry.keys.insert(key.to_owned());
            return match &entry.state {
                State::Pending { sender, .. } => Join::Wait(sender.subscribe()),
                State::Subscribed => Join::Done,
            };
        }
        self.tickets += 1;
        let ticket = self.tickets;
        let (sender, _) = watch::channel(Outcome::Pending);
        self.by_uri.insert(
            uri.to_owned(),
            Entry {
                keys: BTreeSet::from([key.to_owned()]),
                state: State::Pending { ticket, sender },
            },
        );
        Join::Ask(ticket)
    }

    /// The outcome of the first request of `uri` (`ticket` from [`Join::Ask`]). Ok keeps the subscription, unless every
    /// subscriber left while the request was in flight: then the server holds a subscription nobody keeps, and the
    /// settlement releases it. Err removes the uri with every subscriber it gathered; the settlement releases the server
    /// when `release_on_failure` says the request may have reached it (a cancel, a timeout, a drop). A ticket that is not
    /// the uri's current one changes nothing.
    pub(crate) fn settle(
        &mut self,
        uri: &str,
        ticket: u64,
        result: Result<(), McpAppError>,
        release_on_failure: bool,
    ) -> Settlement {
        let Some(entry) = self.by_uri.get_mut(uri) else {
            // The uri is gone (its last subscriber left, or a failure removed it): an Ok may still have reached the server.
            return Settlement {
                release: result.is_ok() || release_on_failure,
                waiters: None,
            };
        };
        match &entry.state {
            State::Pending {
                ticket: pending, ..
            } if *pending == ticket => {}
            // Another request settled this uri, or its subscribers are a newer request's: nothing here is ours.
            _ => {
                return Settlement {
                    release: false,
                    waiters: None,
                };
            }
        }
        match result {
            Ok(()) => {
                if entry.keys.is_empty() {
                    self.by_uri.remove(uri);
                    return Settlement {
                        release: true,
                        waiters: None,
                    };
                }
                match std::mem::replace(&mut entry.state, State::Subscribed) {
                    State::Pending { sender, .. } => Settlement {
                        release: false,
                        waiters: Some((sender, Outcome::Subscribed)),
                    },
                    State::Subscribed => Settlement {
                        release: false,
                        waiters: None,
                    },
                }
            }
            Err(error) => {
                let waiters = match self.by_uri.remove(uri) {
                    Some(Entry {
                        state: State::Pending { sender, .. },
                        ..
                    }) => Some((sender, Outcome::Failed(error))),
                    _ => None,
                };
                Settlement {
                    release: release_on_failure,
                    waiters,
                }
            }
        }
    }

    /// Removes `key` from `uri`: `None` when it was not registered. `Some(true)` only when it was the last subscriber of
    /// a uri the server holds (the server must be unsubscribed); a uri still in flight is settled by its request.
    pub(crate) fn remove(&mut self, uri: &str, key: &str) -> Option<bool> {
        let entry = self.by_uri.get_mut(uri)?;
        if !entry.keys.remove(key) {
            return None;
        }
        if !entry.keys.is_empty() {
            return Some(false);
        }
        // A request in flight keeps its entry (review, round 4): its settle decides, and no second request can start
        // while the first one may still land.
        if !matches!(entry.state, State::Subscribed) {
            return Some(false);
        }
        self.by_uri.remove(uri);
        Some(true)
    }

    /// Removes every key that starts with `prefix`; returns the uris the server holds that lost their last subscriber.
    pub(crate) fn remove_prefix(&mut self, prefix: &str) -> Vec<String> {
        let mut released = Vec::new();
        self.by_uri.retain(|uri, entry| {
            entry.keys.retain(|key| !key.starts_with(prefix));
            // A uri with subscribers, or with a request in flight, stays.
            if !entry.keys.is_empty() || !matches!(entry.state, State::Subscribed) {
                return true;
            }
            released.push(uri.clone());
            false
        });
        released
    }

    /// The subscribers of `uri`, in key order.
    pub(crate) fn subscribers(&self, uri: &str) -> Vec<String> {
        self.by_uri
            .get(uri)
            .map(|entry| entry.keys.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Every subscriber of the server, each once, in key order.
    pub(crate) fn all_subscribers(&self) -> Vec<String> {
        let mut all: BTreeSet<String> = BTreeSet::new();
        for entry in self.by_uri.values() {
            all.extend(entry.keys.iter().cloned());
        }
        all.into_iter().collect()
    }

    /// Forgets every subscription (a new published client). Waiters of a request in flight see the sender go.
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

/// Node `McpPort.unsubscribeResource`'s server side: `resources/unsubscribe`, sent only while the server is still on the
/// connection `generation` names (review, round 5: a newer connection has its own subscriptions). Failures are logged
/// only (Node does), so no caller waits on the answer.
async fn send_unsubscribe(inner: Arc<Inner>, name: String, uri: String, generation: u64) {
    let (client, timeout) = {
        let servers = inner.servers();
        let Some(server) = servers.get(&name) else {
            return;
        };
        if server.app_generation != generation || !server.status.connected() {
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

/// Whether `server` is still the connection `expected` names (the generation is unique per published client).
fn connection_is(server: &Server, expected: &McpAppConnection) -> bool {
    server.app_generation == expected.generation
        && server.client.is_some()
        && server.status.connected()
}

/// Waits for a uri's first request to settle: the subscribers that joined it share its outcome. The joiner's own cancel
/// ends its wait (review, round 4): it does not wait for the first request's end.
async fn wait_outcome(
    receiver: &mut watch::Receiver<Outcome>,
    cancel: &CancellationToken,
) -> Result<(), McpAppError> {
    loop {
        let current = receiver.borrow_and_update().clone();
        match current {
            Outcome::Pending => {}
            Outcome::Subscribed => return Ok(()),
            Outcome::Failed(error) => return Err(error),
        }
        tokio::select! {
            () = cancel.cancelled() => return Err(McpAppError::Cancelled),
            // The sender is gone when the registry was cleared (a reconnect): the connection changed under the wait.
            changed = receiver.changed() => {
                if changed.is_err() {
                    return Err(McpAppError::Changed);
                }
            }
        }
    }
}

/// The first subscriber of a uri, while its request is in flight. Dropped before the request answers (the caller went
/// away), it settles the uri as cancelled, so the joiners get an error and the uri is not left pending. The server may
/// have taken the request, so an unsubscribe follows.
struct Asker {
    inner: Arc<Inner>,
    name: String,
    uri: String,
    ticket: u64,
    expected: McpAppConnection,
    armed: bool,
}

impl Drop for Asker {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        settle_asked(
            &self.inner,
            &self.name,
            &self.uri,
            self.ticket,
            &self.expected,
            Err(McpAppError::Cancelled),
            true,
        );
    }
}

/// Settles a uri's first request on the connection it was asked on. A release is sent before the waiters are woken.
fn settle_asked(
    inner: &Arc<Inner>,
    name: &str,
    uri: &str,
    ticket: u64,
    expected: &McpAppConnection,
    result: Result<(), McpAppError>,
    release_on_failure: bool,
) {
    let mut servers = inner.servers();
    let Some(server) = servers.get_mut(name) else {
        return;
    };
    // A changed connection cleared the registry: its waiters already see the change.
    if !connection_is(server, expected) {
        return;
    }
    let settlement = server
        .resource_subs
        .settle(uri, ticket, result, release_on_failure);
    if settlement.release {
        release_on_server(inner, name, uri, expected.generation);
    }
    // `settlement` drops here, after the release is sent: the waiters wake to a server that is already being unsubscribed.
}

/// Sends the server's unsubscribe of `uri` in the background, to the connection `generation` names: nothing waits for the
/// server's reply.
fn release_on_server(inner: &Arc<Inner>, name: &str, uri: &str, generation: u64) {
    // Detached: the task ends by its own request.
    drop(inner.spawner.spawn(
        "mcp-resource-unsubscribe",
        send_unsubscribe(inner.clone(), name.to_owned(), uri.to_owned(), generation),
    ));
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
    /// Node `subscribeResource`, one critical section for the guard, the capability and the registry: `expected` must
    /// still be the server's connection, and the server must declare `resources.subscribe` (else `NotSupported`). The
    /// uri's first subscriber asks the server; the others wait for that outcome and share it. A request that may have
    /// reached the server but did not answer (cancelled, timed out) or was dropped is released.
    pub(crate) async fn app_subscribe(
        &self,
        name: &str,
        expected: &McpAppConnection,
        uri: &str,
        subscriber: &str,
        cancel: &CancellationToken,
    ) -> Result<(), McpAppError> {
        let join = {
            let mut servers = self.0.servers();
            let server = servers.get_mut(name).ok_or(McpAppError::Changed)?;
            if !connection_is(server, expected) {
                return Err(McpAppError::Changed);
            }
            if !server.resources_subscribe {
                return Err(McpAppError::NotSupported {
                    server: name.to_owned(),
                    operation: "resources/subscribe".to_owned(),
                });
            }
            server.resource_subs.join(uri, subscriber)
        };
        match join {
            Join::Done => Ok(()),
            Join::Wait(mut receiver) => {
                let result = wait_outcome(&mut receiver, cancel).await;
                if result.is_err() {
                    // A joiner that leaves drops its own key (review, round 5); a uri that failed has none left.
                    self.app_unsubscribe(name, uri, subscriber).await;
                }
                result
            }
            Join::Ask(ticket) => {
                let mut asker = Asker {
                    inner: self.0.clone(),
                    name: name.to_owned(),
                    uri: uri.to_owned(),
                    ticket,
                    expected: expected.clone(),
                    armed: true,
                };
                let result = self
                    .app_request(
                        name,
                        expected,
                        "resources/subscribe",
                        json!({"uri": uri}),
                        cancel,
                    )
                    .await
                    .map(|_| ());
                // The request answered (or was cancelled, or timed out): the asker settles the uri itself, and a request
                // that may have reached the server is released (review, round 5).
                asker.armed = false;
                let may_have_reached =
                    matches!(result, Err(McpAppError::Cancelled | McpAppError::TimedOut));
                settle_asked(
                    &self.0,
                    name,
                    uri,
                    ticket,
                    expected,
                    result.clone(),
                    may_have_reached,
                );
                result
            }
        }
    }

    /// Node `unsubscribeResource`: removes `subscriber` for `uri`. When it was the last subscriber of a uri the server
    /// holds, the server is unsubscribed in the background (the caller does not wait for the server's reply).
    pub(crate) async fn app_unsubscribe(&self, name: &str, uri: &str, subscriber: &str) {
        let (removed, generation) = self.remove_subscriber(name, uri, subscriber);
        if removed == Some(true) {
            release_on_server(&self.0, name, uri, generation);
        }
    }

    /// Node `unsubscribeResourcesBySubscriber`: removes every key under `prefix` on every server of this group. Returns
    /// the number of (server, uri) pairs it emptied; their server unsubscribes run in the background.
    pub(crate) fn app_unsubscribe_prefix(&self, prefix: &str) -> usize {
        let released: Vec<(String, String, u64)> = {
            let mut servers = self.0.servers();
            servers
                .iter_mut()
                .flat_map(|(name, server)| {
                    let generation = server.app_generation;
                    server
                        .resource_subs
                        .remove_prefix(prefix)
                        .into_iter()
                        .map(move |uri| (name.clone(), uri, generation))
                })
                .collect()
        };
        let count = released.len();
        for (name, uri, generation) in released {
            release_on_server(&self.0, &name, &uri, generation);
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

    /// Removes `subscriber` for `uri` from server `name`'s registry (see [`ResourceSubscriptions::remove`]), and returns
    /// the connection generation the removal was decided on.
    fn remove_subscriber(&self, name: &str, uri: &str, subscriber: &str) -> (Option<bool>, u64) {
        let mut servers = self.0.servers();
        match servers.get_mut(name) {
            Some(server) => (
                server.resource_subs.remove(uri, subscriber),
                server.app_generation,
            ),
            None => (None, 0),
        }
    }
}

#[cfg(test)]
#[path = "app_resources_tests.rs"]
mod tests;
