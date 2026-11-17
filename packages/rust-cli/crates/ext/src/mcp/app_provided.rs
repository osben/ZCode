//! Fork: the app-provided tools of an MCP App page (specs/fork-rust-node-helper.md F3b(b)). The helper replaces a session's
//! set with `helper/appTools/replace`; the registry lists the set in the session's snapshot, and a model call goes to the
//! helper (`helper/appTools/call`). Node's `createMcpAppProvidedToolEntry` (core `mcp/app-tools.ts`) is the reference.

use std::borrow::Cow;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::app_tool::{AppToolHost, AppToolSpec};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp::McpToolInfo;
use rust_cli_kernel_api::message::ToolResultContent;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, failed,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::config::McpSettings;
use super::result;

/// The tools `session` sees from the host's overlay, in the order the helper replaced them.
pub fn app_provided_tools(host: &Arc<dyn AppToolHost>, session: &SessionId) -> Vec<Arc<dyn Tool>> {
    host.app_tools(session)
        .into_iter()
        .map(|spec| {
            let info = McpToolInfo {
                server: spec.server_name.clone(),
                tool: spec.tool_name.clone(),
                // Node lists an app tool directly, never deferred behind ToolSearch.
                always_load: true,
            };
            Arc::new(AppTool {
                spec,
                info,
                host: host.clone(),
            }) as Arc<dyn Tool>
        })
        .collect()
}

/// One app-provided tool. Its permission is the pipeline's, as for an MCP tool: a read-only tool is allowed without
/// asking, the others ask, and the session-only "always allow" is offered (`allow_session`), because the same
/// `app__` name is reused by other pages in other sessions.
pub(crate) struct AppTool {
    spec: AppToolSpec,
    info: McpToolInfo,
    host: Arc<dyn AppToolHost>,
}

#[async_trait]
impl Tool for AppTool {
    fn name(&self) -> &str {
        &self.spec.model_name
    }

    fn cancel_message(&self) -> Option<Cow<'_, str>> {
        Some(Cow::Owned(format!(
            "App tool {} was cancelled",
            self.spec.model_name
        )))
    }

    fn input_schema(&self) -> Value {
        object_schema(&self.spec.input_schema)
    }

    fn description(&self, _context: &PromptContext) -> String {
        let title = self
            .spec
            .title
            .as_deref()
            .filter(|title| *title != self.spec.tool_name);
        let footer = format!(
            "(Tool provided by the {} app page; available only while the app is open.)",
            self.spec.server_name
        );
        [
            title,
            self.spec.description.as_deref(),
            Some(footer.as_str()),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        self.spec.read_only
    }

    fn is_destructive(&self, _input: &Value) -> bool {
        self.spec.destructive
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        self.spec.read_only || self.spec.idempotent
    }

    fn allow_session(&self) -> bool {
        true
    }

    fn mcp_info(&self) -> Option<&McpToolInfo> {
        Some(&self.info)
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let arguments = if input.is_object() { input } else { json!({}) };
        let turn = context.run.as_str().to_owned();
        let tool_call = context.tool_use.as_str().to_owned();
        let request = self.host.call(
            &context.session,
            &turn,
            &tool_call,
            &self.spec.model_name,
            arguments,
        );
        let answer = tokio::select! {
            answer = request => answer,
            () = context.cancel.cancelled() => {
                // The helper abandons the call too; its cancel is a notification, nothing waits for it.
                self.host.cancel(&context.session, &tool_call).await;
                return Err(ToolError::Cancelled);
            }
        };
        let value = answer.map_err(failed)?;
        output_of(&value, &self.spec.server_name, &self.spec.tool_name)
    }
}

/// Node's `normalizeObjectSchema`: an object schema whose `properties` is always an object.
fn object_schema(schema: &Value) -> Value {
    let mut out = if schema.is_object() {
        schema.clone()
    } else {
        json!({})
    };
    let properties = schema
        .get("properties")
        .filter(|properties| properties.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    if let Value::Object(map) = &mut out {
        map.insert("type".to_owned(), json!("object"));
        map.insert("properties".to_owned(), properties);
    }
    out
}

/// The helper's MCP-shaped answer, mapped as an MCP tool's result is: a server error is the error text, a result is its
/// content, truncated to the MCP output budget.
fn output_of(value: &Value, server: &str, tool: &str) -> Result<ToolOutput, ToolError> {
    if let Some(message) = result::error_text(value) {
        return Ok(ToolOutput {
            content: vec![ToolResultContent::Text { text: message }],
            is_error: true,
            display: Value::Null,
        });
    }
    let content = result::transform(value, server).ok_or_else(|| {
        failed(format!(
            "App tool \"{tool}\" of \"{server}\": unexpected response format"
        ))
    })?;
    Ok(ToolOutput {
        content: result::truncate(content, McpSettings::default().max_output_tokens),
        is_error: false,
        display: Value::Null,
    })
}

#[cfg(test)]
#[path = "app_provided_tests.rs"]
mod tests;
