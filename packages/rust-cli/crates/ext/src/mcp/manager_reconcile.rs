//! Revalidating a connection set in place (the settings lane's `mcp/list` connect, Node
//! `connectConfiguredServers(servers, {revalidate: true})`): a server whose configuration did not change keeps its
//! connection, a connected one is probed with `ping`, a failed one reconnects, and only changed, removed and new
//! servers are started or stopped. The lane no longer closes and respawns every child on each Settings refresh.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::control::reset;
use super::{McpManager, McpServer, McpStatus};
use crate::mcp::retired::is_retired_cua_server;
use crate::mcp::rpc::{Client, RpcError};

/// Node `MCP_PING_TIMEOUT_MS`: the probe waits at most this long, or the server's own timeout when that is shorter.
const PING_TIMEOUT_MS: u64 = 5_000;

/// The work [`McpManager::reconcile`] leaves for after the caller's lock is released: closing the clients of
/// stopped connections and probing the connections it kept.
#[must_use = "the stopped clients stay open until `settle` runs"]
pub struct Reconciled {
    closing: Vec<Arc<Client>>,
    probe: Vec<String>,
}

impl McpManager {
    /// Makes the manager's servers `servers`: a name that is no longer wanted is stopped and forgotten, a changed or
    /// failed one is restarted in place (a new generation, so the old task's late updates are dropped), a new one
    /// starts, and an unchanged one that is connecting, disabled or connected is kept. Synchronous, so a caller that
    /// holds its own lock can order it against other changes; [`Reconciled::settle`] does the awaiting part.
    pub fn reconcile(&self, workspace: WorkspaceRef, servers: Vec<McpServer>) -> Reconciled {
        let servers: Vec<McpServer> = servers
            .into_iter()
            .filter(|server| !is_retired_cua_server(server))
            .collect();
        *self.0.workspace.lock_unpoisoned() = Some(workspace.clone());
        let wanted: BTreeSet<&str> = servers.iter().map(|server| server.name.as_str()).collect();
        let mut closing = Vec::new();
        let mut listeners = Vec::new();
        let mut respawn = Vec::new();
        let mut probe = Vec::new();
        {
            let mut known = self.0.servers();
            let gone: Vec<String> = known
                .keys()
                .filter(|name| !wanted.contains(name.as_str()))
                .cloned()
                .collect();
            for name in gone {
                let Some(server) = known.remove(&name) else {
                    continue;
                };
                server.cancel.cancel();
                if let Some(client) = server.client {
                    closing.push(client);
                    listeners.extend(server.app_listeners.into_iter().map(|(_, l)| l));
                }
            }
            for config in &servers {
                let Some(server) = known.get_mut(&config.name) else {
                    continue;
                };
                let failed = matches!(server.status, McpStatus::Failed { .. });
                if server.config == *config && !failed {
                    if server.status.connected() {
                        probe.push(config.name.clone());
                    }
                    continue;
                }
                let (client, found) = reset(server, McpStatus::CONNECTING);
                closing.extend(client);
                listeners.extend(found);
                server.config = config.clone();
                server.deferred = config.transport == McpTransportConfig::NodeHelper;
                if server.deferred {
                    self.0
                        .deferred
                        .store(true, std::sync::atomic::Ordering::Release);
                } else {
                    respawn.push((config.clone(), server.generation, server.cancel.clone()));
                }
            }
        }
        for listener in listeners {
            listener();
        }
        for (config, generation, cancel) in respawn {
            let task = self
                .0
                .clone()
                .run(workspace.clone(), config, generation, cancel);
            self.0.spawner.spawn_resident("mcp-connection", task);
        }
        // New names start here; the known ones are skipped.
        self.start(workspace, servers);
        self.0.changed.send_modify(|version| *version += 1);
        Reconciled { closing, probe }
    }

    /// Node `pingServer`: a connected server answers `ping`, or answers with a JSON-RPC error (it is alive and does
    /// not support the method). A timeout or a closed connection is dead. Returns the generation of the probed
    /// connection when it is dead; a server that is no longer connected is not a probe's business.
    async fn dead_generation(&self, name: &str) -> Option<u64> {
        let (client, timeout, generation) = {
            let servers = self.0.servers();
            let server = servers.get(name)?;
            let client = server.client.clone()?;
            let own = self.0.settings.connect_timeout_for(server.config.options);
            (
                client,
                Duration::from_millis(own.min(PING_TIMEOUT_MS)),
                server.generation,
            )
        };
        // `request` starts its own timeout after `send`, and an HTTP send reads the response; the outer deadline
        // bounds the whole probe.
        let cancel = CancellationToken::new();
        let ping = client.request("ping", json!({}), timeout, &cancel);
        match tokio::time::timeout(timeout, ping).await {
            Ok(Ok(_) | Err(RpcError::Server { .. })) => None,
            Ok(Err(_)) | Err(_) => Some(generation),
        }
    }
}

impl Reconciled {
    /// Closes the clients of the stopped connections, then probes the kept connected ones (all at once, so a refresh
    /// waits for the slowest probe, not their sum) and restarts the dead. A restart applies only to the connection
    /// that was probed: a newer connect that replaced it meanwhile is left alone.
    pub async fn settle(self, manager: &McpManager) {
        for client in self.closing {
            client.close().await;
        }
        let probes = self.probe.iter().map(|name| async move {
            if let Some(generation) = manager.dead_generation(name).await {
                tracing::info!(server = %name, "reconnecting an MCP server that did not answer ping");
                manager.restart_if(name, Some(generation)).await;
            }
        });
        futures_util::future::join_all(probes).await;
    }
}

#[cfg(test)]
#[path = "manager_reconcile_tests.rs"]
mod tests;
