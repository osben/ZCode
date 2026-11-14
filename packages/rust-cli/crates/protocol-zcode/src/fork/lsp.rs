//! Fork: `lsp/preferences/get`, `lsp/preferences/set` and `lsp/status` (specs/fork-rust-lsp.md "Protocol surface"),
//! Node bootstrap `zcode-protocol/lsp.ts`. The strict params check runs before, in [`crate::inbound::Inbound::method`],
//! as Node's `parseParams` does; this module answers through the [`LanguageServers`] port and holds no LSP state.

use std::sync::Arc;

use rust_cli_kernel_api::lsp::{
    LanguageServers, LspPreferences, LspPreferencesPatch, LspServerStatus, LspWorkspace,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Map, Value, json};

/// Node `LSP_HOST_UNAVAILABLE_CODE`.
const LSP_HOST_UNAVAILABLE: i64 = -32000;

/// `None` for a method outside the `lsp/*` family. `host` is `None` in a process without the LSP host.
pub(super) async fn dispatch(
    host: Option<&Arc<dyn LanguageServers>>,
    method: &str,
    params: &Value,
) -> Option<Result<Value, RpcError>> {
    if !matches!(
        method,
        "lsp/preferences/get" | "lsp/preferences/set" | "lsp/status"
    ) {
        return None;
    }
    let Some(host) = host else {
        return Some(Err(RpcError::new(
            LSP_HOST_UNAVAILABLE,
            "Language server support is not available in this runtime",
        )));
    };
    // Node lets a host failure reach the generic handler: -32603 with its message.
    let answer = match method {
        "lsp/preferences/get" => host.preferences().await.map(|prefs| preferences(&prefs)),
        "lsp/preferences/set" => host
            .set_preferences(patch(&params["patch"]))
            .await
            .map(|prefs| preferences(&prefs)),
        _ => host
            .status(&workspace(&params["workspace"]))
            .await
            .map(|status| {
                json!({
                    "enabled": status.enabled,
                    "servers": status.servers.iter().map(server).collect::<Vec<_>>(),
                })
            }),
    };
    Some(answer.map_err(RpcError::internal))
}

/// The protocol shape drops the storage-only `version` (Node `toProtocolPreferences`).
fn preferences(prefs: &LspPreferences) -> Value {
    json!({
        "enabled": prefs.enabled,
        "diagnosticsAfterEdit": prefs.diagnostics_after_edit,
    })
}

/// The params are already checked against `zcodeLspPreferencesSetParamsSchema`.
fn patch(value: &Value) -> LspPreferencesPatch {
    LspPreferencesPatch {
        enabled: value.get("enabled").and_then(Value::as_bool),
        diagnostics_after_edit: value
            .get("diagnosticsAfterEdit")
            .and_then(Value::as_object)
            .map(|overrides| {
                overrides
                    .iter()
                    .map(|(id, on)| (id.clone(), on.as_bool()))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

fn workspace(value: &Value) -> LspWorkspace {
    LspWorkspace {
        path: value["workspacePath"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        identity: value
            .get("workspaceIdentity")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

/// `zcodeLspServerStatusSchema`; `lastErrorCode` only when present.
fn server(entry: &LspServerStatus) -> Value {
    let mut object = Map::new();
    object.insert("serverId".into(), json!(entry.server_id));
    object.insert("pluginId".into(), json!(entry.plugin_id));
    object.insert("serverName".into(), json!(entry.server_name));
    object.insert("command".into(), json!(entry.command));
    object.insert("extensions".into(), json!(entry.extensions));
    object.insert("installed".into(), json!(entry.installed));
    object.insert("state".into(), json!(entry.state));
    object.insert("diagnosticsMode".into(), json!(entry.diagnostics_mode));
    object.insert(
        "diagnosticsAfterEdit".into(),
        json!(entry.diagnostics_after_edit),
    );
    object.insert("restarts".into(), json!(entry.restarts));
    if let Some(code) = &entry.last_error_code {
        object.insert("lastErrorCode".into(), json!(code));
    }
    Value::Object(object)
}

#[cfg(test)]
#[path = "lsp_tests.rs"]
mod tests;
