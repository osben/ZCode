//! Fork: `skills/referenceCatalog` (Node `zcode-protocol/skill-reference-catalog.ts`), the
//! read-only skill catalog of the Composer `/` panel. With a `sessionId` the session must exist
//! (an unknown one fails closed instead of falling back to the workspace) and the authority is
//! `session`; without it the workspace is scanned again on every request. zcode-rs keeps no frozen
//! per-session catalog, so both read the current discovery of the workspace.

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::user_command::SkillReference;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::server::{Server, kernel_error};

pub(super) async fn reference_catalog(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let path = params["workspace"]["workspacePath"]
        .as_str()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| RpcError::invalid_params("workspace.workspacePath is required"))?;
    let authority = match params.get("sessionId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => {
            server
                .live(&SessionId::new(id))
                .await
                .map_err(|error| kernel_error(&error))?;
            "session"
        }
        Some(_) => return Err(RpcError::invalid_params("sessionId must not be empty")),
        None => "workspace",
    };
    let skills = server
        .kernel
        .skill_references(&server.workspace(path))
        .await;
    Ok(result(authority, &skills))
}

/// `zcodeSkillsReferenceCatalogResultSchema`; the `glm:` id prefix is the UI provider filter and the
/// path keeps same-named skills from different sources apart.
pub(super) fn result(authority: &str, skills: &[SkillReference]) -> Value {
    let skills: Vec<Value> = skills
        .iter()
        .filter(|skill| !skill.name.is_empty() && !skill.path.is_empty())
        .map(|skill| {
            let scope = serde_json::to_value(skill.scope).unwrap_or(Value::Null);
            let scope_name = scope.as_str().unwrap_or("user");
            let mut entry = json!({
                "id": format!("glm:{scope_name}:{}", skill.path),
                "name": skill.name,
                "description": skill.description,
                "path": skill.path,
                "scope": scope,
                "enabled": true,
            });
            if let Some(plugin) = skill.plugin.as_deref().filter(|name| !name.is_empty()) {
                entry["pluginName"] = json!(plugin);
            }
            entry
        })
        .collect();
    json!({"authority": authority, "skills": skills})
}

#[cfg(test)]
#[path = "skills_tests.rs"]
mod tests;
