//! Fork: helper MCP pipes (specs/fork-rust-node-helper.md F3, "Model tools: Rust stays the MCP client, the helper is
//! the pipe"). Rust's MCP client talks to a helper-hosted server over the helper's stdio: `helper/mcp/connect` opens a
//! pipe, `helper/mcp/send` and `helper/mcp/message` carry its JSON-RPC messages, `helper/mcp/closed` and
//! `helper/mcp/close` end it.
//!
//! Each pipe names one workspace (the key of its connect), and a `tools/call` whose session resolves to another key is
//! refused on the pipe before it is sent (F3, "The pipe workspace is enforced"). [`HelperRoutedMcp`] connects one pipe
//! per workspace key, so a session's call always finds its own workspace's pipe — the first calls of a key park in its
//! mailbox while the connect runs as its own task, so the client's send path never waits on a connect (its cancel watch
//! starts only after `send`).
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

/// The workspace (with its key) each session's pipe traffic runs in, oldest first — bounded at [`REMEMBERED_WORKSPACES`]
/// by the same mechanics as the route's recent-maps: a desktop-continuous agent serves sessions without end, so an
/// insert-only cache would grow for the process's life.
#[derive(Default)]
pub(super) struct PipeWorkspaces {
    held: std::collections::HashMap<String, (Value, String)>,
    order: std::collections::VecDeque<String>,
}

impl PipeWorkspaces {
    fn get(&self, session: &str) -> Option<(Value, String)> {
        self.held.get(session).cloned()
    }

