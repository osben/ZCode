//! Fork: helper MCP pipes (specs/fork-rust-node-helper.md F3, "Model tools: Rust stays the MCP client, the helper is
//! the pipe"). Rust's MCP client talks to a helper-hosted server over the helper's stdio: `helper/mcp/connect` opens a
//! pipe, `helper/mcp/send` and `helper/mcp/message` carry its JSON-RPC messages, `helper/mcp/closed` and
//! `helper/mcp/close` end it.
//!
//! Owner: a pipe lives in the [`super::Running`] slot of the generation that connected it, so dropping that generation
//! (crash, timeout, reclaim) closes the pipe's event stream; Rust's MCP manager then reconnects, which starts the next
//! generation.

use std::sync::atomic::{AtomicU64, Ordering};

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::mcp::{McpError, McpTransportEvent};
use rust_cli_protocol_core::connection::CONNECTION_CLOSED;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::{NodeHelper, Slot};

pub(super) const CONNECT: &str = "helper/mcp/connect";
const SEND: &str = "helper/mcp/send";
const MESSAGE: &str = "helper/mcp/message";
const CLOSED: &str = "helper/mcp/closed";
const CLOSE: &str = "helper/mcp/close";

/// The helper notifications routed in the read loop ([`super::Relay::control`]).
pub(super) const PIPE_NOTIFICATIONS: &[&str] = &[MESSAGE, CLOSED];

/// Connection ids, unique per Rust process; the prefix routes a connection to the helper.
static NEXT: AtomicU64 = AtomicU64::new(1);
pub const HELPER_CONNECTION_PREFIX: &str = "helper-mcp-";

/// One open helper MCP connection: its id and its event stream (messages in arrival order, then one `Closed`).
#[derive(Debug)]
pub struct HelperMcpConnection {
    pub id: String,
    pub events: mpsc::UnboundedReceiver<McpTransportEvent>,
}

/// Rust's end of a pipe. Dropping it sends the final `Closed` event unless one was sent.
pub(super) struct Pipe {
    sender: mpsc::UnboundedSender<McpTransportEvent>,
    closed: bool,
}

impl Pipe {
    fn close(&mut self, reason: Option<String>) {
        if !self.closed {
            self.closed = true;
            let _ = self.sender.send(McpTransportEvent::Closed {
                reason,
                session_expired: false,
            });
        }
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        self.close(Some("the Node helper exited".to_owned()));
    }
}

fn closed(message: &str) -> McpError {
    McpError::Closed {
        message: message.to_owned(),
    }
}

impl NodeHelper {
    /// Opens a helper MCP connection to `server` (`plugin:<plugin>:<server>`), starting the helper when needed.
    /// `workspace` is `{workspacePath, workspaceIdentity?}`.
    pub async fn mcp_connect(
        &self,
        workspace: &Value,
        server: &str,
    ) -> Result<HelperMcpConnection, McpError> {
        let (generation, peer) = self.acquire_link().await.map_err(|error| McpError::Connect {
            message: error.message,
        })?;
        let _in_flight = super::InFlight {
            helper: self,
            generation,
        };
        let id = format!(
            "{HELPER_CONNECTION_PREFIX}{}",
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, events) = mpsc::unbounded_channel();
        // Registered before the request: the helper may send the first message right after it answers.
        if !self.with_running(generation, |running| {
            running.pipes.insert(
                id.clone(),
                Pipe {
                    sender,
                    closed: false,
                },
            );
        }) {
            return Err(closed("the helper exited"));
        }
        let params = json!({"connection": id, "server": server, "workspace": workspace});
        let answer = tokio::time::timeout(self.timing.request, peer.request(CONNECT, &params)).await;
        let failure = match answer {
            Ok(Ok(_)) => {
                self.heard(generation);
                return Ok(HelperMcpConnection { id, events });
            }
            Ok(Err(error)) if error.code == CONNECTION_CLOSED && peer.is_closed() => {
                self.link_lost(generation);
                "the helper connection closed".to_owned()
            }
            Ok(Err(error)) => {
                self.heard(generation);
                error.message
            }
            Err(_elapsed) => "the helper did not connect the server in time".to_owned(),
        };
        let retired = self.take_pipe(&id);
        drop(retired);
        Err(McpError::Connect { message: failure })
    }

    /// Sends one MCP JSON-RPC message on a helper connection.
    pub async fn mcp_send(&self, connection: &str, message: Value) -> Result<(), McpError> {
        let Some(peer) = self.pipe_peer(connection) else {
            return Err(closed("the helper connection is closed"));
        };
        let params = json!({"connection": connection, "message": message});
        if peer.notify(SEND, &params).await {
            Ok(())
        } else {
            Err(closed("the helper connection is closed"))
        }
    }

    /// Rust closes a helper connection: its stream gets `Closed`, and the helper closes its lease.
    pub async fn mcp_close(&self, connection: &str) {
        let peer = self.pipe_peer(connection);
        let retired = self.take_pipe(connection);
        drop(retired);
        if let Some(peer) = peer {
            peer.notify(CLOSE, &json!({"connection": connection})).await;
        }
    }

    /// Routes `helper/mcp/message` or `helper/mcp/closed` of `generation` to its pipe. Runs in the read loop and does
    /// not block. A message for an unknown pipe (closed meanwhile) is dropped.
    pub(super) fn pipe_event(&self, generation: u64, method: &str, params: &Value) {
        let Some(connection) = params.get("connection").and_then(Value::as_str) else {
            return;
        };
        let mut retired = None;
        {
            let mut state = self.state.lock_unpoisoned();
            let Slot::Running(running) = &mut state.slot else {
                return;
            };
            if running.generation != generation {
                return;
            }
            match method {
                MESSAGE => {
                    if let Some(pipe) = running.pipes.get(connection) {
                        let message = params.get("message").cloned().unwrap_or(Value::Null);
                        let _ = pipe.sender.send(McpTransportEvent::Message { message });
                    }
                }
                _ => {
                    if let Some(mut pipe) = running.pipes.remove(connection) {
                        let reason = params
                            .get("reason")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        pipe.close(reason);
                        retired = Some(pipe);
                    }
                }
            }
        }
        drop(retired);
    }

    fn pipe_peer(&self, connection: &str) -> Option<rust_cli_protocol_core::connection::Peer> {
        match &self.state.lock_unpoisoned().slot {
            Slot::Running(running) if running.pipes.contains_key(connection) => {
                Some(running.peer.clone())
            }
            _ => None,
        }
    }

    #[must_use]
    fn take_pipe(&self, connection: &str) -> Option<Pipe> {
        let mut state = self.state.lock_unpoisoned();
        let Slot::Running(running) = &mut state.slot else {
            return None;
        };
        let pipe = running.pipes.remove(connection);
        if pipe.is_some() {
            running.last_used = tokio::time::Instant::now();
        }
        pipe
    }

    /// Runs `f` on the running slot of `generation`; false when that generation is gone.
    fn with_running(&self, generation: u64, f: impl FnOnce(&mut super::Running)) -> bool {
        let mut state = self.state.lock_unpoisoned();
        match &mut state.slot {
            Slot::Running(running) if running.generation == generation => {
                f(running);
                true
            }
            _ => false,
        }
    }
}
