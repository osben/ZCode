//! Runtime errors (Node `packages/acp-agent-runtime/src/errors.ts`): one type with a stable code, so the turn
//! driver can tell a dead agent from a refused prompt without reading the message.

use std::fmt;

/// Error codes of the Node runtime (`ACP_*`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpErrorCode {
    /// The launch config breaks the shared launch rules.
    InvalidLaunch,
    /// The agent process could not be started.
    SpawnFailed,
    /// `initialize`, `session/new` or `session/load` failed.
    HandshakeFailed,
    /// The agent negotiated a protocol version other than 1.
    ProtocolVersion,
    /// The agent process exited while a request was pending.
    AgentDied,
    /// The agent closed its output (or sent an oversized frame).
    StreamClosed,
    /// A request did not answer within its timeout.
    Timeout,
    /// The runtime was stopped or the turn cancelled.
    Cancelled,
    /// The runtime is in a state that cannot run the request.
    State,
    /// A config change names an option or value the agent does not offer.
    InvalidConfig,
    /// The agent answered a request with a JSON-RPC error.
    Rpc,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpError {
    pub code: AcpErrorCode,
    pub message: String,
}

impl AcpError {
    pub fn new(code: AcpErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub(crate) fn state(message: impl Into<String>) -> Self {
        Self::new(AcpErrorCode::State, message)
    }

    pub(crate) fn died(message: impl Into<String>) -> Self {
        Self::new(AcpErrorCode::AgentDied, message)
    }

    pub(crate) fn cancelled(message: impl Into<String>) -> Self {
        Self::new(AcpErrorCode::Cancelled, message)
    }

    pub(crate) fn stream_closed() -> Self {
        Self::new(AcpErrorCode::StreamClosed, "ACP agent output stream closed")
    }
}

impl fmt::Display for AcpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AcpError {}
