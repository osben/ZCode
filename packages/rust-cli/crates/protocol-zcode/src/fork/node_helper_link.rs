//! Fork: the helper connection's own pieces (specs/fork-rust-node-helper.md "Helper connection"): the writer release
//! that lets a retired helper see EOF, the count of what the process sent, and the relay that forwards its allowlisted
//! notifications to the Host.

use super::*;

/// Releases the helper's stdin when the process is retired. The protocol writer task owns the write half and only
/// ends once every `Peer` clone is gone, and the reader task keeps one until the helper's stdout closes, which is
/// after the helper exits. Without this, a retired helper never sees EOF, so its F4a stop grace always expires.
pub(super) struct WriterRelease {
    pub(super) writer: Task<()>,
    /// Dropped after `writer` is aborted, so the process guard's stop starts once stdin is closed.
    pub(super) _process: Box<dyn Send>,
}

impl Drop for WriterRelease {
    fn drop(&mut self) {
        // Aborting the writer drops the write half (EOF for the helper). The process guard drops after this, so
        // its stop task starts with the helper already told to shut down.
        self.writer.abort();
    }
}

impl NodeHelper {
    /// The process of `generation` sent something: it is alive.
    pub(super) fn heard(&self, generation: u64) {
        let mut state = self.state.lock_unpoisoned();
        if let Slot::Running(running) = &mut state.slot
            && running.generation == generation
        {
            running.heard += 1;
        }
    }

    /// How much `generation` was heard from so far (see [`Running::heard`]).
    pub(super) fn heard_count(&self, generation: u64) -> u64 {
        match &self.state.lock_unpoisoned().slot {
            Slot::Running(running) if running.generation == generation => running.heard,
            _ => 0,
        }
    }
}

/// The helper's side of the connection: relays allowlisted notifications to the Host and answers the helper's own
/// requests with method-not-found.
pub(super) struct Relay {
    pub(super) host: Peer,
    /// Anything the process sends marks it alive (see [`Running::heard`]), relayed or not: a dropped notification
    /// is still proof that the process is running. A hung call on a live process is then left to its cancel (calls
    /// with an `operationId`) and to the idle reclaim.
    pub(super) helper: Weak<NodeHelper>,
    pub(super) generation: u64,
}

impl Relay {
    pub(super) fn heard(&self) {
        if let Some(helper) = self.helper.upgrade() {
            helper.heard(self.generation);
        }
    }
}

#[async_trait]
impl Service for Relay {
    /// F3: pipe traffic is routed in the read loop, so a connection's messages reach Rust's MCP client in the order the
    /// helper sent them (`serve` spawns every other notification as its own task).
    /// `helper/session/delta` too, so a session's deltas keep the helper's order on its stream.
    fn control(&self, method: &str, params: &Value) -> bool {
        let pipe = mcp::PIPE_NOTIFICATIONS.contains(&method);
        if !pipe && method != panels::SESSION_DELTA {
            return false;
        }
        if let Some(helper) = self.helper.upgrade() {
            helper.heard(self.generation);
            if pipe {
                helper.pipe_event(self.generation, method, params);
            } else {
                helper.session_delta(self.generation, params);
            }
        }
        true
    }

    /// F3: the helper's requests to Rust (`helper/authorizeAppTool`).
    async fn request(&self, method: &str, params: Value) -> Result<Reply, RpcError> {
        self.heard();
        let Some(helper) = self.helper.upgrade() else {
            return Err(unavailable("the agent is shutting down"));
        };
        helper
            .helper_request(self.generation, method, params)
            .await
            .map(Reply::new)
    }

    async fn notification(&self, method: &str, params: Value) {
        self.heard();
        if method == requests::CANCEL_REQUEST {
            if let Some(helper) = self.helper.upgrade() {
                helper.cancel_request(&params);
            }
        } else if RELAYED_NOTIFICATIONS.contains(&method) {
            self.host.notify(method, &params).await;
        } else {
            tracing::debug!(
                event = "helper.notification.dropped",
                method,
                "a helper notification is not relayed"
            );
        }
    }
}