    fn insert(&mut self, session: String, workspace: (Value, String)) {
        if self.held.insert(session.clone(), workspace).is_none() {
            self.order.push_back(session);
        }
        while self.order.len() > REMEMBERED_WORKSPACES {
            if let Some(oldest) = self.order.pop_front() {
                self.held.remove(&oldest);
            }
        }
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
    /// carries (F3, "The pipe workspace is enforced"). Cached, oldest evicted at [`REMEMBERED_WORKSPACES`]: a row never
    /// changes workspace, so an evicted entry is only re-resolved, never wrong.
    pub(super) async fn pipe_workspace(&self, session: &str) -> Result<(Value, String), RpcError> {
        if let Some(held) = self.pipe_workspaces.lock_unpoisoned().get(session) {
            return Ok(held);
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
    /// The cooldown's time source (repo rule: take the time from the injected Clock).
    clock: std::sync::Arc<dyn rust_cli_kernel_api::clock::Clock>,
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
        clock: std::sync::Arc<dyn rust_cli_kernel_api::clock::Clock>,
    ) -> Self {
        Self {
            inner,
            helper,
            clock,
            events: std::sync::Mutex::new(std::collections::HashMap::new()),
            routes: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// A session call's pipe decision for a workspace key beyond the own one, under one lock. The message travels the
    /// key's connected pipe ([`ParkedOrPipe::Pipe`]) unless the key's mailbox still holds its traffic draining to that
    /// pipe — then the message parks behind it (opening an empty mailbox starts the connect task,
    /// [`connect_mailbox`]; a mailbox a running task already owns only takes the message, until the key's backlog
    /// reaches [`PARKED_BACKLOG_CAP`], past which the call is refused at once) — or the key is inside its
    /// failed-connect cooldown, in which case the call is refused at once, exactly as the connect gate refuses it.
    /// Parking never waits: `send` must return without awaiting a connect, because Rust's MCP client awaits `send`
    /// before it watches a call's cancel. The mailbox is checked before the connected pipe: the pipe is published
    /// while the mailbox may still be draining, and a message that went direct would overtake what is parked ahead
    /// of it.
    fn park_or_pipe(
        &self,
        route: &std::sync::Arc<Route>,
        key: &str,
        message: &mut Value,
    ) -> ParkedOrPipe {
        let id = message.get("id").cloned();
        let mut state = route.state.lock_unpoisoned();
        if let Some(mailbox) = state.mailbox.get_mut(key) {
            if mailbox.len() >= PARKED_BACKLOG_CAP {
                // The key's connect is still running and its backlog is at the cap: answer the call here
                // instead of parking it — a parked call is answered by its id through `recent`, and a
                // backlog past the cap could evict the very ids it owes (the calls would hang, their
                // `send` already returned Ok).
                drop(state);
                if let Some(id) = id {
                    refused(
                        &route.events,
                        &id,
                        "the workspace's parked backlog is full".to_owned(),
                    );
                }
                return ParkedOrPipe::Refused;
            }
            mailbox.push_back(std::mem::take(message));
            if let Some(id) = &id {
                state.recent.remember(id, key);
            }
            return ParkedOrPipe::Parked { opened: false };
        }
        if let Some(connected) = state.workspaces.get(key).cloned() {
            if let Some(id) = &id {
                state.recent.remember(id, key);
            }
            return ParkedOrPipe::Pipe(connected);
        }
        // Dead under the same lock (as answer_parked): a route whose own pipe closed while the
        // caller awaited the store-row answer answers nothing and opens no mailbox — an answer after
        // the terminal Closed breaks the stream's contract, and a mailbox for a dead route would pay
        // a full connect only to close it again.
        if state.dead {
            return ParkedOrPipe::Dead;
        }
        let now = self.clock.now_ms();
        if let Some((failure, at)) = state.failed.get(key).cloned()
            && now.saturating_sub(at) < FAILED_CONNECT_COOLDOWN_MS
        {
            drop(state);
            if let Some(id) = id {
                refused(&route.events, &id, closed(&failure).to_string());
            }
            return ParkedOrPipe::Refused;
        }
        if let Some(id) = &id {
            state.recent.remember(id, key);
        }
        state.mailbox.insert(
            key.to_owned(),
            std::collections::VecDeque::from([std::mem::take(message)]),
        );
        ParkedOrPipe::Parked { opened: true }
    }
}

/// What [`HelperRoutedMcp::park_or_pipe`] did with a session call of a workspace key beyond the connection's own one.
enum ParkedOrPipe {
    /// The route died while the caller awaited the session's workspace: answer nothing, park nothing.
    Dead,
    /// The key's connected pipe; the message (left with the caller) travels it in `send`.
    Pipe(String),
    /// The message is parked on the key's mailbox until its connect resolves; `opened` when this call started the
    /// connect task (a task that is already running owns the mailbox otherwise).
    Parked { opened: bool },
    /// The key is inside its failed-connect cooldown, or its parked backlog is at [`PARKED_BACKLOG_CAP`]: the call is
    /// answered on the connection in `park_or_pipe`.
    Refused,
}

/// The connection's pipe of `key`, connecting it in `workspace` (the first parked session's store-row workspace of that
/// key) and publishing it on the route. Only the key's connect task runs this — never the send path. One connect at a
/// time per key, so tasks cannot race a connect.
async fn workspace_pipe(
    helper: &NodeHelper,
    clock: &dyn rust_cli_kernel_api::clock::Clock,
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
    // The guard lives in its own block: nothing of it may reach the connect's await below.
    {
        let mut state = route.state.lock_unpoisoned();
        if let Some(connected) = state.workspaces.get(key) {
            return Ok(connected.clone());
        }
        // Fail fast inside the cooldown: a key whose connect keeps failing must not turn every
        // call into a fresh Node-side spawn attempt that pays the whole CONNECT timeout.
        let now = clock.now_ms();
        if let Some((failure, at)) = state.failed.get(key).cloned()
            && now.saturating_sub(at) < FAILED_CONNECT_COOLDOWN_MS
        {
            return Err(closed(&failure));
        }
        state.failed.remove(key);
    }
    let closed = {
        let route = route.clone();
        let key = key.to_owned();
        move |reason: Option<&str>| workspace_closed(&route, &key, reason)
    };
    let pipe = match helper
        .mcp_connect_pipe(
            workspace,
            &route.server,
            route.events.clone(),
            Some(Box::new(closed)),
        )
        .await
    {
        Ok(pipe) => pipe,
        Err(error) => {
            // Remember the failure for the cooldown; the task answers the parked calls with it.
            route
                .state
                .lock_unpoisoned()
                .failed
                .insert(key.to_owned(), (error.to_string(), clock.now_ms()));
            return Err(error);
        }
    };
    if route.state.lock_unpoisoned().dead {
        // The connection closed while this connect ran: its route is gone, so nothing would
        // ever close this pipe. Close it here and fail (the parked calls are answered by the
        // route's terminal Closed, and the connection reconnects if it is opened again).
        let _ = helper.mcp_close(pipe.as_str()).await;
        return Err(McpError::Closed {
            message: "the helper connection is closed".to_owned(),
        });
    }
    route
        .state
        .lock_unpoisoned()
        .workspaces
        .insert(key.to_owned(), pipe.clone());
    Ok(pipe)
}

/// Connects a workspace key's pipe and flushes its mailbox through it, as the key's own task: `send` parks the key's
/// messages and returns, because the client's cancel watch starts only after its `send` — the first call of a key must
/// not hold its cancel behind a connect that may take the whole CONNECT timeout.
/// The mailbox's orphan guard: whatever ends the connect-and-flush task (an error path return, a
/// panic-unwind, or the scope aborting the task at an await) answers the calls still parked in the
/// key's mailbox and removes the entry — without it, a fire-and-forget spawn that never runs (a
/// closed scope) or is aborted mid-`mcp_send` strands the mailbox with no owner, and every later
/// call of the key parks forever behind a task that will never flush it.
struct MailboxGuard {
    route: std::sync::Arc<Route>,
    key: String,
}

impl Drop for MailboxGuard {
    fn drop(&mut self) {
        let (parked, dead) = {
            let mut state = self.route.state.lock_unpoisoned();
            let parked = state
                .mailbox
                .remove(&self.key)
                .map(|queue| queue.into_iter().collect::<Vec<_>>())
                .unwrap_or_default();
            (parked, state.dead)
        };
        if dead {
            return;
        }
        let ids = parked
            .iter()
            .filter(|message| message.get("id").is_some())
            .map(|message| message["id"].clone())
            .collect::<Vec<_>>();
        answer_parked(&self.route, &self.key, "the Node helper exited", ids);
    }
}

async fn connect_mailbox(
    helper: std::sync::Arc<NodeHelper>,
    clock: std::sync::Arc<dyn rust_cli_kernel_api::clock::Clock>,
    route: std::sync::Arc<Route>,
    key: String,
    workspace: Value,
) {
    // Dropped at EVERY exit of this task (including a scope abort at an await): the guard answers
    // what is still parked in the key's mailbox and removes the entry.
    let _orphan = MailboxGuard {
        route: route.clone(),
        key: key.clone(),
    };
    match workspace_pipe(&helper, clock.as_ref(), &route, &workspace, &key).await {
        Ok(pipe) => {
            // The mailbox empties through the pipe in arrival order; a message that arrives mid-flush parks behind
            // what is still there, and the entry goes only under the same lock that finds it empty, so a cancel never
            // overtakes its call, a later message never passes a parked one, and one that races the drain's end parks
            // (the entry is still there) instead of being dropped with it.
            loop {
                let next = {
                    let mut state = route.state.lock_unpoisoned();
                    // The terminal Closed of a dead route already fails every in-flight call: the
                    // drain stops there instead of sending more parked calls past the terminal event.
                    if state.dead {
                        state.mailbox.remove(&key);
                        return;
                    }
                    let next = state
                        .mailbox
                        .get_mut(&key)
                        .and_then(std::collections::VecDeque::pop_front);
                    if next.is_none() {
                        state.mailbox.remove(&key);
                    }
                    next
                };
                let Some(message) = next else {
                    break;
                };
                let id = message.get("id").cloned();
                if let Err(error) = helper.mcp_send(&pipe, message).await {
                    // The pipe closed mid-flush (its close callback answered the ids it still held): answer what is
                    // left — the failed message and the mailbox — and let the next call of the key reconnect.
                    let mut ids = Vec::new();
                    if let Some(id) = id {
                        ids.push(id);
                    }
                    ids.extend(parked_ids(&route, &key));
                    route
                        .state
                        .lock_unpoisoned()
                        .workspaces
                        .retain(|_, held| *held != pipe);
                    answer_parked(&route, &key, &error.to_string(), ids);
                    return;
                }
            }
        }
        Err(error) => {
            answer_parked(&route, &key, &error.to_string(), parked_ids(&route, &key));
        }
    }
}

/// Takes the ids parked in `key`'s mailbox: its connect ended without a pipe for them to travel.
fn parked_ids(route: &std::sync::Arc<Route>, key: &str) -> Vec<Value> {
    route
        .state
        .lock_unpoisoned()
        .mailbox
        .remove(key)
        .map(|mailbox| {
            mailbox
                .into_iter()
                .filter_map(|message| message.get("id").cloned())
                .collect()
        })
        .unwrap_or_default()
}

/// Answers ids a workspace key's connect failed for, or its pipe's flush could not send: each id still routed to `key`
/// in `recent` — nobody answered it yet — is refused on the connection and forgotten, so no later close of the key's
/// next pipe answers it twice. A dead route answers nothing: its terminal `Closed` fails every in-flight call, and an
/// answer after it would break the stream's contract.
fn answer_parked(route: &std::sync::Arc<Route>, key: &str, failure: &str, ids: Vec<Value>) {
    for id in ids {
        let answer = {
            let mut state = route.state.lock_unpoisoned();
            if state.dead {
                false
            } else if state
                .recent
                .key_of(&id.to_string())
                .is_some_and(|held| held == key)
            {
                state.recent.forget(&id);
                true
            } else {
                false
            }
        };
        if answer {
            refused(&route.events, &id, failure.to_owned());
        }
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
    /// A key whose connect failed inside the cooldown, with the failure and when it was recorded:
    /// later calls fail fast instead of re-running the whole connect (a spawn attempt per call).
    failed: std::collections::HashMap<String, (String, u64)>,
    /// One connect at a time per key.
    connecting: std::collections::HashMap<String, std::sync::Arc<tokio::sync::Semaphore>>,
    /// The recent id'd messages that took a workspace pipe, for their cancels and a closed pipe's answers.
    recent: RecentMessages,
    /// Messages parked until their workspace key's connect resolves, in arrival order, at most [`PARKED_BACKLOG_CAP`]
    /// per key (past it the call is refused inline). An entry lives exactly while the key's connect task runs
    /// ([`connect_mailbox`]): its presence is what parks the key's further messages and the cancels of its parked
    /// calls, so a cancel never overtakes the call it cancels.
    mailbox: std::collections::HashMap<String, std::collections::VecDeque<Value>>,
}

/// How many of a connection's recent messages the route remembers, to route a cancel after its call and answer the
/// calls a closed workspace pipe left in flight.
const REMEMBERED_MESSAGES: usize = 1024;

/// How long a failed workspace connect is remembered before a call may retry it. The own pipe's
/// failures go through the MCP manager's reconnect policy; this is the workspace path's equivalent.
const FAILED_CONNECT_COOLDOWN_MS: u64 = 30_000;

/// How many messages one key's mailbox parks while its connect runs. A parked call is answered by
/// its id through the route's `recent` map ([`REMEMBERED_MESSAGES`], shared by every key of the
/// connection), so an unbounded backlog could evict the very ids it owes — a pipelining client's
/// calls would hang, their `send` already returned Ok. The cap keeps one key's backlog far inside
/// that map; the overflow is refused inline instead ([`HelperRoutedMcp::park_or_pipe`]).
pub(super) const PARKED_BACKLOG_CAP: usize = 64;

/// How many sessions' workspaces the pipe-workspace cache keeps, oldest evicted first — the size of the neighboring
/// recent-maps ([`REMEMBERED_CALLS`], [`REMEMBERED_MESSAGES`]): a desktop-continuous agent serves sessions without end,
/// so an insert-only cache would grow for the process's life, and an evicted row is only re-resolved (a row never
/// changes workspace), never wrong.
pub(super) const REMEMBERED_WORKSPACES: usize = 1024;

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

    /// Forgets an id whose call was answered on this side (a closed pipe must not answer it again).
    fn forget(&mut self, id: &Value) {
        let text = id.to_string();
        self.keys.remove(&text);
        self.order.retain(|held| held != &text);
    }

    fn key_of(&self, id: &str) -> Option<String> {
        self.keys.get(id).map(|(_, key)| key.clone())
    }

    /// Takes the ids whose calls went to `key`'s pipe (it closed: they are answered on the connection), except the
    /// ones still parked in `key`'s mailbox — those never traveled the pipe; the key's connect/flush task owns
    /// answering them.
    fn take_ids_of(&mut self, key: &str, except: &std::collections::HashSet<String>) -> Vec<Value> {
        let mut taken = Vec::new();
        self.order.retain(|text| match self.keys.get(text) {
            Some((id, held)) if held == key && !except.contains(text) => {
                taken.push(id.clone());
                false
            }
            _ => true,
        });
        self.keys
            .retain(|text, (_, held)| held != key || except.contains(text));
        taken
    }
}

/// A workspace pipe closed: its in-flight calls are answered on the connection's stream, and the next call of that
/// workspace reconnects. Never ends the connection — only its own pipe's close does. The ids still parked in the key's
/// mailbox are left to the key's connect/flush task — they never traveled the pipe it closed (a failed or abandoned
/// connect drops its never-used pipe here first, and the task answers them with what actually failed).
fn workspace_closed(route: &std::sync::Arc<Route>, key: &str, reason: Option<&str>) {
    let answered = {
        let mut state = route.state.lock_unpoisoned();
        state.workspaces.remove(key);
        // Once dead, the manager fails every in-flight call on the coming Closed: synthesizing
        // more answers after it would break the stream's terminal contract.
        if state.dead {
            Vec::new()
        } else {
            let parked: std::collections::HashSet<String> = state
                .mailbox
                .get(key)
                .map(|mailbox| {
                    mailbox
                        .iter()
                        .filter_map(|message| message.get("id").map(Value::to_string))
                        .collect()
                })
                .unwrap_or_default();
            state.recent.take_ids_of(key, &parked)
        }
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
            return Err(McpError::Closed {
                message: "the helper connection is closed".to_owned(),
            });
        };
        if route.state.lock_unpoisoned().dead {
            return Err(McpError::Closed {
                message: "the helper connection is closed".to_owned(),
            });
        }
        // The pipe the message travels on: a session's call takes its workspace's pipe — parking in that key's
        // mailbox while the pipe's connect runs as its own task, because Rust's MCP client awaits `send` before it
        // watches a call's cancel — a cancel follows its call into its pipe or parks behind it, and everything else
        // (initialize, tools/list, answers to the server's requests) takes the own one. A session whose workspace
        // cannot be resolved keeps the own pipe: its writer refuses the call fail-closed, exactly as its session
        // open does.
        let mut message = message;
        let mut pipe = own.clone();
        let mut workspace_pipe = false;
        if let Some(session) = call_session(&message) {
            if let Ok((held, key)) = self.helper.pipe_workspace(session).await
                && key != route.own_key
            {
                match self.park_or_pipe(&route, &key, &mut message) {
                    ParkedOrPipe::Pipe(connected) => {
                        pipe = connected;
                        workspace_pipe = true;
                    }
                    ParkedOrPipe::Parked { opened: true } => {
                        drop(self.helper.spawner.spawn(
                            "node-helper-workspace-connect",
                            connect_mailbox(
                                self.helper.clone(),
                                self.clock.clone(),
                                route.clone(),
                                key,
                                held,
                            ),
                        ));
                        return Ok(());
                    }
                    // Parked behind the key's in-flight connect (its task flushes the mailbox), refused inline
                    // (the cooldown, or the key's parked backlog at its cap — answered in `park_or_pipe`), or the
                    // route died while the store-row answer ran (the caller's dead-route refusal answers it):
                    // nothing of the call travels in `send`.
                    ParkedOrPipe::Parked { opened: false }
                    | ParkedOrPipe::Refused
                    | ParkedOrPipe::Dead => return Ok(()),
                }
            }
        } else if let Some(cancelled) = cancelled_request(&message) {
            let mut parked = false;
            let followed = {
                let mut state = route.state.lock_unpoisoned();
                match state.recent.key_of(&cancelled) {
                    // The cancelled call is still parked (or just left the mailbox): the cancel parks behind it,
                    // so it never overtakes the call it cancels — the key's flush task sends both, in order.
                    Some(key) => {
                        if let Some(mailbox) = state.mailbox.get_mut(&key) {
                            mailbox.push_back(std::mem::take(&mut message));
                            parked = true;
                            None
                        } else {
                            state.workspaces.get(&key).cloned()
                        }
                    }
                    None => None,
                }
            };
            if parked {
                return Ok(());
            }
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
                    // The call is answered here: forget it, so a later close of that workspace's
                    // pipe does not synthesize a second answer for a resolved id.
                    route.state.lock_unpoisoned().recent.forget(&id);
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
        // Dead before draining: an in-flight workspace connect that lands after the drain sees it
        // and closes its late pipe itself, so no Node-side lease outlives the connection.
        route.state.lock_unpoisoned().dead = true;
        // Workspace pipes first: their close callbacks answer in-flight calls with -32603 events,
        // which must land on the stream BEFORE the own pipe's terminal Closed (the transport
        // contract: after Closed there are no more events).
        let workspace_pipes: Vec<String> = route
            .state
            .lock_unpoisoned()
            .workspaces
            .drain()
            .map(|(_, id)| id)
            .collect();
        for pipe in workspace_pipes {
            self.helper.mcp_close(&pipe).await;
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
