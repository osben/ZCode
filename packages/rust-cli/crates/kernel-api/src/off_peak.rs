//! Fork: the desktop Host's off-peak task store as seen from the agent (Node `offpeak-port.ts`;
//! specs/fork-rust-automations.md, slice 3). The OffPeak tools build each request's params; the port sends it for the
//! owner session's workspace and checks the Host's reply against the protocol schema.

use async_trait::async_trait;
use serde_json::Value;

use crate::ids::SessionId;

pub const CREATE: &str = "offPeak/create";
pub const LIST: &str = "offPeak/list";

/// A failed Host request. `code` is the JSON-RPC code the peer reported; `None` when no code applies (the reply failed
/// its schema, the request was refused before it was sent, or the session has no workspace). A business failure of
/// `offPeak/create` is a reply, not an error: the tool classifies it from the reply.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct OffPeakError {
    pub code: Option<i64>,
    pub message: String,
}

impl OffPeakError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait OffPeakPort: Send + Sync {
    /// Fork (slice 3 layer B): the ticket source of the open run `execution`, whichever session asks: the requests of
    /// its turn and of the subagents it started are sent on it. None when no such run is open.
    fn ticket(
        &self,
        _session: &SessionId,
        _execution: &str,
    ) -> Option<crate::off_peak_ticket::TicketSource> {
        None
    }

    /// Sends `method` with `params` plus the `workspace` ref of `session` (the owner session) and answers the Host's
    /// result once it matched the method's reply schema.
    async fn request(
        &self,
        session: &SessionId,
        method: &str,
        params: Value,
    ) -> Result<Value, OffPeakError>;
}
