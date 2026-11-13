//! Fork: the desktop Host's automation store as seen from the agent (Node `automation-port.ts`;
//! specs/fork-rust-automations.md, slice 2). The Cron tools build each request's params; the port sends it for the
//! owner session's workspace and checks the Host's reply against the protocol schema.

use async_trait::async_trait;
use serde_json::Value;

use crate::ids::SessionId;

pub const CREATE: &str = "automation/create";
pub const UPDATE: &str = "automation/update";
pub const LIST: &str = "automation/list";
pub const DELETE: &str = "automation/delete";
pub const PAUSE: &str = "automation/pause";
pub const CHECK_TASK_BINDING: &str = "automation/checkTaskBinding";

/// JSON-RPC "method not found": the only Host failure that proves a missing capability (an older Host without
/// `automation/checkTaskBinding`).
pub const METHOD_NOT_FOUND: i64 = -32601;

/// A failed Host request: the JSON-RPC code when the Host answered with an error, None for a transport failure,
/// a timeout or an invalid reply.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct AutomationError {
    pub code: Option<i64>,
    pub message: String,
}

impl AutomationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    pub fn is_method_not_found(&self) -> bool {
        self.code == Some(METHOD_NOT_FOUND)
    }
}

#[async_trait]
pub trait AutomationPort: Send + Sync {
    /// Sends `method` with `params` plus the `workspace` ref of `session` (the owner session) and answers the
    /// Host's result once it matched the method's reply schema.
    async fn request(
        &self,
        session: &SessionId,
        method: &str,
        params: Value,
    ) -> Result<Value, AutomationError>;
}
