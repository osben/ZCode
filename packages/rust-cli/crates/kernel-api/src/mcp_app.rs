//! The session-scoped port of the MCP App panels (specs/fork-rust-node-helper.md, "MCP Apps on Rust-hosted servers
//! (F7)"). The protocol's Rust owner of a panel (`protocol-zcode` `fork/mcp_ui_rust.rs`) reads a server's connection
//! through this port; the extension layer, which owns the MCP connections, implements it.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::ids::SessionId;

/// The connection a panel lease is bound to: `identity` hashes the server's launch identity, `generation` counts the
/// server's published clients (Node `appConnectionSnapshot`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpAppConnection {
    pub identity: String,
    pub generation: u64,
}

/// Which runtime owns a server's connection: a plugin-host server is helper-hosted, every other server is Rust-run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpAppOwner {
    Helper,
    Rust,
}

/// A failed guarded request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpAppError {
    /// The call was cancelled (the lease closed, or the panel cancelled it).
    Cancelled,
    TimedOut,
    /// The connection the request was guarded by is no longer the server's current one (Node "MCP App connection
    /// changed").
    Changed,
    /// The server answered with a JSON-RPC error, or the transport failed.
    Failed {
        code: Option<i64>,
        message: String,
    },
}

/// The guard of an invalidation subscription: dropping it unsubscribes.
pub type McpAppSubscription = Box<dyn Send + Sync>;

#[async_trait]
pub trait McpAppHost: Send + Sync {
    /// The owner of `server` in `session`'s MCP table, or `None` when the session has no such server.
    fn owner(&self, session: &SessionId, server: &str) -> Option<McpAppOwner>;

    /// The server's current connection, when it is connected.
    fn connection(&self, session: &SessionId, server: &str) -> Option<McpAppConnection>;

    /// Waits for the named server's connection attempt to settle (Node awaits that server's own `connecting`, not the
    /// group's), then returns its connection. Implementations must bound the wait: it returns at the latest when
    /// `cancel` fires or the server's connect timeout has passed, with `None` when the server is not connected.
    async fn wait_connection(
        &self,
        session: &SessionId,
        server: &str,
        cancel: &CancellationToken,
    ) -> Option<McpAppConnection>;

    /// Calls `callback` whenever the server's connection changes (a reconnect, a stop). `None` when the server is not
    /// in the session's table. The callback runs synchronously on the thread that changed the connection, after the
    /// manager's lock is released: it must neither block nor panic.
    fn on_connection_changed(
        &self,
        session: &SessionId,
        server: &str,
        callback: Arc<dyn Fn() + Send + Sync>,
    ) -> Option<McpAppSubscription>;

    /// The tool's `_meta.ui.visibility` list (empty when it has none). `None` when the server has no such tool.
    fn tool_visibility(&self, session: &SessionId, server: &str, tool: &str)
    -> Option<Vec<String>>;

    /// One request on the server's client, guarded by `expected`: it fails with [`McpAppError::Changed`] when the
    /// connection is no longer `expected` before or after the call. A server that is absent from the session's table
    /// or has no published client also maps to `Changed` (not `Failed`): the lease it serves is revoked.
    async fn request(
        &self,
        session: &SessionId,
        server: &str,
        expected: &McpAppConnection,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, McpAppError>;
}
