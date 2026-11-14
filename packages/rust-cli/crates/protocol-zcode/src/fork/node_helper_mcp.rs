//! Fork: helper MCP pipes (specs/fork-rust-node-helper.md F3, "Model tools: Rust stays the MCP client, the helper is
//! the pipe"). Rust's MCP client talks to a helper-hosted server over the helper's stdio: `helper/mcp/connect` opens a
//! pipe, `helper/mcp/send` and `helper/mcp/message` carry its JSON-RPC messages, `helper/mcp/closed` and
//! `helper/mcp/close` end it.
//!
//! Owner: a pipe lives in the [`super::Running`] slot of the generation that connected it, so dropping that generation
//! (crash, timeout, reclaim) closes the pipe's event stream; Rust's MCP manager then reconnects, which starts the next
//! generation.

use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::mcp::{
    McpConnect, McpConnectionId, McpError, McpTransport, McpTransportConfig, McpTransportEvent,
};
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

/// Rust's end of a pipe. Dropping it sends the final `Closed` event unless one was sent, and ends its writer.
pub(super) struct Pipe {
    sender: mpsc::UnboundedSender<McpTransportEvent>,
    /// Rust's messages, in send order, to the pipe's writer task ([`pipe_writer`]).
    outbound: mpsc::UnboundedSender<Value>,
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

/// A helper connection whose connect has not succeeded. Dropped armed, it drops the pipe and sends
/// `helper/mcp/close`, as [`NodeHelper::mcp_close`] does.
struct Abandoned<'a> {
    helper: &'a NodeHelper,
    connection: Option<String>,
    peer: rust_cli_protocol_core::connection::Peer,
}

