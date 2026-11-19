//! Fork: `helper/elicitation` (specs/fork-rust-node-helper.md F3b(c), PR 2): a helper-hosted server's question, asked of the
//! session the in-flight tool call runs in. The helper sends it only while a pipe call of the server is in flight, with
//! the call's tool use id; a request without one has no call to attribute the question to, and is declined.

use rust_cli_kernel_api::app_tool::ElicitationCall;
use rust_cli_kernel_api::ids::{SessionId, ToolUseId};
use rust_cli_kernel_api::session_api::KernelError;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::helper_answers::{kernel_error, required};

/// `{requestKey, sessionId, toolUseId, serverName, message, requestedSchema?, mode?}`. `Ok(None)` when no tool call is in
/// flight (no `toolUseId`): the answer is then a decline, without a question.
pub(crate) fn parse(
    params: &Value,
    withdrawn: CancellationToken,
) -> Result<Option<ElicitationCall>, RpcError> {
    let session = SessionId::new(required(params, "sessionId")?);
    let server = required(params, "serverName")?.to_owned();
    let Some(tool_use) = params
        .get("toolUseId")
        .and_then(Value::as_str)
        .filter(|tool_use| !tool_use.is_empty())
    else {
        return Ok(None);
    };
    Ok(Some(ElicitationCall {
        session,
        tool_use: ToolUseId::new(tool_use),
        server,
        params: params.clone(),
        withdrawn,
    }))
}

/// The helper's answer: the server's `{action, content?}` (Rust's answer, passed through), or the decline a failed or
/// unattributed question gets. A refused question is an error the helper declines.
pub(crate) fn answer(result: Result<Value, KernelError>) -> Result<Value, RpcError> {
    result.map_err(kernel_error)
}

/// The decline a question without a call, or one the helper refused, gets (no question was asked).
pub(crate) fn declined() -> Value {
    json!({"action": "decline"})
}

#[cfg(test)]
#[path = "helper_elicitation_tests.rs"]
mod tests;
