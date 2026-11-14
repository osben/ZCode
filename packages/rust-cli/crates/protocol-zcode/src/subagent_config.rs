//! Fork (desktop App): the subagent snapshot from the Host (specs/fork-rust-subagent-runtime-config.md). The gate is
//! `session/requestRuntimePreferences` (`subagentRuntimeConfigEnabled`), asked once per root session; the snapshot is
//! `subagents/readRuntimeConfig`. Both are reverse requests like the credential cipher's.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
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

    /// `Ok(Err((code, message)))` is the Host's JSON-RPC error. A Host that promised the attach acknowledgement drops
    /// reverse requests sent before it, so the wait for it is part of the same bound (as the credential cipher's);
    /// `ready` records inside the bound that the wait ended, so the timeout names the right step.
    async fn ask(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<Result<Value, (i64, String)>, String> {
        let ready = AtomicBool::new(false);
        let answer = tokio::time::timeout(self.limit, async {
            self.context.host_ready().await;
            ready.store(true, Ordering::SeqCst);
            self.context.peer.request(method, params).await
        })
        .await;
        match answer {
            Err(_) if !ready.load(Ordering::SeqCst) => Err(format!(
                "the host did not acknowledge the attach in time before {method}"
            )),
            Err(_) => Err(format!("{method} did not reply in time")),
            Ok(Err(error)) => Ok(Err((error.code, error.message))),
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
            Err((code, _)) if NOT_OFFERED.contains(&code) => false,
            Err((code, message)) => {
                return Err(format!(
                    "{PREFERENCES} failed (JSON-RPC error {code}: {message})"
                ));
            }
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
            .workspace_ref(session.as_str())
            .ok_or_else(|| "the session is not open in this agent".to_owned())?;
        if !self.offered(session, &workspace).await? {
            return Ok(None);
        }
        let params = json!({"sessionId": session.as_str(), "workspace": workspace});
        let result = self.ask(READ, &params).await?.map_err(|(code, message)| {
            format!("{READ} failed (JSON-RPC error {code}: {message})")
        })?;
        Inbound::get()
            .reply(READ, &result)
            .map_err(|error| format!("invalid {READ} reply: {error}"))?;
        snapshot(&result).map(Some)
    }

    fn forget(&self, session: &SessionId) {
        self.gates.lock_unpoisoned().remove(session);
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
        explore: selection(&overrides["Explore"])?,
        general_purpose: selection(&overrides["general-purpose"])?,
        plugins: result["pluginAgentModelSelectionOverrides"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(key, value)| match selection(value) {
                Ok(found) => found.map(|found| Ok((key.clone(), found))),
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<_, _>>()?,
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
        selection: selection(&value["modelSelection"])?,
        tools: names("tools"),
        disallowed_tools: names("disallowedTools").unwrap_or_default(),
        // Node's schema has no upper bound: a larger limit stays a limit (the largest), never "unlimited".
        max_turns: value["maxTurns"]
            .as_u64()
            .map(|turns| u32::try_from(turns).unwrap_or(u32::MAX)),
        background: value["background"] == true,
        inject_agents_md: value["injectAgentsMd"] != false,
        permission_mode: value["permissionMode"]
            .as_str()
            .and_then(PermissionMode::from_cli_choice),
    })
}

/// Node `modelSelectionSchema`: each string is trimmed and must then be non-empty (`trim().min(1)`), or the whole
/// reply fails to parse. JSON Schema cannot say "non-empty after trimming", so the inbound check lets it through.
fn selection(value: &Value) -> Result<Option<ModelSelection>, String> {
    let (Some(provider), Some(model)) = (value["providerId"].as_str(), value["modelId"].as_str())
    else {
        return Ok(None);
    };
    let level = value["options"]["reasoningLevel"].as_str();
    for (field, text) in [
        ("providerId", Some(provider)),
        ("modelId", Some(model)),
        ("options.reasoningLevel", level),
    ] {
        if text.is_some_and(|text| text.trim().is_empty()) {
            return Err(format!(
                "invalid {READ} reply: a model selection has a blank {field}"
            ));
        }
    }
    let mut selection = ModelSelection::new(provider.trim(), model.trim());
    selection.reasoning = level.map(|level| level.trim().to_owned());
    Ok(Some(selection))
}

#[cfg(test)]
#[path = "subagent_config_tests.rs"]
mod tests;
