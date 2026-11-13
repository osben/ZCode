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

/// `zcodeSessionResumeParamsSchema` (only the fields used here). `thoughtLevel` is not read: Node uses it for a session
/// without a stored selection, and every Rust session has one (specs/fork-rust-automations.md, slice 1 item 2).
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
/// effect) is not an error for the legacy methods. An acknowledgement without a message (a duplicate or stale one)
/// names its status and reason code instead.
fn ack_result(ack: Ack) -> Result<Option<Value>, RpcError> {
    let message = ack
        .message
        .clone()
        .filter(|message| !message.is_empty())
        .unwrap_or_else(|| {
            format!(
                "the command was {:?}: {}",
                ack.status,
                ack.reason_code.as_deref().unwrap_or("no reason")
            )
            .to_lowercase()
        });
    match ack.status {
        Status::Accepted => Ok(ack.result),
        Status::Noop => Ok(None),
        _ if ack.reason_code.as_deref() == Some("proto.invalidPayload") => {
            Err(RpcError::invalid_params(message))
        }
        _ => Err(RpcError::internal(message)),
    }
}

/// A fresh command id per legacy call: the session actor dedupes command ids for its whole lifetime, so an id built
/// from the method and the session would answer a repeated switch `Duplicate`.
fn command_id(method: &str) -> String {
    format!(
        "legacy:{method}:{:016x}{:016x}",
        rust_cli_base::random::u64(),
        rust_cli_base::random::u64()
    )
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
    // `thoughtLevel` is the reasoning level of the requested model (the Host sends the selection's own level); without
    // a model it is the level of the default model, the one the create picks anyway.
    let mut model = match params.model.clone() {
        Some(model) if !model.is_object() => {
            return Err(RpcError::invalid_params("model must be an object"));
        }
        Some(model) => Some(model),
        None => params.thought_level.as_ref().map(|_| {
            let chosen = &server.defaults.selection;
            json!({"providerId": chosen.provider, "modelId": chosen.model})
        }),
    };
    if let (Some(model), Some(level)) = (
        model.as_mut().and_then(Value::as_object_mut),
        params.thought_level.as_deref(),
    ) {
        model.insert("options".to_owned(), json!({"reasoningLevel": level}));
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
    // Node refuses any id that already exists (`createSessionWith`); the v4 route would also let a retry re-create an
    // empty stored session, which the legacy method does not. The strict check runs with the create under the
    // reservation gate, so a concurrent create of the same id cannot slip between them.
    let command = command_id("session/create");
    let ack = crate::commands::create_session_with(
        server,
        &envelope("createSession", command.clone(), None, payload),
        crate::commands::Existing::Refuse,
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
            // No error text: a storage error can name the storage path.
            tracing::warn!(event = "legacy.session_create.persist_failed", session = %id, error = %error, "persisting the created session failed");
            // Leave no half-created id behind, so a retry with the same id is not refused as existing: drop the draft
            // and the runtime like a deferred `session/close`, which also reports the session unloaded.
            let _ = queries.discard_draft(&id).await;
            server.bridge.close(&id);
            live.handle.close(EndReason::Other).await;
            server.announce_lifecycle(&id, "unloaded").await;
            return Err(RpcError::internal("persisting the created session failed"));
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

/// The v4 command `kind` for the session, after the v4 route guard: a session whose prepared worktree is not active
/// yet refuses it like v4 `decide`, before the session is opened (an open would start it at the parent checkout).
async fn opened(
    server: &Server,
    id: &SessionId,
    kind: &str,
    method: &str,
    payload: Value,
) -> Result<(Envelope, std::sync::Arc<Bridged<Live>>), RpcError> {
    let request = envelope(kind, command_id(method), Some(id), payload);
    if let Some(ack) =
        crate::worktree::refuse_before_activation(server, &request, id.as_str()).await
    {
        ack_result(ack)?;
    }
    let live = server
        .live(id)
        .await
        .map_err(|error| kernel_error(&error))?;
    Ok((request, live))
}

/// Node `setMode` through the v4 `switchCollaborationMode` rule (the Host uses it for `auto`).
pub(crate) async fn set_mode(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = super::methods::session_id(params)?;
    let mode = params["mode"].as_str().unwrap_or_default();
    let (request, live) = opened(
        server,
        &id,
        "switchCollaborationMode",
        "session/setMode",
        json!({"mode": mode}),
    )
    .await?;
    ack_result(super::session_config::switch_mode(&live, &request, 0).await)?;
    crate::legacy::read(server, &snapshot_params(&id)).await
}

/// Node `setThoughtLevel`: the reasoning level of the session's current model (v4 `switchModelConfig`, same model).
/// The model is the session's own, not the projection's: the projection learns of a `setModel` just applied only
/// when its event arrives, and a stale model here would switch the model back.
pub(crate) async fn set_thought_level(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = super::methods::session_id(params)?;
    let thought = params["thoughtLevel"].as_str().unwrap_or_default();
    // The payload's model is filled in once the session is open.
    let (mut request, live) = opened(
        server,
        &id,
        "switchModelConfig",
        "session/setThoughtLevel",
        Value::Null,
    )
    .await?;
    let current = match live.handle.view().await {
        Ok(view) => view.selection,
        Err(_) => live.sink.current_config().0,
    };
    request.payload =
        json!({"provider": current.provider, "model": current.model, "thought": thought});
    ack_result(super::session_config::switch_model(&live, &request, 0).await)?;
    crate::legacy::read(server, &snapshot_params(&id)).await
}

/// Node `setModel` through the v4 `switchModelConfig` rule.
pub(crate) async fn set_model(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let id = super::methods::session_id(params)?;
    let Some(selection) = crate::commands::selection(Some(&params["model"])) else {
        return Err(RpcError::invalid_params("model is required"));
    };
    let payload = json!({
        "provider": selection.provider,
        "model": selection.model,
        "thought": selection.reasoning.unwrap_or_default(),
    });
    let (request, live) = opened(
        server,
        &id,
        "switchModelConfig",
        "session/setModel",
        payload,
    )
    .await?;
    ack_result(super::session_config::switch_model(&live, &request, 0).await)?;
    crate::legacy::read(server, &snapshot_params(&id)).await
}

#[cfg(test)]
#[path = "legacy_session_tests.rs"]
mod tests;
