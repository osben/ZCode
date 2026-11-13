//! Fork (desktop App): the subagent snapshot from the Host (specs/fork-rust-subagent-runtime-config.md). The gate is
//! `session/requestRuntimePreferences` (`subagentRuntimeConfigEnabled`), asked once per root session; the snapshot is
//! `subagents/readRuntimeConfig`. Both are reverse requests like the credential cipher's.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::subagent_config::{
    ProfileSource, SubagentConfigSource, SubagentProfile, SubagentSnapshot,
};
use serde_json::{Value, json};

use crate::context::Context;
use crate::inbound::Inbound;

pub const PREFERENCES: &str = "session/requestRuntimePreferences";
pub const READ: &str = "subagents/readRuntimeConfig";
/// Node `ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS`, for both requests.
const LIMIT: Duration = Duration::from_secs(15);
/// JSON-RPC method not found, and the App's unsupported-capability code: a Host without the feature (Node's
/// compatibility fallback).
const NOT_OFFERED: [i64; 2] = [-32601, -32020];

/// Reads the snapshot through the Host (desktop app-server).
pub struct HostSubagentConfig {
    context: Arc<Context>,
    limit: Duration,
    /// Per root session: whether the Host offers the snapshot. Only answers are remembered, never failures.
    gates: Mutex<HashMap<SessionId, bool>>,
}

impl HostSubagentConfig {
    pub fn new(context: Arc<Context>) -> Self {
        Self::with_limit(context, LIMIT)
    }

    pub(crate) fn with_limit(context: Arc<Context>, limit: Duration) -> Self {
        Self {
            context,
            limit,
            gates: Mutex::default(),
        }
    }

    async fn ask(&self, method: &str, params: &Value) -> Result<Result<Value, i64>, String> {
        match tokio::time::timeout(self.limit, self.context.peer.request(method, params)).await {
            Err(_) => Err(format!("{method} did not reply in time")),
            Ok(Err(error)) => Ok(Err(error.code)),
            Ok(Ok(result)) => Ok(Ok(result)),
        }
    }

    async fn offered(&self, session: &SessionId, workspace: &Value) -> Result<bool, String> {
        if let Some(known) = self.gates.lock_unpoisoned().get(session) {
            return Ok(*known);
        }
        let params = json!({
            "sessionId": session.as_str(),
            "scope": "runtime-materialization",
            "workspace": workspace,
        });
        let offered = match self.ask(PREFERENCES, &params).await? {
            Err(code) if NOT_OFFERED.contains(&code) => false,
            Err(code) => return Err(format!("{PREFERENCES} failed (JSON-RPC error {code})")),
            Ok(result) => {
                Inbound::get()
                    .reply(PREFERENCES, &result)
                    .map_err(|error| format!("invalid {PREFERENCES} reply: {error}"))?;
                result["subagentRuntimeConfigEnabled"] == true
            }
        };
        self.gates
            .lock_unpoisoned()
            .insert(session.clone(), offered);
        Ok(offered)
    }
}

#[async_trait]
impl SubagentConfigSource for HostSubagentConfig {
    async fn read(&self, session: &SessionId) -> Result<Option<SubagentSnapshot>, String> {
        let workspace = self
            .context
            .workspace_of(session.as_str())
            .ok_or_else(|| "the session is not open in this agent".to_owned())?;
        let workspace = json!({"workspacePath": workspace, "workspaceKey": workspace});
        if !self.offered(session, &workspace).await? {
            return Ok(None);
        }
        let params = json!({"sessionId": session.as_str(), "workspace": workspace});
        let result = self
            .ask(READ, &params)
            .await?
            .map_err(|code| format!("{READ} failed (JSON-RPC error {code})"))?;
        Inbound::get()
            .reply(READ, &result)
            .map_err(|error| format!("invalid {READ} reply: {error}"))?;
        snapshot(&result).map(Some)
    }
}

/// A validated reply as the snapshot (rule 8).
fn snapshot(result: &Value) -> Result<SubagentSnapshot, String> {
    if result["kind"] != "ready" {
        return Ok(SubagentSnapshot::BuiltInFallback);
    }
    let profiles = result["profiles"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(profile)
        .collect::<Result<_, _>>()?;
    let overrides = &result["builtInModelSelectionOverrides"];
    Ok(SubagentSnapshot::Ready {
        profiles,
        explore: selection(&overrides["Explore"]),
        general_purpose: selection(&overrides["general-purpose"]),
    })
}

fn profile(value: &Value) -> Result<SubagentProfile, String> {
    let text = |key: &str| value[key].as_str().unwrap_or_default().to_owned();
    let names = |key: &str| {
        value[key].as_array().map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
    };
    let source = match value["source"].as_str() {
        Some("user") => ProfileSource::User,
        Some("project") => ProfileSource::Project,
        // The schema's refinement (not representable in JSON Schema): the Host never sends built-in profiles.
        _ => {
            return Err(format!(
                "invalid {READ} reply: the profile {:?} is not a user or project profile",
                text("name")
            ));
        }
    };
    Ok(SubagentProfile {
        name: text("name"),
        description: text("description"),
        source,
        system_prompt: text("systemPrompt"),
        selection: selection(&value["modelSelection"]),
        tools: names("tools"),
        disallowed_tools: names("disallowedTools").unwrap_or_default(),
        max_turns: value["maxTurns"]
            .as_u64()
            .and_then(|turns| u32::try_from(turns).ok()),
        background: value["background"] == true,
        permission_mode: value["permissionMode"]
            .as_str()
            .and_then(PermissionMode::from_cli_choice),
    })
}

/// Node `modelSelectionSchema` (zod trims the strings).
fn selection(value: &Value) -> Option<ModelSelection> {
    let provider = value["providerId"].as_str()?.trim();
    let model = value["modelId"].as_str()?.trim();
    let mut selection = ModelSelection::new(provider, model);
    selection.reasoning = value["options"]["reasoningLevel"]
        .as_str()
        .map(|level| level.trim().to_owned());
    Some(selection)
}

#[cfg(test)]
#[path = "subagent_config_tests.rs"]
mod tests;
