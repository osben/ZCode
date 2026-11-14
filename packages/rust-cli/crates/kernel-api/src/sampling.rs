//! Fork: an MCP App panel's model sampling (specs/fork-rust-node-helper.md F3, `helper/sampleModel`; Node
//! `sampleModel` in `runtime/methods/sample-model.ts`). A panel's `mcp/uiSampling` reaches the Node helper, which has
//! validated it against `mcpAppsSamplingParamsSchema`; Rust runs one model call on the session's model, outside any
//! turn, and writes no message or event, only the call's usage row.

use tokio_util::sync::CancellationToken;

use crate::ids::SessionId;
use crate::session_api::KernelError;

/// One sampling call: the session whose model answers it, the panel's request, and the helper's cancel.
#[derive(Debug, Clone)]
pub struct SamplingCall {
    pub session: SessionId,
    pub request: SamplingRequest,
    /// Fired when the helper abandons the call (`helper/cancelRequest`, its process gone, its 60 s timeout).
    pub cancel: CancellationToken,
}

/// The part of `mcpAppsSamplingParamsSchema` Node forwards to the model: `includeContext`, `modelPreferences` and
/// `metadata` are accepted by the helper and never used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SamplingRequest {
    pub messages: Vec<SamplingMessage>,
    pub system_prompt: Option<String>,
    pub max_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SamplingMessage {
    pub assistant: bool,
    pub content: Vec<SamplingBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SamplingBlock {
    Text(String),
    /// Base64 data of an allowed image type (the helper checked both).
    Image {
        mime_type: String,
        data: String,
    },
}

/// Node's `McpAppsSamplingResult` without the fixed `role` and content type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SamplingReply {
    /// The model id of the session's selection.
    pub model: String,
    pub text: String,
    /// Node's mapping of the AI SDK finish reason: `endTurn`, `maxTokens`, otherwise the reason itself.
    pub stop_reason: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SamplingError {
    /// Node's thrown error, whose message the helper hands to the panel.
    #[error("{0}")]
    Failed(String),
    #[error("the sampling call was cancelled")]
    Cancelled,
    #[error(transparent)]
    Kernel(#[from] KernelError),
}

/// Node `sampleModel`'s words when the completion is not plain text.
pub const UNSUPPORTED_COMPLETION: &str = "Sampling did not produce a supported completion";
/// Node `sampleModel`'s words when the session's model takes no images.
pub const NO_IMAGE_INPUT: &str = "Selected model does not support image input";
