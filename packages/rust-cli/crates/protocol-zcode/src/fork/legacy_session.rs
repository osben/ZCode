//! Fork: the legacy `session/create`, `session/resume`, `session/setMode`, `session/setThoughtLevel` and
//! `session/setModel` methods the desktop Host still uses to run scheduled automations (Host `dispatchCronRun`,
//! specs/fork-rust-automations.md, slice 1). Each one reuses the v4 path that already owns the behaviour (createSession,
//! the session opening, switchCollaborationMode / switchModelConfig) and answers the legacy snapshot of
//! [`crate::legacy::read`].

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::{Command, EndReason};
use rust_cli_protocol_core::rpc::RpcError;
use rust_cli_protocol_core::sessions::Bridged;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::commands::send;
use crate::inbox::{Ack, Envelope, Status};
use crate::live::Live;
use crate::server::{Server, kernel_error};

/// `zcodeSessionCreateParamsSchema` (the schema already checked the shape; only the fields used here).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    session_id: Option<String>,
    workspace: WorkspaceParam,
    mode: Option<String>,
    model: Option<Value>,
    persistence: Option<String>,
    thought_level: Option<String>,
    title_generation_enabled: Option<bool>,
    #[serde(default)]
    tool_allowlist: Vec<String>,
    #[serde(default)]
    tool_denylist: Vec<String>,
    imported_history: Option<Value>,
    parent_session_id: Option<String>,
    execution_worktree: Option<Value>,
    incognito: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceParam {
    workspace_path: String,
}

/// `zcodeSessionResumeParamsSchema` (only the fields used here).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResumeParams {
    session_id: String,
    #[serde(default)]
    tool_allowlist: Vec<String>,
    #[serde(default)]
    tool_denylist: Vec<String>,
}

fn parse<P: serde::de::DeserializeOwned>(params: &Value) -> Result<P, RpcError> {
    serde_json::from_value(params.clone())
        .map_err(|error| RpcError::invalid_params(error.to_string()))
}

/// Fields this agent cannot honour refuse the request instead of being dropped: a tool surface limit, imported history,
/// a parent session and an execution worktree change what the session may do or what it holds. The message names
/// no unrecognized key, so the Host's compatibility retry (which drops unrecognized keys) does not run without them.
fn unsupported(field: &str) -> RpcError {
    RpcError::invalid_params(format!("{field} is not supported by this agent"))
}

fn check_tool_lists(allow: &[String], deny: &[String]) -> Result<(), RpcError> {
    if !allow.is_empty() {
        return Err(unsupported("toolAllowlist"));
    }
    if !deny.is_empty() {
        return Err(unsupported("toolDenylist"));
    }
    Ok(())
}

/// A refused v4 acknowledgement as the legacy method's error. `config.unchanged` (a switch to the value already in
/// effect) is not an error for the legacy methods.
fn ack_result(ack: Ack) -> Result<Option<Value>, RpcError> {
    let message = ack.message.clone().unwrap_or_default();
    match ack.status {
        Status::Accepted => Ok(ack.result),
        Status::Noop => Ok(None),
        _ if ack.reason_code.as_deref() == Some("proto.invalidPayload") => {
            Err(RpcError::invalid_params(message))
        }
        _ => Err(RpcError::internal(message)),
    }
}

fn envelope(
    kind: &str,
    command_id: String,
    session: Option<&SessionId>,
    payload: Value,
) -> Envelope {
    Envelope {
        command_id,
        client_id: "legacy-session".to_owned(),
        session_id: session.map(|session| session.as_str().to_owned()),
        base_revision: None,
        kind: kind.to_owned(),
        payload,
        input_origin: None,
    }
}

fn snapshot_params(session: &SessionId) -> Value {
    json!({"sessionId": session.as_str()})
}

