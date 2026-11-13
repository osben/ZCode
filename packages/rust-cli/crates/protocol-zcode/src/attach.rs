//! Fork: the Host's attach acknowledgement (specs/fork-rust-credential-cipher.md F1).
//!
//! The Host attaches its reverse-request listener only after spawn returns, so a reverse request sent earlier is
//! dropped and its caller waits for the bound. A Host that spawns the agent with `ZCODE_HOST_ATTACH_ACK=1` sends
//! `process/hostAttached` once it listens; until then the agent holds its reverse requests.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::Spawner;
use rust_cli_protocol_core::connection::{self, Options, Reply, Service};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::Value;
use tokio::io::AsyncBufRead;
use tokio::sync::watch;

use crate::context::Context;
use crate::inbound::Inbound;

/// The acknowledgement's method (`zcodeProtocolMethods.processHostAttached`).
pub const HOST_ATTACHED: &str = "process/hostAttached";
/// Set by the Host on spawn when it will send the acknowledgement (`ZCODE_HOST_ATTACH_ACK_ENV`).
pub const HOST_ATTACH_ACK_ENV: &str = "ZCODE_HOST_ATTACH_ACK";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// The Host did not promise an acknowledgement: reverse requests go out at once.
    NotDeclared,
    Waiting,
    Attached {
        credential_cipher: bool,
    },
    /// The connection ended before the acknowledgement: held requests go out to the closed peer, which fails them
    /// at once.
    Detached,
}

/// The acknowledgement state of one connection.
pub(crate) struct HostAttach(watch::Sender<State>);

impl HostAttach {
    pub(crate) fn new() -> Self {
        Self(watch::Sender::new(State::NotDeclared))
    }

    pub(crate) fn expect(&self) {
        self.0.send_if_modified(|state| {
            let waiting = *state == State::NotDeclared;
            if waiting {
                *state = State::Waiting;
            }
            waiting
        });
    }

    pub(crate) fn attached(&self, credential_cipher: bool) {
        self.0.send_replace(State::Attached { credential_cipher });
    }

    fn detached(&self) {
        self.0.send_if_modified(|state| {
            let waiting = *state == State::Waiting;
            if waiting {
                *state = State::Detached;
            }
            waiting
        });
    }

    /// Whether reverse requests are still held for the acknowledgement.
    pub(crate) fn waiting(&self) -> bool {
        *self.0.borrow() == State::Waiting
    }

    /// Waits until reverse requests may be sent. `None` when no acknowledgement was promised; otherwise whether the
    /// Host answers credential cipher requests.
    pub(crate) async fn ready(&self) -> Option<bool> {
        let mut receiver = self.0.subscribe();
        let state = match receiver.wait_for(|state| *state != State::Waiting).await {
            Ok(state) => *state,
            // The sender lives in the context; it is never dropped while a caller holds the context.
            Err(_) => State::NotDeclared,
        };
        match state {
            State::Attached { credential_cipher } => Some(credential_cipher),
            State::NotDeclared | State::Waiting | State::Detached => None,
        }
    }
}

/// Serves the connection with [`AttachGate`] in front of `inner`. When the input ends, reverse requests still held
/// for the acknowledgement are released: the closed peer fails them at once instead of at their bound.
pub async fn serve_attached<R>(
    reader: R,
    context: Arc<Context>,
    inner: Arc<dyn Service>,
    spawner: Spawner,
    options: Options,
) -> std::io::Result<()>
where
    R: AsyncBufRead + Unpin,
{
    let gate = AttachGate::wrap(context.clone(), inner);
    let served = connection::serve(reader, context.peer.clone(), gate, spawner, options).await;
    context.attach.detached();
    served
}

/// Handles the acknowledgement in front of the connection's service. It must not wait for that service: in the
/// app-server the service is `Deferred` until assembly ends, and assembly waits for the acknowledgement.
pub(crate) struct AttachGate {
    context: Arc<Context>,
    inner: Arc<dyn Service>,
}

impl AttachGate {
    pub(crate) fn wrap(context: Arc<Context>, inner: Arc<dyn Service>) -> Arc<dyn Service> {
        Arc::new(Self { context, inner })
    }
}

#[async_trait]
impl Service for AttachGate {
    async fn request(&self, method: &str, params: Value) -> Result<Reply, RpcError> {
        self.inner.request(method, params).await
    }

    async fn notification(&self, method: &str, params: Value) {
        if method != HOST_ATTACHED {
            return self.inner.notification(method, params).await;
        }
        if let Err(error) = Inbound::get().method(HOST_ATTACHED, &params) {
            tracing::warn!(
                event = "app.host_attach.invalid",
                error = %error.message,
                "ignoring an invalid host attach acknowledgement"
            );
            return;
        }
        let credential_cipher = params["credentialCipher"] == true;
        tracing::info!(
            event = "app.host_attach.received",
            credential_cipher,
            "the host listens for reverse requests"
        );
        self.context.host_attached(credential_cipher);
    }
}

#[cfg(test)]
#[path = "attach_tests.rs"]
mod tests;
