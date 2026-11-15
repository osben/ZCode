//! Fork: helper MCP pipes (specs/fork-rust-node-helper.md F3, "Model tools: Rust stays the MCP client, the helper is
//! the pipe"). Rust's MCP client talks to a helper-hosted server over the helper's stdio: `helper/mcp/connect` opens a
//! pipe, `helper/mcp/send` and `helper/mcp/message` carry its JSON-RPC messages, `helper/mcp/closed` and
//! `helper/mcp/close` end it.
//!
//! Each pipe names one workspace (the key of its connect), and a `tools/call` whose session resolves to another key is
//! refused on the pipe before it is sent (F3, "The pipe workspace is enforced"). [`HelperRoutedMcp`] connects one pipe
//! per workspace key, so a session's call always finds its own workspace's pipe.
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
use rust_cli_protocol_core::rpc::RpcError;
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

/// Reports a pipe's close with its reason: a workspace pipe of a routed connection runs one instead of ending its
/// connection's stream.
type CloseReport = Box<dyn Fn(Option<&str>) + Send>;

/// Rust's end of a pipe. Dropping it sends the final `Closed` event unless one was sent, and ends its writer.
pub(super) struct Pipe {
    sender: mpsc::UnboundedSender<McpTransportEvent>,
    /// Rust's messages, in send order, to the pipe's writer task ([`pipe_writer`]).
    outbound: mpsc::UnboundedSender<Value>,
    closed: bool,
    /// A per-workspace pipe of a routed connection ([`HelperRoutedMcp`]): its close reports to the route instead of
    /// ending the connection's stream.
    on_closed: Option<CloseReport>,
}