impl Drop for Abandoned<'_> {
    fn drop(&mut self) {
        let Some(connection) = self.connection.take() else {
            return;
        };
        let retired = self.helper.take_pipe(&connection);
        drop(retired);
        let peer = self.peer.clone();
        drop(
            self.helper
                .spawner
                .spawn("node-helper-pipe-abandoned", async move {
                    peer.notify(CLOSE, &json!({"connection": connection})).await;
                }),
        );
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
        let (generation, peer) = self
            .acquire_link()
            .await
            .map_err(|error| McpError::Connect {
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
        let (outbound, queue) = mpsc::unbounded_channel();
        let writer = pipe_writer(
            self.myself.clone(),
            generation,
            peer.clone(),
            id.clone(),
            queue,
            sender.clone(),
        );
        // Registered before the request: the helper may send the first message right after it answers.
        if !self.with_running(generation, |running| {
            running.pipes.insert(
                id.clone(),
                Pipe {
                    sender,
                    outbound,
                    closed: false,
                },
            );
        }) {
            return Err(closed("the helper exited"));
        }
        // Ends when the pipe is dropped (its `outbound` closes).
        drop(self.spawner.spawn("node-helper-pipe-writer", writer));
        // Until the connect succeeds, a failure, a timeout or a caller dropping this future closes the connection on
        // both sides: the helper may still be connecting, and a late connect would hold its lease and MCP child.
        let mut abandoned = Abandoned {
            helper: self,
            connection: Some(id.clone()),
            peer: peer.clone(),
        };
        let params = json!({"connection": id, "server": server, "workspace": workspace});
        let answer = tokio::time::timeout(
            self.timing.timeout_for(CONNECT),
            peer.request(CONNECT, &params),
        )
        .await;
        let failure = match answer {
            Ok(Ok(_)) => {
                self.heard(generation);
                abandoned.connection = None;
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
        drop(abandoned);
        Err(McpError::Connect { message: failure })
    }

    /// Queues one MCP JSON-RPC message on a helper connection. It does not wait for the helper: Rust's MCP client
    /// awaits `send` before it watches a call's cancel, so a tool call whose session is still opening must not hold
    /// its own cancel back. The pipe's writer sends the messages in order.
    pub async fn mcp_send(&self, connection: &str, message: Value) -> Result<(), McpError> {
        let state = self.state.lock_unpoisoned();
        let queued = match &state.slot {
            Slot::Running(running) => running
                .pipes
                .get(connection)
                .is_some_and(|pipe| pipe.outbound.send(message).is_ok()),
            _ => false,
        };
        drop(state);
        if queued {
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
    pub(super) fn with_running(
        &self,
        generation: u64,
        f: impl FnOnce(&mut super::Running),
    ) -> bool {
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

/// The session a helper tool call runs in (`_meta["zcode/helperContext"].sessionId` of a `tools/call`).
fn call_session(message: &Value) -> Option<&str> {
    if message.get("method").and_then(Value::as_str) != Some("tools/call") {
        return None;
    }
    message
        .pointer("/params/_meta/zcode~1helperContext/sessionId")
        .and_then(Value::as_str)
        .filter(|session| !session.is_empty())
}

/// The request a `notifications/cancelled` cancels (its `params.requestId`, as JSON text).
fn cancelled_request(message: &Value) -> Option<String> {
    if message.get("method").and_then(Value::as_str) != Some("notifications/cancelled") {
        return None;
    }
    message.pointer("/params/requestId").map(Value::to_string)
}

/// How many of a pipe's recent tool calls the writer remembers, to send a cancel after its call.
const REMEMBERED_CALLS: usize = 1024;

/// The sessions of a pipe's recent tool calls by request id (JSON text), oldest first.
#[derive(Default)]
struct CallSessions {
    sessions: std::collections::HashMap<String, String>,
    order: std::collections::VecDeque<String>,
}

impl CallSessions {
    fn remember(&mut self, id: String, session: &str) {
        if self
            .sessions
            .insert(id.clone(), session.to_owned())
            .is_none()
        {
            self.order.push_back(id);
        }
        while self.order.len() > REMEMBERED_CALLS {
            if let Some(oldest) = self.order.pop_front() {
                self.sessions.remove(&oldest);
            }
        }
    }

    fn session_of(&self, id: &str) -> Option<String> {
        self.sessions.get(id).cloned()
    }
}

/// Sends a pipe's messages to the helper. A tool call first opens its session in the generation (F3, "Session open and
/// close"); when the open fails, the call is answered on the pipe with the open's error instead of reaching the
/// helper.
///
/// Each session's calls, and the cancels of those calls, go through that session's lane, in order: a cancel never
/// overtakes its call. Another session's traffic and sessionless messages (`initialize`, `tools/list`, answers to the
/// server's requests) do not wait on a session's open, which may take the open's full timeout.
async fn pipe_writer(
    helper: std::sync::Weak<NodeHelper>,
    generation: u64,
    peer: rust_cli_protocol_core::connection::Peer,
    connection: String,
    mut queue: mpsc::UnboundedReceiver<Value>,
    events: mpsc::UnboundedSender<McpTransportEvent>,
) {
    let mut lanes: std::collections::HashMap<String, mpsc::UnboundedSender<Value>> =
        std::collections::HashMap::new();
    let mut running = futures_util::stream::FuturesUnordered::new();
    let mut calls = CallSessions::default();
    let link = PipeLink {
        helper,
        generation,
        peer,
        connection,
        events,
    };
    loop {
        // Lanes first: a call of an open session goes out before the next queued message, as one FIFO writer would.
        let message = tokio::select! {
            biased;
            Some(()) = running.next(), if !running.is_empty() => continue,
            message = queue.recv() => message,
        };
        let Some(message) = message else {
            break;
        };
        let session = match call_session(&message) {
            Some(session) => {
                if let Some(id) = message.get("id") {
                    calls.remember(id.to_string(), session);
                }
                Some(session.to_owned())
            }
            None => cancelled_request(&message).and_then(|id| calls.session_of(&id)),
        };
        let Some(session) = session else {
            if !link.send(message).await {
                return;
            }
            continue;
        };
        let lane = lanes.entry(session.clone()).or_insert_with(|| {
            let (sender, receiver) = mpsc::unbounded_channel();
            running.push(link.clone().lane(session, receiver));
            sender
        });
        if lane.send(message).is_err() {
            // The lane ended: the helper link is gone.
            return;
        }
    }
    // The pipe was dropped: the lanes send what they hold, then end.
    drop(lanes);
    while running.next().await.is_some() {}
}

/// What a pipe's writer and its session lanes need to reach the helper.
#[derive(Clone)]
struct PipeLink {
    helper: std::sync::Weak<NodeHelper>,
    generation: u64,
    peer: rust_cli_protocol_core::connection::Peer,
    connection: String,
    events: mpsc::UnboundedSender<McpTransportEvent>,
}

impl PipeLink {
    async fn send(&self, message: Value) -> bool {
        let params = json!({"connection": self.connection, "message": message});
        self.peer.notify(SEND, &params).await
    }

    /// One session's messages, in order: each tool call waits for the session's open.
    async fn lane(self, session: String, mut queue: mpsc::UnboundedReceiver<Value>) {
        while let Some(message) = queue.recv().await {
            if call_session(&message).is_some() {
                let Some(owner) = self.helper.upgrade() else {
                    return;
                };
                let opened = owner
                    .ensure_session(self.generation, &self.peer, &session)
                    .await;
                drop(owner);
                if let Err(error) = opened {
                    if let Some(id) = message.get("id") {
                        let answer = json!({"jsonrpc": "2.0", "id": id,
                            "error": {"code": -32603, "message": error.message}});
                        let _ = self
                            .events
                            .send(McpTransportEvent::Message { message: answer });
                    }
                    continue;
                }
            }
            if !self.send(message).await {
                return;
            }
        }
    }
}

/// The process's MCP transport with a Node helper configured: [`McpTransportConfig::NodeHelper`] servers connect
/// through the helper, every other server through `inner`. Connection ids with [`HELPER_CONNECTION_PREFIX`] belong to
/// the helper.
pub struct HelperRoutedMcp {
    inner: std::sync::Arc<dyn McpTransport>,
    helper: std::sync::Arc<NodeHelper>,
    /// Event streams of helper connections not yet taken (`events` is taken once).
    events: std::sync::Mutex<
        std::collections::HashMap<String, mpsc::UnboundedReceiver<McpTransportEvent>>,
    >,
}

impl HelperRoutedMcp {
    pub fn new(
        inner: std::sync::Arc<dyn McpTransport>,
        helper: std::sync::Arc<NodeHelper>,
    ) -> Self {
        Self {
            inner,
            helper,
            events: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

fn is_helper(connection: &McpConnectionId) -> bool {
    connection.as_str().starts_with(HELPER_CONNECTION_PREFIX)
}

/// The workspace a pipe connects in: the one Rust's MCP manager runs in, keyed by its root
/// (`workspaceIdentity?.trim() || workspacePath`). A helper session opens with its own row's workspace instead
/// (F3 "Session open and close"); in the Host's shared local task runtime the two differ.
pub(crate) fn helper_workspace(workspace: &WorkspaceRef) -> Value {
    json!({"workspacePath": workspace.root.as_str()})
}

#[async_trait::async_trait]
impl McpTransport for HelperRoutedMcp {
    async fn connect(
        &self,
        workspace: &WorkspaceRef,
        request: McpConnect,
    ) -> Result<McpConnectionId, McpError> {
        if request.transport != McpTransportConfig::NodeHelper {
            return self.inner.connect(workspace, request).await;
        }
        let connection = self
            .helper
            .mcp_connect(&helper_workspace(workspace), &request.server)
            .await?;
        self.events
            .lock_unpoisoned()
            .insert(connection.id.clone(), connection.events);
        Ok(McpConnectionId::new(connection.id))
    }

    async fn send(&self, connection: &McpConnectionId, message: Value) -> Result<(), McpError> {
        if is_helper(connection) {
            self.helper.mcp_send(connection.as_str(), message).await
        } else {
            self.inner.send(connection, message).await
        }
    }

    fn events(&self, connection: &McpConnectionId) -> BoxStream<'static, McpTransportEvent> {
        if !is_helper(connection) {
            return self.inner.events(connection);
        }
        match self.events.lock_unpoisoned().remove(connection.as_str()) {
            Some(events) => tokio_stream_from(events),
            None => futures_util::stream::empty().boxed(),
        }
    }

    async fn close(&self, connection: &McpConnectionId) -> Result<(), McpError> {
        if !is_helper(connection) {
            return self.inner.close(connection).await;
        }
        self.helper.mcp_close(connection.as_str()).await;
        Ok(())
    }
}

fn tokio_stream_from(
    mut events: mpsc::UnboundedReceiver<McpTransportEvent>,
) -> BoxStream<'static, McpTransportEvent> {
    futures_util::stream::poll_fn(move |context| events.poll_recv(context)).boxed()
}
