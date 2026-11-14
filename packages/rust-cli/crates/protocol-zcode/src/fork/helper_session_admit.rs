//! Fork: the ownership check of the session-scoped methods Rust forwards to the Node helper
//! (specs/fork-rust-node-helper.md F3, "Session-scoped forwarded methods"). Rust forwards one only when the session is
//! one of its own (open or resumable in this process) and, for a method that names a `serverName`, when that server
//! is helper-hosted; `plugins/mentionItems` names a plugin, which must be helper-hosted. Otherwise it answers
//! [`MCP_UI_SERVER_NOT_HELPER_HOSTED`].

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::fork::node_helper::{HelperCatalog, NodeHelper, session_of};
use crate::server::Server;

pub const MCP_UI_SERVER_NOT_HELPER_HOSTED: &str = "proto.forkRustAgent.mcpUiServerNotHelperHosted";

/// Refuses a session-scoped call Rust must not forward; `None` for any other call.
pub(crate) async fn admit(
    server: &Server,
    helper: &NodeHelper,
    method: &str,
    params: &Value,
) -> Result<(), RpcError> {
    let Some(session) = session_of(method, params) else {
        return Ok(());
    };
    let owned = !session.is_empty() && owns(server, &SessionId::new(session)).await;
    match refusal(method, params, owned, helper.catalog().as_deref()) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Open in this process, or a session of this process's store (resumable).
async fn owns(server: &Server, session: &SessionId) -> bool {
    server.bridge.get(session).is_some()
        || matches!(
            server.kernel.queries().session_workspace_key(session).await,
            Ok(Some(_))
        )
}

pub(crate) fn refusal(
    method: &str,
    params: &Value,
    owned: bool,
    catalog: Option<&HelperCatalog>,
) -> Option<RpcError> {
    let session = session_of(method, params)?;
    if session.is_empty() {
        return Some(RpcError::invalid_params("sessionId is required"));
    }
    if !owned {
        return Some(not_hosted("the session is not one of this agent's"));
    }
    let hosted = |list: fn(&HelperCatalog) -> &Vec<String>, name: &str| {
        catalog.is_some_and(|catalog| list(catalog).iter().any(|known| known == name))
    };
    if method == "plugins/mentionItems" {
        let plugin = params
            .get("pluginId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !hosted(|catalog| &catalog.helper_plugins, plugin) {
            return Some(not_hosted(
                "the plugin's servers are not hosted by the Node helper",
            ));
        }
    } else if let Some(server) = params.get("serverName").and_then(Value::as_str)
        && !hosted(|catalog| &catalog.servers, server)
    {
        return Some(not_hosted(
            "the MCP server is not hosted by the Node helper",
        ));
    }
    None
}

pub(crate) fn not_hosted(message: &str) -> RpcError {
    RpcError::invalid_params(format!("{message} ({MCP_UI_SERVER_NOT_HELPER_HOSTED})"))
        .with_data(json!({"reasonCode": MCP_UI_SERVER_NOT_HELPER_HOSTED}))
}

#[cfg(test)]
#[path = "helper_session_admit_tests.rs"]
mod tests;
