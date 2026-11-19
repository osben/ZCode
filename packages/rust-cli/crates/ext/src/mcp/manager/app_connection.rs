//! Fork (specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted servers (F7)", PR 1): the MCP App view of a server's
//! connection. Port of Node `adapters/src/mcp/index.ts` `appConnectionSnapshot`, `nextConnectionGeneration` and the
//! invalidation listeners, plus the guarded request of `callMcpToolForUi` (`appConnection`).
//!
//! The identity hashes the launch identity of the server (platform, executable, workspace, name and configuration).
//! It is hashed, never returned, so credentials in the configuration do not leave the process. The generation counts
//! the server's published-client changes, so a reconnect or a stop moves it on.

use std::collections::BTreeMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::mcp_app::{McpAppConnection, McpAppError};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use super::super::config::McpServer;
use super::super::rpc::RpcError;
use super::{Inner, McpManager};

/// A connection-change callback. It runs after the servers lock is released.
pub(crate) type Listener = Arc<dyn Fn() + Send + Sync>;

/// The subscription of one listener: dropping it removes the listener.
pub(crate) struct AppSubscription {
    inner: Weak<Inner>,
    name: String,
    id: u64,
}

impl Drop for AppSubscription {
    fn drop(&mut self) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        if let Some(server) = inner.servers().get_mut(&self.name) {
            server.app_listeners.retain(|(id, _)| *id != self.id);
        }
    }
}

/// `_meta.ui.visibility` of every tool of a listing (an empty list when the tool declares none).
pub(super) fn visibility_of(listed: &[Value]) -> BTreeMap<String, Vec<String>> {
    listed
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?;
            let visibility = item
                .pointer("/_meta/ui/visibility")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            Some((name.to_owned(), visibility))
        })
        .collect()
}

/// JSON with every object's keys sorted, so the text of a value does not depend on the order its maps were built in
/// (serde_json keeps insertion order here: `preserve_order` is on for the whole workspace).
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let fields: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        Value::Array(items) => {
            let items: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", items.join(","))
        }
        other => other.to_string(),
    }
}

/// The identity of a server's connection: a hash of the platform, the workspace, the server name and its
/// configuration. The transport is hashed in canonical JSON, so equal configurations hash equal whatever order their
/// maps were built in. The rest of the configuration is hashed by its Debug form, which holds no hash-based map.
pub(crate) fn identity_of(workspace: &str, name: &str, config: &McpServer) -> String {
    let transport = serde_json::to_value(&config.transport).unwrap_or(Value::Null);
    let text = format!(
        "{}|{}|{}|{}|{:?}|{:?}|{:?}|{:?}",
        std::env::consts::OS,
        workspace,
        name,
        canonical_json(&transport),
        config.scope,
        config.options,
        config.machine,
        config.oauth,
    );
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
#[path = "app_connection_tests.rs"]
mod tests;

fn map_rpc(error: RpcError) -> McpAppError {
    match error {
        RpcError::Cancelled => McpAppError::Cancelled,
        RpcError::TimedOut => McpAppError::TimedOut,
        other => {
            let message = other.to_string();
            let code = match other {
                RpcError::Server { code, .. } => Some(code),
                _ => None,
            };
            McpAppError::Failed { code, message }
        }
    }
}

impl McpManager {
    /// Whether server `name` is hosted by the Node helper (its transport is `NodeHelper`); `None` when it is unknown.
    pub(crate) fn is_helper_transport(&self, name: &str) -> Option<bool> {
        self.0
            .servers()
            .get(name)
            .map(|server| server.config.transport == McpTransportConfig::NodeHelper)
    }

    /// The connection of server `name`, when it is connected.
    pub(crate) fn app_connection(&self, name: &str) -> Option<McpAppConnection> {
        let workspace = format!("{:?}", self.0.workspace.lock_unpoisoned().clone());
        let servers = self.0.servers();
        let server = servers.get(name)?;
        let client_published = server.client.is_some() && server.status.connected();
        if !client_published {
            return None;
        }
        Some(McpAppConnection {
            identity: identity_of(&workspace, name, &server.config),
            generation: server.app_generation,
        })
    }

    /// Calls `callback` on every connection change of server `name`. `None` when the server is unknown.
    pub(crate) fn on_app_connection_changed(
        &self,
        name: &str,
        callback: Listener,
    ) -> Option<AppSubscription> {
        let mut servers = self.0.servers();
        let server = servers.get_mut(name)?;
        server.app_next_listener += 1;
        let id = server.app_next_listener;
        server.app_listeners.push((id, callback));
        Some(AppSubscription {
            inner: Arc::downgrade(&self.0),
            name: name.to_owned(),
            id,
        })
    }

    /// The `_meta.ui.visibility` of tool `tool` of connected server `name`; `None` when there is no such tool.
    pub(crate) fn tool_visibility(&self, name: &str, tool: &str) -> Option<Vec<String>> {
        let servers = self.0.servers();
        let server = servers
            .get(name)
            .filter(|server| server.status.connected())?;
        server.visibility.get(tool).cloned()
    }

    /// One request on the server's client, guarded by `expected` before and after the call.
    pub(crate) async fn app_request(
        &self,
        name: &str,
        expected: &McpAppConnection,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, McpAppError> {
        let (client, timeout) = {
            let servers = self.0.servers();
            let server = servers.get(name).ok_or(McpAppError::Changed)?;
            let client = server.client.clone().ok_or(McpAppError::Changed)?;
            let timeout =
                Duration::from_millis(self.0.settings.tool_timeout_for(server.config.options));
            (client, timeout)
        };
        if self.app_connection(name).as_ref() != Some(expected) {
            return Err(McpAppError::Changed);
        }
        let value = client
            .request(method, params, timeout, cancel)
            .await
            .map_err(map_rpc)?;
        if self.app_connection(name).as_ref() != Some(expected) {
            return Err(McpAppError::Changed);
        }
        Ok(value)
    }
}
