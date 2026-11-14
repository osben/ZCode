//! Fork: authorizing an MCP App tool call (specs/fork-rust-node-helper.md F3, `helper/authorizeAppTool`). A panel's
//! `mcp/uiCallTool` and the composer's `plugins/mentionItems` run in the Node helper; Rust runs the admission part of
//! its tool pipeline on the call and the helper runs the tool only with the input Rust approved.

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::ids::{SessionId, ToolUseId};
use crate::session_api::KernelError;

/// One authorization: the session it runs in, the helper-hosted server (`plugin:<plugin>:<server>`), the server's own
/// tool name, the call's input and the helper's descriptor (`{description?, inputSchema, annotations?}`). App-only
/// tools are not in Rust's tool list, so the descriptor is what Rust builds the transient MCP tool from.
#[derive(Debug, Clone)]
pub struct AppToolCall {
    pub session: SessionId,
    pub server: String,
    pub tool: String,
    pub input: Value,
    pub descriptor: Value,
    /// The id a permission prompt of this call carries.
    pub tool_use: ToolUseId,
    /// Fired when the helper abandons the call (`helper/cancelRequest`): a pending prompt is withdrawn.
    pub cancel: CancellationToken,
}

/// Why the pipeline refused the call, as Node's `CoreErrorType` (`invalid_input`, `permission_denied`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppToolRefusal {
    InvalidInput(String),
    PermissionDenied(String),
}

impl AppToolRefusal {
    /// Node's `CoreErrorType` value the helper maps back to its `CoreError`.
    pub fn core_type(&self) -> &'static str {
        match self {
            Self::InvalidInput(_) => "invalid_input",
            Self::PermissionDenied(_) => "permission_denied",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::InvalidInput(message) | Self::PermissionDenied(message) => message,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AppToolError {
    #[error("{}", .0.message())]
    Refused(AppToolRefusal),
    #[error(transparent)]
    Kernel(#[from] KernelError),
}
