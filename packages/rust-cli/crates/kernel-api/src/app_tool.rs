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

/// Fork F3b(b): one app-provided tool of a session, as the helper's `helper/appTools/replace` names it. `model_name` is
/// the model-side name (`app__<server>__<tool>`); the rest is what the model sees and what the call needs.
#[derive(Debug, Clone, PartialEq)]
pub struct AppToolSpec {
    pub model_name: String,
    pub server_name: String,
    pub plugin_id: String,
    pub tool_name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub input_schema: Value,
    pub read_only: bool,
    pub destructive: bool,
    pub idempotent: bool,
}

/// Fork F3b(c) PR 2: a helper-hosted server's question (`elicitation/create`) the helper relays (`helper/elicitation`).
/// `params` is the server's request (`message`, `requestedSchema`, `mode`); the question belongs to `tool_use`'s call on
/// `server` in `session`. `withdrawn` fires when the helper abandons the request, so the question is withdrawn.
#[derive(Debug, Clone)]
pub struct ElicitationCall {
    pub session: SessionId,
    pub tool_use: ToolUseId,
    pub server: String,
    pub params: Value,
    pub withdrawn: CancellationToken,
}

/// Fork F3b(b): the reader and invoker of the app-provided tools a Node helper holds (specs/fork-rust-node-helper.md
/// F3b(b)). The tool registry reads a session's set; a call runs in the helper, and a cancel of the call is sent to it.
#[async_trait::async_trait]
pub trait AppToolHost: Send + Sync {
    /// The session's app-provided tools as the helper last replaced them; none once the helper that set them is gone.
    fn app_tools(&self, session: &SessionId) -> Vec<AppToolSpec>;

    /// The session's app-provided tool named `name`, if the set holds it. A host reads one tool without copying the set.
    fn app_tool(&self, session: &SessionId, name: &str) -> Option<AppToolSpec> {
        self.app_tools(session)
            .into_iter()
            .find(|spec| spec.model_name == name)
    }

    /// `helper/appTools/call`: the helper's MCP-shaped result (`{content, isError?, ...}`), or the failure's message.
    async fn call(
        &self,
        session: &SessionId,
        turn: &str,
        tool_call: &str,
        name: &str,
        input: Value,
    ) -> Result<Value, String>;

    /// `helper/appTools/cancel`: the call `tool_call` was abandoned on the Rust side.
    async fn cancel(&self, session: &SessionId, tool_call: &str);
}
