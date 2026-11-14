//! Fork: the protocol server answers the Node helper's requests (specs/fork-rust-node-helper.md F3, "Helper → Rust
//! requests"). `helper/authorizeAppTool` opens the session's projection (its prompt reaches the Host on the session's
//! stream), then has the kernel run its tool pipeline on the App call. `helper/sampleModel` runs one model call on the
//! session's model (helper_sampling.rs). `helper/session/delta` reaches the session's live stream.

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

/// The top-level session above a subagent session: its parents are followed while they are subagent sessions, as
/// Node's subagent runs carry `rootSessionId ?? parent` (core subagent/runner.ts). The stored trace is not used: Node
/// writes a trace id there, not the root. A parent that cannot be read is taken as the root; an interactive or fork
/// session is its own root (`None`).
pub(super) async fn root_by<F, Fut>(session: &str, meta: F) -> Option<String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Option<rust_cli_kernel_api::store::SessionMeta>>,
{
    use rust_cli_kernel_api::store::SessionKind;
    // Subagents nest at most a few levels; the bound only stops a corrupt parent cycle.
    const MAX_DEPTH: usize = 16;
    let mut current = session.to_owned();
    let mut root = None;
    for _ in 0..MAX_DEPTH {
        let Some(found) = meta(current.clone()).await else {
            break;
        };
        match (found.kind, found.parent) {
            (SessionKind::Subagent, Some(parent)) => {
                current = parent.as_str().to_owned();
                root = Some(current.clone());
            }
            _ => break,
        }
    }
    root
}

#[async_trait]
impl HelperRequests for Server {
    async fn session_workspace(&self, session: &str) -> Option<Value> {
        let workspace = self
            .kernel
            .queries()
            .session_workspace(&rust_cli_kernel_api::ids::SessionId::new(session))
            .await
            .ok()
            .flatten()?;
        let mut value = serde_json::json!({"workspacePath": workspace.directory});
        if let Some(identity) = workspace.identity {
            value["workspaceIdentity"] = Value::String(identity);
        }
        Some(value)
    }

    async fn session_execution_directory(&self, session: &str) -> Option<String> {
        let session = rust_cli_kernel_api::ids::SessionId::new(session);
        let execution = crate::worktree::stored_execution(self, &session).await?;
        let path = execution.path.as_str();
        (!crate::worktree::missing(self, path).await).then(|| path.to_owned())
    }

    async fn session_root(&self, session: &str) -> Option<String> {
        root_by(session, |id| async move {
            let id = rust_cli_kernel_api::ids::SessionId::new(id);
            self.kernel
                .session_snapshot(&id)
                .await
                .ok()
                .map(|view| view.meta)
        })
        .await
    }

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

    /// Opens the session, as Node's sampling runs on the session's runtime.
    async fn sample_model(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        let call = super::helper_sampling::parse(&params, cancel)?;
        self.live(&call.session).await.map_err(kernel_error)?;
        super::helper_sampling::answer(self.kernel.sample_model(call).await)
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

pub(super) fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RpcError::invalid_params(format!("{key} is required")))
}

/// `{requestKey, sessionId, serverName, toolName, input, tool}`; the request key is the prompt's tool use id. The helper
/// always sends Node's `input: args ?? {}` and its `listTools` descriptor; neither is defaulted here, since a
/// descriptor without `inputSchema` would let any input through validation.
pub(crate) fn parse(params: &Value, cancel: CancellationToken) -> Result<AppToolCall, RpcError> {
    let session = SessionId::new(required(params, "sessionId")?);
    let server = required(params, "serverName")?.to_owned();
    let tool = required(params, "toolName")?.to_owned();
    let tool_use = ToolUseId::new(required(params, "requestKey")?);
    let input = params
        .get("input")
        .filter(|input| input.is_object())
        .cloned()
        .ok_or_else(|| RpcError::invalid_params("input must be an object"))?;
    let descriptor = params
        .get("tool")
        .filter(|tool| tool.get("inputSchema").is_some_and(Value::is_object))
        .cloned()
        .ok_or_else(|| {
            RpcError::invalid_params("tool must be an object with an object inputSchema")
        })?;
    Ok(AppToolCall {
        session,
        server,
        tool,
        input,
        descriptor,
        tool_use,
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

pub(super) fn kernel_error(error: KernelError) -> RpcError {
    match error {
        KernelError::NotFound { .. } => RpcError::invalid_params(error.to_string()),
        other => RpcError::internal(other.to_string()),
    }
}

#[cfg(test)]
#[path = "helper_answers_tests.rs"]
mod tests;
