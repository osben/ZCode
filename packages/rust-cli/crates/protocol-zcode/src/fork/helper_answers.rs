//! Fork: the protocol server answers the Node helper's requests (specs/fork-rust-node-helper.md F3, "Helper → Rust
//! requests"). `helper/authorizeAppTool` opens the session's projection (its prompt reaches the Host on the session's
//! stream), then has the kernel run its tool pipeline on the App call. `helper/session/delta` reaches the session's live
//! stream.

use async_trait::async_trait;
use rust_cli_kernel_api::app_tool::{AppToolCall, AppToolError};
use rust_cli_kernel_api::ids::{SessionId, ToolUseId};
use rust_cli_kernel_api::session_api::KernelError;
use rust_cli_protocol_core::rpc::{RpcError, codes};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::helper_session_admit::not_hosted;
use super::node_helper::HelperRequests;
use crate::server::Server;

#[async_trait]
impl HelperRequests for Server {
    async fn authorize_app_tool(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        let call = parse(&params, cancel)?;
        let hosted = self
            .context
            .node_helper()
            .and_then(|helper| helper.catalog())
            .is_some_and(|catalog| catalog.servers.contains(&call.server));
        if !hosted {
            return Err(not_hosted(
                "the MCP server is not hosted by the Node helper",
            ));
        }
        self.live(&call.session).await.map_err(kernel_error)?;
        answer(self.kernel.authorize_app_tool(call).await)
    }

    /// Appended in the session's pump order. A session without a live projection has no stream to show it on, so the
    /// delta is dropped, as Node drops a live-only event nobody subscribes to.
    fn session_delta(&self, session: &str, delta: Value) {
        let Some(live) = self.bridge.get(&SessionId::new(session)) else {
            return;
        };
        let sink = live.sink.clone();
        live.run(Box::pin(async move {
            sink.plugin_ui(delta).await;
        }));
    }
}

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params(format!("{key} is required")))
}

/// `{requestKey, sessionId, serverName, toolName, input, tool}`; the request key is the prompt's tool use id.
pub(crate) fn parse(params: &Value, cancel: CancellationToken) -> Result<AppToolCall, RpcError> {
    Ok(AppToolCall {
        session: SessionId::new(required(params, "sessionId")?),
        server: required(params, "serverName")?.to_owned(),
        tool: required(params, "toolName")?.to_owned(),
        input: params.get("input").cloned().unwrap_or_else(|| json!({})),
        descriptor: params.get("tool").cloned().unwrap_or_else(|| json!({})),
        tool_use: ToolUseId::new(required(params, "requestKey")?),
        cancel,
    })
}

/// `{input}`, or an error whose `data.type` is Node's `CoreErrorType`, which the helper maps back to a `CoreError`.
pub(crate) fn answer(result: Result<Value, AppToolError>) -> Result<Value, RpcError> {
    match result {
        Ok(input) => Ok(json!({"input": input})),
        Err(AppToolError::Refused(refusal)) => {
            Err(RpcError::new(codes::INTERNAL_ERROR, refusal.message())
                .with_data(json!({"type": refusal.core_type()})))
        }
        Err(AppToolError::Kernel(error)) => Err(kernel_error(error)),
    }
}

fn kernel_error(error: KernelError) -> RpcError {
    match error {
        KernelError::NotFound { .. } => RpcError::invalid_params(error.to_string()),
        other => RpcError::internal(other.to_string()),
    }
}

#[cfg(test)]
#[path = "helper_answers_tests.rs"]
mod tests;
