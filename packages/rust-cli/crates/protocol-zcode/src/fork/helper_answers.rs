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
pub(crate) async fn root_by<F, Fut>(session: &str, meta: F) -> Option<String>
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
    async fn browser_request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        relay_browser(
            method,
            params,
            // Owned means this agent's: a session it opened in the helper, or one it runs live. The store row alone
            // is shared by every agent and the Node main agent of the workspace (specs/fork-rust-node-helper.md).
            |session: String| async move {
                let live = self
                    .bridge
                    .get(&rust_cli_kernel_api::ids::SessionId::new(&session))
                    .is_some();
                live || self
                    .context
                    .node_helper()
                    .is_some_and(|helper| helper.opened_here(&session))
            },
            // The Host's refusal goes back unchanged: its `data` carries the typed error the helper maps (`data.type`).
            |method, params| async move { self.context.peer.request(&method, &params).await },
        )
        .await
    }

    async fn session_parent(&self, session: &str) -> Option<String> {
        use rust_cli_kernel_api::store::SessionKind;
        let id = rust_cli_kernel_api::ids::SessionId::new(session);
        // A failed read is logged: a subagent whose parent cannot be read opens without its parent's browser scope,
        // and that must not be silent.
        let view = match self.kernel.session_snapshot(&id).await {
            Ok(view) => view,
            Err(error) => {
                tracing::warn!(
                    event = "helper.browser.parent_unread",
                    error = %error,
                    "the child-session registration is skipped: the parent cannot be read"
                );
                return None;
            }
        };
        let meta = view.meta;
        match (meta.kind, meta.parent) {
            (SessionKind::Subagent, Some(parent)) => Some(parent.as_str().to_owned()),
            _ => None,
        }
    }

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
            .and_then(|helper| helper.catalog_for(call.session.as_str()))
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

    /// F3b(c) PR 2: a helper-hosted server's question, asked of the session the in-flight call runs in (helper_elicitation.rs).
    /// A question without a call is declined without asking; a refused one is an error the helper declines.
    async fn elicitation(
        &self,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        let Some(call) = super::helper_elicitation::parse(&params, cancel)? else {
            return Ok(super::helper_elicitation::declined());
        };
        self.live(&call.session).await.map_err(kernel_error)?;
        super::helper_elicitation::answer(self.kernel.mcp_elicitation(call).await)
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

/// F4b: relays one browser request of the helper (`interaction/browserList` or `interaction/browserExecute`). The
/// session is named by `sessionId` and must be one this agent owns; the helper's `requestKey` stays here. Main gets
/// the rest, as the broker built it (F4-D5).
pub(super) async fn relay_browser<Owned, OwnedFut, Host, HostFut>(
    method: &str,
    mut params: Value,
    owned: Owned,
    host: Host,
) -> Result<Value, RpcError>
where
    Owned: FnOnce(String) -> OwnedFut,
    OwnedFut: std::future::Future<Output = bool>,
    Host: FnOnce(String, Value) -> HostFut,
    HostFut: std::future::Future<Output = Result<Value, RpcError>>,
{
    let session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|session| !session.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| RpcError::invalid_params("sessionId is required"))?;
    if let Some(object) = params.as_object_mut() {
        object.remove("requestKey");
    }
    if !owned(session).await {
        return Err(RpcError::invalid_params(
            "the session is not one of this agent's",
        ));
    }
    host(method.to_owned(), params).await
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
