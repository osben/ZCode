//! Fork: `helper/sampleModel` (specs/fork-rust-node-helper.md F3, "Helper → Rust requests"). The helper validated the
//! panel's request against `mcpAppsSamplingParamsSchema`; Rust reads the part Node forwards to the model, opens the
//! session and has the kernel run the call. The answer is Node's `McpAppsSamplingResult`.

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::sampling::{
    SamplingBlock, SamplingCall, SamplingError, SamplingMessage, SamplingReply, SamplingRequest,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::helper_answers::{kernel_error, required};

/// `{requestKey, sessionId, request, source}`; `source` (`pluginId`, `serverName`, `appIdentity`) only labels Node's
/// trace.
pub(crate) fn parse(params: &Value, cancel: CancellationToken) -> Result<SamplingCall, RpcError> {
    let session = SessionId::new(required(params, "sessionId")?);
    let request = params
        .get("request")
        .ok_or_else(|| RpcError::invalid_params("request is required"))?;
    let messages = request
        .get("messages")
        .and_then(Value::as_array)
        .filter(|messages| !messages.is_empty())
        .ok_or_else(|| RpcError::invalid_params("request.messages is required"))?
        .iter()
        .map(message)
        .collect::<Result<_, _>>()?;
    let system_prompt = match request.get("systemPrompt") {
        None => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(_) => {
            return Err(RpcError::invalid_params(
                "request.systemPrompt must be a string",
            ));
        }
    };
    let max_tokens = request
        .get("maxTokens")
        .and_then(Value::as_u64)
        .filter(|max| *max > 0)
        .ok_or_else(|| RpcError::invalid_params("request.maxTokens must be a positive integer"))?;
    Ok(SamplingCall {
        session,
        request: SamplingRequest {
            messages,
            system_prompt,
            max_tokens,
        },
        cancel,
    })
}

fn message(message: &Value) -> Result<SamplingMessage, RpcError> {
    let assistant = match message.get("role").and_then(Value::as_str) {
        Some("user") => false,
        Some("assistant") => true,
        _ => {
            return Err(RpcError::invalid_params(
                "a message role is user or assistant",
            ));
        }
    };
    // One block or a list of them.
    let content = match message.get("content") {
        Some(Value::Array(blocks)) if !blocks.is_empty() => {
            blocks.iter().map(block).collect::<Result<_, _>>()?
        }
        Some(one @ Value::Object(_)) => vec![block(one)?],
        _ => return Err(RpcError::invalid_params("a message has content")),
    };
    Ok(SamplingMessage { assistant, content })
}

fn block(block: &Value) -> Result<SamplingBlock, RpcError> {
    let field = |key: &str| block.get(key).and_then(Value::as_str);
    match field("type") {
        Some("text") => field("text")
            .map(|text| SamplingBlock::Text(text.to_owned()))
            .ok_or_else(|| RpcError::invalid_params("a text block has text")),
        Some("image") => match (field("mimeType"), field("data")) {
            (Some(mime_type), Some(data)) => Ok(SamplingBlock::Image {
                mime_type: mime_type.to_owned(),
                data: data.to_owned(),
            }),
            _ => Err(RpcError::invalid_params(
                "an image block has mimeType and data",
            )),
        },
        _ => Err(RpcError::invalid_params("a block is text or image")),
    }
}

/// Node's `{role, model, content: {type: "text", text}, stopReason}`, or the error whose message the helper rejects
/// with.
pub(crate) fn answer(result: Result<SamplingReply, SamplingError>) -> Result<Value, RpcError> {
    match result {
        Ok(reply) => Ok(json!({
            "role": "assistant",
            "model": reply.model,
            "content": {"type": "text", "text": reply.text},
            "stopReason": reply.stop_reason,
        })),
        Err(SamplingError::Kernel(error)) => Err(kernel_error(error)),
        Err(error @ (SamplingError::Failed(_) | SamplingError::Cancelled)) => {
            Err(RpcError::internal(error.to_string()))
        }
    }
}

#[cfg(test)]
#[path = "helper_sampling_tests.rs"]
mod tests;
