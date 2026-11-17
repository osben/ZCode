//! Fork: the app-provided tools of an MCP App page, held by the Node helper (specs/fork-rust-node-helper.md F3b(b)).
//! `helper/appTools/replace` (helper to Rust) sets a session's set; the registry reads it through [`AppToolHost`]. A
//! model call is `helper/appTools/call` (Rust to helper, session-scoped), and an abandoned one is
//! `helper/appTools/cancel`. A set belongs to the helper process that replaced it: when that process is gone its sets
//! are dropped, and [`NodeHelper::app_tools`] never returns a set of a process that is not running.

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_kernel_api::app_tool::{AppToolHost, AppToolSpec};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use super::NodeHelper;

pub(crate) const APP_TOOLS_REPLACE: &str = "helper/appTools/replace";
pub(crate) const APP_TOOLS_CALL: &str = "helper/appTools/call";
pub(crate) const APP_TOOLS_CANCEL: &str = "helper/appTools/cancel";

/// The sets the helper replaced, by session, with the generation of the process that replaced each.
#[derive(Default)]
pub(super) struct AppToolSets {
    by_session: HashMap<String, (u64, Vec<AppToolSpec>)>,
}

impl NodeHelper {
    /// `helper/appTools/replace {sessionId, tools}` of `generation`: the whole set of the session, answered with the
    /// names it holds. A duplicate `modelName` keeps the first entry, as Node's `replaceMcpAppProvidedTools` does.
    pub(super) fn replace_app_tools(
        &self,
        generation: u64,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let session = params
            .get("sessionId")
            .and_then(Value::as_str)
            .filter(|session| !session.is_empty())
            .ok_or_else(|| RpcError::invalid_params("sessionId is required"))?;
        let tools = params
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| RpcError::invalid_params("tools is required"))?;
        let mut specs: Vec<AppToolSpec> = Vec::new();
        for tool in tools {
            let spec = parse_spec(tool).ok_or_else(|| {
                RpcError::invalid_params("an app tool needs modelName, serverName and toolName")
            })?;
            if !specs
                .iter()
                .any(|known| known.model_name == spec.model_name)
            {
                specs.push(spec);
            }
        }
        let registered: Vec<String> = specs.iter().map(|spec| spec.model_name.clone()).collect();
        self.app_tools
            .lock_unpoisoned()
            .by_session
            .insert(session.to_owned(), (generation, specs));
        Ok(json!({"registered": registered}))
    }

    /// `generation`'s process is gone: its sets are dropped.
    pub(super) fn app_tools_lost(&self, generation: u64) {
        self.app_tools
            .lock_unpoisoned()
            .by_session
            .retain(|_, (owner, _)| *owner != generation);
    }
}

#[async_trait]
impl AppToolHost for NodeHelper {
    fn app_tools(&self, session: &SessionId) -> Vec<AppToolSpec> {
        // The entry is copied out first: the running check takes the helper's state lock, never nested in this one.
        let entry = self
            .app_tools
            .lock_unpoisoned()
            .by_session
            .get(session.as_str())
            .cloned();
        match entry {
            Some((generation, specs)) if self.with_running(generation, |_| ()) => specs,
            _ => Vec::new(),
        }
    }

    async fn call(
        &self,
        session: &SessionId,
        turn: &str,
        tool_call: &str,
        name: &str,
        input: Value,
    ) -> Result<Value, String> {
        let params = json!({
            "sessionId": session.as_str(),
            "turnId": turn,
            "toolCallId": tool_call,
            "name": name,
            "input": input,
        });
        match self.forward(APP_TOOLS_CALL, &params).await {
            Some(Ok(answer)) => Ok(answer),
            Some(Err(error)) => Err(error.to_string()),
            None => Err("app tools need the Node helper, which does not serve them".to_owned()),
        }
    }

    async fn cancel(&self, session: &SessionId, tool_call: &str) {
        // A cancel never starts the helper: with no process, the call has nothing to abandon.
        if !self.has_process() {
            return;
        }
        let params = json!({"sessionId": session.as_str(), "toolCallId": tool_call});
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            self.forward(APP_TOOLS_CANCEL, &params),
        )
        .await;
    }
}

/// One entry of `tools`, as the helper's `replaceMcpAppProvidedTools` sends it (`core/src/mcp/app-tools.ts` fields).
fn parse_spec(tool: &Value) -> Option<AppToolSpec> {
    let text = |key: &str| tool.get(key).and_then(Value::as_str).map(str::to_owned);
    let flag = |key: &str| tool.get(key).and_then(Value::as_bool) == Some(true);
    let model_name = text("modelName").filter(|name| !name.is_empty())?;
    let input_schema = tool
        .get("inputSchema")
        .filter(|schema| schema.is_object())
        .cloned()
        .unwrap_or_else(|| json!({"type": "object"}));
    Some(AppToolSpec {
        model_name,
        server_name: text("serverName").filter(|name| !name.is_empty())?,
        plugin_id: text("pluginId").unwrap_or_default(),
        tool_name: text("toolName").filter(|name| !name.is_empty())?,
        title: text("title"),
        description: text("description"),
        input_schema,
        read_only: flag("readOnlyHint"),
        destructive: flag("destructiveHint"),
        idempotent: flag("idempotentHint"),
    })
}