impl Pipe {
    fn close(&mut self, reason: Option<String>) {
        if !self.closed {
            self.closed = true;
            match self.on_closed.take() {
                // A workspace pipe never ends its connection: its own in-flight calls are answered on the
                // connection's stream instead, and the next call of that workspace reconnects.
                Some(report) => report(reason.as_deref()),
                None => {
                    let _ = self.sender.send(McpTransportEvent::Closed {
                        reason,
                        session_expired: false,
                    });
                }
            }
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

/// The key of a helper workspace, as the helper's `workspaceKeyOf` derives it (`workspaceIdentity?.trim() ||
/// workspacePath`): both sides of the pipe-workspace refusal compare these, so Rust must not normalize paths here.
pub(super) fn workspace_key_of(workspace: &Value) -> String {
    workspace
        .get("workspaceIdentity")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|identity| !identity.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            workspace
                .get("workspacePath")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

impl NodeHelper {
    /// Opens a helper MCP connection to `server` (`plugin:<plugin>:<server>`), starting the helper when needed.
    /// `workspace` is `{workspacePath, workspaceIdentity?}`.
    pub async fn mcp_connect(
        &self,
        workspace: &Value,
        server: &str,
    ) -> Result<HelperMcpConnection, McpError> {
        let (sender, events) = mpsc::unbounded_channel();
        let id = self
            .mcp_connect_pipe(workspace, server, sender, None)
            .await?;
        Ok(HelperMcpConnection { id, events })
    }

    /// [`NodeHelper::mcp_connect`] with the event stream supplied by the caller: a pipe of a routed connection
    /// ([`HelperRoutedMcp`]) reports into its connection's stream, and `on_closed` (a workspace pipe) runs instead of
    /// sending `Closed` into it.
    pub(super) async fn mcp_connect_pipe(
        &self,
        workspace: &Value,
        server: &str,
        events: mpsc::UnboundedSender<McpTransportEvent>,
        on_closed: Option<CloseReport>,
    ) -> Result<String, McpError> {
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
        let (outbound, queue) = mpsc::unbounded_channel();
        let writer = pipe_writer(
            self.myself.clone(),
            generation,
            peer.clone(),
            id.clone(),
            workspace_key_of(workspace),
            queue,
            events.clone(),
        );
        // Registered before the request: the helper may send the first message right after it answers.
        if !self.with_running(generation, |running| {
            running.pipes.insert(
                id.clone(),
                Pipe {
                    sender: events,
                    outbound,
                    closed: false,
                    on_closed,
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
                return Ok(id);
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

    /// The workspace a session's pipe traffic runs in, as its store row holds it, with its key — the same
    /// authoritative resolution `helper/session/open` uses, so a pipe connected with it always matches the session it
    /// carries (F3, "The pipe workspace is enforced"). Cached for the process's life: a row never changes workspace.
    pub(super) async fn pipe_workspace(&self, session: &str) -> Result<(Value, String), RpcError> {
        if let Some(held) = self.pipe_workspaces.lock_unpoisoned().get(session) {
            return Ok(held.clone());
        }
        let Some(answers) = self.answers() else {
            return Err(super::unavailable(
                "the agent does not answer helper requests yet",
            ));
        };
        let Some(workspace) = answers.session_workspace(session).await else {
            return Err(super::unavailable("the session's workspace is unknown"));
        };
        let held = (workspace.clone(), workspace_key_of(&workspace));
        self.pipe_workspaces
            .lock_unpoisoned()
            .insert(session.to_owned(), held.clone());
        Ok(held)
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

/// Sends a pipe's messages to the helper. A tool call first passes the pipe-workspace refusal and opens its session in
/// the generation (F3, "Session open and close"); when either fails, the call is answered on the pipe with the error
/// instead of reaching the helper.
///
/// Each session's calls, and the cancels of those calls, go through that session's lane, in order: a cancel never
/// overtakes its call. Another session's traffic and sessionless messages (`initialize`, `tools/list`, answers to the
/// server's requests) do not wait on a session's open, which may take the open's full timeout.
async fn pipe_writer(
    helper: std::sync::Weak<NodeHelper>,
    generation: u64,
    peer: rust_cli_protocol_core::connection::Peer,
    connection: String,
    workspace_key: String,
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
        workspace_key,
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
    /// This pipe's workspace key: the refusal below compares it with the calling session's.
    workspace_key: String,
    events: mpsc::UnboundedSender<McpTransportEvent>,
}

impl PipeLink {
    async fn send(&self, message: Value) -> bool {
        let params = json!({"connection": self.connection, "message": message});
        self.peer.notify(SEND, &params).await
    }

    /// Answers a message on the pipe's connection (`-32603`, as a failed session open answers a call).
    fn refuse(&self, id: &Value, message: String) {
        let answer = json!({"jsonrpc": "2.0", "id": id,
            "error": {"code": -32603, "message": message}});
        let _ = self
            .events
            .send(McpTransportEvent::Message { message: answer });
    }

    /// One session's messages, in order: each tool call passes the pipe-workspace refusal and waits for the session's
    /// open.
    async fn lane(self, session: String, mut queue: mpsc::UnboundedReceiver<Value>) {
        while let Some(message) = queue.recv().await {
            if call_session(&message).is_some() {
                let Some(owner) = self.helper.upgrade() else {
                    return;
                };
                // The pipe-workspace refusal (F3): a pipe carries only its own workspace's sessions. The session's key
                // resolves through its store row — the same resolution the session open uses — so an unresolvable
                // workspace fails closed, exactly as the open does.
                let admitted = match owner.pipe_workspace(&session).await {
                    Ok((_, key)) if key == self.workspace_key => Ok(()),
                    Ok((_, _)) => Err(
                        "the session is in another workspace than the MCP connection".to_owned(),
                    ),
                    Err(error) => Err(error.message),
                };
                let opened = match admitted {
                    Ok(()) => owner
                        .ensure_session(self.generation, &self.peer, &session)
                        .await
                        .map_err(|error| error.message),
                    Err(failure) => Err(failure),
                };
                drop(owner);
                if let Err(failure) = opened {
                    if let Some(id) = message.get("id") {
                        self.refuse(id, failure);
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
///
/// A helper-hosted connection carries one pipe per workspace key (F3, "The pipe workspace is enforced"): its own pipe,
/// connected in the manager group's workspace, serves the sessionless traffic (`initialize`, `tools/list`, `ping`) and
/// the sessions of that key; each further key gets its pipe on the first call of one of its sessions, connected with
/// that session's store-row workspace. All pipes of a connection report into one event stream, so Rust's MCP client
/// keeps seeing one connection, and pipes of different workspace keys never share.
pub struct HelperRoutedMcp {
    inner: std::sync::Arc<dyn McpTransport>,
    helper: std::sync::Arc<NodeHelper>,
    /// Event streams of helper connections not yet taken (`events` is taken once).
    events: std::sync::Mutex<
        std::collections::HashMap<String, mpsc::UnboundedReceiver<McpTransportEvent>>,
    >,
    /// One entry per helper connection this transport opened, keyed by the connection id (its own pipe's id).
    routes: std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<Route>>>,
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
            routes: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// The connection's pipe of `key`, connecting it on first use in `workspace` (the first session's store-row
    /// workspace of that key). One connect at a time per key, so concurrent first calls share it.
    async fn workspace_pipe(
        &self,
        route: &std::sync::Arc<Route>,
        workspace: &Value,
        key: &str,
    ) -> Result<String, McpError> {
        let gate = route
            .state
            .lock_unpoisoned()
            .connecting
            .entry(key.to_owned())
            .or_insert_with(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)))
            .clone();
        // A permit, not a lock guard: it travels across the connect's awaits.
        let _one_at_a_time = gate.clone().acquire_owned().await.ok();
        if let Some(connected) = route.state.lock_unpoisoned().workspaces.get(key) {
            return Ok(connected.clone());
        }
        let closed = {
            let route = route.clone();
            let key = key.to_owned();
            move |reason: Option<&str>| workspace_closed(&route, &key, reason)
        };
        let pipe = self
            .helper
            .mcp_connect_pipe(
                workspace,
                &route.server,
                route.events.clone(),
                Some(Box::new(closed)),
            )
            .await?;
        route
            .state
            .lock_unpoisoned()
            .workspaces
            .insert(key.to_owned(), pipe.clone());
        Ok(pipe)
    }
}

/// One helper-hosted connection's pipes (F3, "The pipe workspace is enforced"): its own, in its manager group's
/// workspace, plus one per further workspace key its sessions' calls connected on demand.
struct Route {
    server: String,
    /// The connection's single event stream: every pipe's messages and every synthesized answer reach it, so Rust's
    /// MCP client correlates one connection.
    events: mpsc::UnboundedSender<McpTransportEvent>,
    /// The own pipe's workspace key: the sessions of every other key take their own pipe.
    own_key: String,
    state: std::sync::Mutex<RouteState>,
}

/// The mutable half of a [`Route`]; never held across an await or a helper call.
#[derive(Default)]
struct RouteState {
    /// The own pipe closed (the helper exited, or a close took it): every send fails closed.
    dead: bool,
    /// The connected pipe of each workspace key beyond the own one.
    workspaces: std::collections::HashMap<String, String>,
    /// One connect at a time per key.
    connecting: std::collections::HashMap<String, std::sync::Arc<tokio::sync::Semaphore>>,
    /// The recent id'd messages that took a workspace pipe, for their cancels and a closed pipe's answers.
    recent: RecentMessages,
}

/// How many of a connection's recent messages the route remembers, to route a cancel after its call and answer the
/// calls a closed workspace pipe left in flight.
const REMEMBERED_MESSAGES: usize = 1024;

/// The workspace key each recent id'd message went to, oldest first. Keyed by the id as JSON text, the shape of a
/// `notifications/cancelled` `requestId`.
#[derive(Default)]
struct RecentMessages {
    keys: std::collections::HashMap<String, (Value, String)>,
    order: std::collections::VecDeque<String>,
}

impl RecentMessages {
    fn remember(&mut self, id: &Value, key: &str) {
        let text = id.to_string();
        if self
            .keys
            .insert(text.clone(), (id.clone(), key.to_owned()))
            .is_none()
        {
            self.order.push_back(text);
        }
        while self.order.len() > REMEMBERED_MESSAGES {
            if let Some(oldest) = self.order.pop_front() {
                self.keys.remove(&oldest);
            }
        }
    }

    fn key_of(&self, id: &str) -> Option<String> {
        self.keys.get(id).map(|(_, key)| key.clone())
    }

    /// Takes the ids whose calls went to `key`'s pipe (it closed: they are answered on the connection).
    fn take_ids_of(&mut self, key: &str) -> Vec<Value> {
        let mut taken = Vec::new();
        self.order.retain(|text| match self.keys.get(text) {
            Some((id, held)) if held == key => {
                taken.push(id.clone());
                false
            }
            _ => true,
        });
        self.keys.retain(|_, (_, held)| held != key);
        taken
    }
}

/// A workspace pipe closed: its in-flight calls are answered on the connection's stream, and the next call of that
/// workspace reconnects. Never ends the connection — only its own pipe's close does.
fn workspace_closed(route: &std::sync::Arc<Route>, key: &str, reason: Option<&str>) {
    let answered = {
        let mut state = route.state.lock_unpoisoned();
        state.workspaces.remove(key);
        state.recent.take_ids_of(key)
    };
    for id in answered {
        let message = json!({"jsonrpc": "2.0", "id": id,
            "error": {"code": -32603, "message": format!("connection closed: {}",
                reason.unwrap_or("the Node helper exited"))}});
        let _ = route.events.send(McpTransportEvent::Message { message });
    }
}

/// The connection's own pipe closed (the helper exited, a timeout or a close took it): the connection is gone, and
/// Rust's MCP manager reconnects, which starts the next helper generation.
fn own_closed(route: &std::sync::Arc<Route>, reason: Option<&str>) {
    route.state.lock_unpoisoned().dead = true;
    let _ = route.events.send(McpTransportEvent::Closed {
        reason: reason.map(str::to_owned),
        session_expired: false,
    });
}

/// Answers one of the connection's messages with an error (`-32603`, the code the pipe writer refuses a call with).
fn refused(events: &mpsc::UnboundedSender<McpTransportEvent>, id: &Value, failure: String) {
    let answer = json!({"jsonrpc": "2.0", "id": id,
        "error": {"code": -32603, "message": failure}});
    let _ = events.send(McpTransportEvent::Message { message: answer });
}

fn is_helper(connection: &McpConnectionId) -> bool {
    connection.as_str().starts_with(HELPER_CONNECTION_PREFIX)
}

/// The workspace a connection's own pipe connects in: the one its Rust MCP manager group runs in, keyed by its root
/// (`workspaceIdentity?.trim() || workspacePath`). Only the sessionless traffic and the group's own sessions travel it;
/// every other session's calls take a pipe of its row's workspace (F3, "The pipe workspace is enforced").
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
        let group = helper_workspace(workspace);
        let (sender, events) = mpsc::unbounded_channel();
        let route = std::sync::Arc::new(Route {
            server: request.server.clone(),
            events: sender,
            own_key: workspace_key_of(&group),
            state: std::sync::Mutex::default(),
        });
        let closed = {
            let route = route.clone();
            move |reason: Option<&str>| own_closed(&route, reason)
        };
        let id = self
            .helper
            .mcp_connect_pipe(
                &group,
                &request.server,
                route.events.clone(),
                Some(Box::new(closed)),
            )
            .await?;
        self.events.lock_unpoisoned().insert(id.clone(), events);
        self.routes.lock_unpoisoned().insert(id.clone(), route);
        Ok(McpConnectionId::new(id))
    }

    async fn send(&self, connection: &McpConnectionId, message: Value) -> Result<(), McpError> {
        if !is_helper(connection) {
            return self.inner.send(connection, message).await;
        }
        let own = connection.as_str().to_owned();
        let Some(route) = self.routes.lock_unpoisoned().get(&own).cloned() else {
            return Err(closed("the helper connection is closed"));
        };
        if route.state.lock_unpoisoned().dead {
            return Err(closed("the helper connection is closed"));
        }
        // The pipe the message travels on: a session's call takes its workspace's pipe, a cancel follows its call,
        // everything else (initialize, tools/list, answers to the server's requests) takes the own one. A session
        // whose workspace cannot be resolved keeps the own pipe: its writer refuses the call fail-closed, exactly as
        // its session open does.
        let mut pipe = own.clone();
        let mut workspace_pipe = false;
        if let Some(session) = call_session(&message) {
            if let Ok((held, key)) = self.helper.pipe_workspace(session).await
                && key != route.own_key
            {
                match self.workspace_pipe(&route, &held, &key).await {
                    Ok(connected) => {
                        if let Some(id) = message.get("id") {
                            route.state.lock_unpoisoned().recent.remember(id, &key);
                        }
                        pipe = connected;
                        workspace_pipe = true;
                    }
                    // The workspace's server never connected (it is not a helper plugin server there): the call is
                    // answered on the connection instead of crossing in another workspace's pipe.
                    Err(error) => {
                        if let Some(id) = message.get("id") {
                            refused(&route.events, id, error.to_string());
                        }
                        return Ok(());
                    }
                }
            }
        } else if let Some(cancelled) = cancelled_request(&message) {
            let followed = {
                let state = route.state.lock_unpoisoned();
                state
                    .recent
                    .key_of(&cancelled)
                    .and_then(|key| state.workspaces.get(&key).cloned())
            };
            if let Some(connected) = followed {
                pipe = connected;
                workspace_pipe = true;
            }
        }
        let id = message.get("id").cloned();
        match self.helper.mcp_send(&pipe, message).await {
            // A workspace pipe closed between its callback and this send: the call is answered, and the next call of
            // its workspace reconnects. The own pipe's failure is the connection's own, as before.
            Err(error) if workspace_pipe => {
                route
                    .state
                    .lock_unpoisoned()
                    .workspaces
                    .retain(|_, held| *held != pipe);
                if let Some(id) = id {
                    refused(&route.events, &id, error.to_string());
                }
                Ok(())
            }
            result => result,
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
        let route = self.routes.lock_unpoisoned().remove(connection.as_str());
        let Some(route) = route else {
            self.helper.mcp_close(connection.as_str()).await;
            return Ok(());
        };
        let mut pipes = vec![connection.as_str().to_owned()];
        pipes.extend(
            route
                .state
                .lock_unpoisoned()
                .workspaces
                .drain()
                .map(|(_, id)| id),
        );
        for pipe in pipes {
            self.helper.mcp_close(&pipe).await;
        }
        Ok(())
    }
}

fn tokio_stream_from(
    mut events: mpsc::UnboundedReceiver<McpTransportEvent>,
) -> BoxStream<'static, McpTransportEvent> {
    futures_util::stream::poll_fn(move |context| events.poll_recv(context)).boxed()
}