/// Node `createSession`: the session is created like a v4 `createSession` without a first input and stays a draft
/// until the first accepted input persists it (`persistence: "deferred"`); `"immediate"`, Node's default, persists it
/// here.
pub(crate) async fn create(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params: CreateParams = parse(params)?;
    check_tool_lists(&params.tool_allowlist, &params.tool_denylist)?;
    if params.imported_history.is_some() {
        return Err(unsupported("importedHistory"));
    }
    if params.parent_session_id.is_some() {
        return Err(unsupported("parentSessionId"));
    }
    if params.execution_worktree.is_some() {
        return Err(unsupported("executionWorktree"));
    }
    // `thoughtLevel` is the reasoning level of the requested model (the Host sends the selection's own level).
    let mut model = params.model.clone();
    if let (Some(model), Some(level)) = (model.as_mut(), params.thought_level.as_deref()) {
        model["options"] = json!({"reasoningLevel": level});
    }
    let mut config = json!({});
    if let Some(model) = model {
        config["modelSelection"] = model;
    }
    if let Some(mode) = &params.mode {
        config["mode"] = json!(mode);
    }
    let mut payload = json!({"workspaceId": params.workspace.workspace_path, "config": config});
    if let Some(id) = &params.session_id {
        payload["sessionId"] = json!(id);
    }
    if let Some(incognito) = &params.incognito {
        payload["incognito"] = incognito.clone();
    }
    // Node refuses any id that already exists (`createSessionWith`); the v4 route below would also let a retry
    // re-create an empty stored session, which the legacy method does not. A soft-deleted id is refused there.
    if let Some(id) = params.session_id.as_deref() {
        let id = SessionId::new(id);
        let stored = server.bridge.get(&id).is_some()
            || crate::preparation::absent_if_not_found(server.kernel.session_snapshot(&id).await)
                .map_err(|error| kernel_error(&error))?
                .is_some();
        if stored {
            return Err(RpcError::invalid_params("sessionId already exists"));
        }
    }
    let command = format!(
        "legacy:session/create:{}",
        params.session_id.as_deref().unwrap_or("new")
    );
    let ack = crate::commands::create_session(
        server,
        &envelope("createSession", command.clone(), None, payload),
    )
    .await;
    let result = ack_result(ack)?.unwrap_or_default();
    let Some(id) = result["sessionId"].as_str().filter(|id| !id.is_empty()) else {
        return Err(RpcError::internal("createSession answered no session id"));
    };
    let id = SessionId::new(id);
    let live = server
        .live(&id)
        .await
        .map_err(|error| kernel_error(&error))?;
    if params.title_generation_enabled == Some(false) {
        send(
            live.handle.as_ref(),
            &format!("{command}#titles"),
            Command::DisableTitleGeneration,
        )
        .await;
    }
    if params.persistence.as_deref() != Some("deferred") {
        let queries = server.kernel.queries();
        if let Err(error) = queries.persist_for_input(&id, "").await {
            // Leave no half-created id behind, so a retry with the same id is not refused as existing: drop the draft
            // and the runtime like a deferred `session/close`.
            let _ = queries.discard_draft(&id).await;
            server.bridge.close(&id);
            live.handle.close(EndReason::Other).await;
            return Err(RpcError::internal(error.to_string()));
        }
    }
    crate::legacy::read(server, &snapshot_params(&id)).await
}

/// Node `resumeSession`: opens a stored session (cold) or takes the live one, and answers its snapshot. A missing
/// session answers the same error as `session/read`.
pub(crate) async fn resume(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params: ResumeParams = parse(params)?;
    check_tool_lists(&params.tool_allowlist, &params.tool_denylist)?;
    let id = SessionId::new(params.session_id);
    server
        .live(&id)
        .await
        .map_err(|error| kernel_error(&error))?;
    crate::legacy::read(server, &snapshot_params(&id)).await
}

async fn opened(
    server: &Server,
    params: &Value,
) -> Result<(SessionId, std::sync::Arc<Bridged<Live>>), RpcError> {
    let id = super::methods::session_id(params)?;
    let live = server
        .live(&id)
        .await
        .map_err(|error| kernel_error(&error))?;
    Ok((id, live))
}

/// Node `setMode` through the v4 `switchCollaborationMode` rule (the Host uses it for `auto`).
pub(crate) async fn set_mode(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let (id, live) = opened(server, params).await?;
    let mode = params["mode"].as_str().unwrap_or_default();
    let command = format!("legacy:session/setMode:{}", id.as_str());
    let request = envelope(
        "switchCollaborationMode",
        command,
        Some(&id),
        json!({"mode": mode}),
    );
    ack_result(super::session_config::switch_mode(&live, &request, 0).await)?;
    crate::legacy::read(server, &snapshot_params(&id)).await
}

/// Node `setThoughtLevel`: the reasoning level of the session's current model (v4 `switchModelConfig`, same model).
pub(crate) async fn set_thought_level(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let (id, live) = opened(server, params).await?;
    let (current, _, _) = live.sink.current_config();
    let thought = params["thoughtLevel"].as_str().unwrap_or_default();
    let command = format!("legacy:session/setThoughtLevel:{}", id.as_str());
    let payload = json!({"provider": current.provider, "model": current.model, "thought": thought});
    let request = envelope("switchModelConfig", command, Some(&id), payload);
    ack_result(super::session_config::switch_model(&live, &request, 0).await)?;
    crate::legacy::read(server, &snapshot_params(&id)).await
}

/// Node `setModel` through the v4 `switchModelConfig` rule.
pub(crate) async fn set_model(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let (id, live) = opened(server, params).await?;
    let Some(selection) = crate::commands::selection(Some(&params["model"])) else {
        return Err(RpcError::invalid_params("model is required"));
    };
    let command = format!("legacy:session/setModel:{}", id.as_str());
    let payload = json!({
        "provider": selection.provider,
        "model": selection.model,
        "thought": selection.reasoning.unwrap_or_default(),
    });
    let request = envelope("switchModelConfig", command, Some(&id), payload);
    ack_result(super::session_config::switch_model(&live, &request, 0).await)?;
    crate::legacy::read(server, &snapshot_params(&id)).await
}

#[cfg(test)]
#[path = "legacy_session_tests.rs"]
mod tests;
