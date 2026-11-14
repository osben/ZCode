//! Fork: the `LSP` agent tool (specs/fork-rust-lsp.md "Tool (D2)"), a port of Node's `tool/handlers/lsp.ts`.
//!
//! The tool checks the input rules the schema cannot express, resolves `filePath` against the session's current
//! directory and asks the code-intelligence runtime ([`CodeIntelligence::query`]). Its visibility is owned by
//! [`LspTools`]: a session sees it only while the runtime offers it (`CodeIntelligence::tool_offered`).

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::lsp::{CodeIntelligence, LspOperation, LspQuery};
use rust_cli_kernel_api::mcp_state::McpConnections;
use rust_cli_kernel_api::message::ToolResultContent;
use rust_cli_kernel_api::orchestration::{ToolRegistry, ToolSnapshot};
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext, answers_to, failed,
    parse,
};
use rust_cli_kernel_api::tool_names;
use rust_cli_prompts::Definition;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::common::{cwd, style};

pub const NAME: &str = tool_names::LSP;
/// Node `LSP_TOOL_TIMEOUT_MS`: one deadline for the whole handler.
const TIMEOUT: Duration = Duration::from_millis(65_000);
/// Node `LSP_MODEL_MAX_BYTES`: the result budget in UTF-8 bytes.
const MAX_RESULT_BYTES: usize = 100_000;

const NOT_CONFIGURED: &str = "LSP service is not configured for the LSP tool";
const EMPTY_PATH: &str = "Tool path must not be empty";

/// Node `LspInputSchema` (`z.object`, unknown keys stripped).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    operation: LspOperation,
    file_path: String,
    line: Option<f64>,
    character: Option<f64>,
    symbol: Option<String>,
    query: Option<String>,
    include_declaration: Option<bool>,
}

impl Input {
    fn into_query(self) -> LspQuery {
        LspQuery {
            operation: self.operation,
            file_path: self.file_path,
            line: self.line,
            character: self.character,
            symbol: self.symbol,
            query: self.query,
            include_declaration: self.include_declaration,
        }
    }
}

/// Node `validateOperationInput`: the rules run before the runtime is consulted.
fn check_rules(input: &Input) -> Result<(), String> {
    let operation = input.operation.as_str();
    if input.operation == LspOperation::WorkspaceSymbol {
        if input.query.as_deref().is_none_or(str::is_empty) {
            return Err("workspaceSymbol requires query".to_owned());
        }
        return Ok(());
    }
    if !input.operation.positional() {
        return Ok(());
    }
    if input.line.is_none() {
        return Err(format!("{operation} requires line"));
    }
    if input.character.is_some() == input.symbol.is_some() {
        return Err(format!(
            "{operation} requires exactly one of character or symbol"
        ));
    }
    Ok(())
}

pub struct LspTool {
    definition: Definition,
    code: Arc<dyn CodeIntelligence>,
}

impl LspTool {
    pub fn new(code: Arc<dyn CodeIntelligence>) -> Self {
        Self {
            definition: rust_cli_prompts::definition(NAME).clone(),
            code,
        }
    }

    async fn run(&self, input: &Value, context: &ToolUseContext) -> Result<ToolOutput, ToolError> {
        let input: Input = parse(input)?;
        check_rules(&input).map_err(failed)?;
        // Node builds subagent runtimes without the service; the runtime serves only the session's own machine.
        if context.agent.is_some() || context.machine.name().remote().is_some() {
            return Err(failed(NOT_CONFIGURED.to_owned()));
        }
        if input.file_path.is_empty() {
            return Err(failed(EMPTY_PATH.to_owned()));
        }
        let mut query = input.into_query();
        // Node `path.resolve`: no `~` expansion.
        query.file_path = style(context).resolve(&cwd(context).await, &query.file_path, None);
        let output = self
            .code
            .query(&context.session, &context.workspace, query, &context.cancel)
            .await
            .map_err(|error| failed(error.message))?;
        Ok(ToolOutput {
            content: vec![ToolResultContent::Text {
                text: output.model_text(),
            }],
            is_error: false,
            display: serde_json::to_value(&output).unwrap_or(Value::Null),
        })
    }
}

#[async_trait]
impl Tool for LspTool {
    fn name(&self) -> &str {
        NAME
    }

    fn input_schema(&self) -> Value {
        self.definition.schema.clone()
    }

    fn strips_unknown_keys(&self) -> bool {
        true
    }

    fn description(&self, _context: &PromptContext) -> String {
        self.definition.description.clone()
    }

    fn should_defer(&self) -> bool {
        true
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn result_budget_bytes(&self) -> Option<usize> {
        Some(MAX_RESULT_BYTES)
    }

    /// Node `permission/service.ts`: whole-tool rules apply first; content rules match none of the tool's keys
    /// (`filePath` is not a rule field), and `checkBuildMode` allows a read-only tool without approval in every mode.
    /// So no path is asked, the workspace's outside included.
    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        tokio::time::timeout(TIMEOUT, self.run(&input, &context))
            .await
            .unwrap_or_else(|_| {
                Err(failed(format!(
                    "Tool execution timed out after {}ms",
                    TIMEOUT.as_millis()
                )))
            })
    }
}

/// The registry layer that owns the tool's visibility: it adds `LSP` to a session's snapshot and resolves it for that
/// session only while the runtime offers it. Lookups without a session never see it, so a subagent filter or a
/// sessionless caller cannot reach it through `tools` / `find`.
pub struct LspTools {
    inner: Arc<dyn ToolRegistry>,
    tool: Arc<dyn Tool>,
    code: Arc<dyn CodeIntelligence>,
}

impl LspTools {
    pub fn new(inner: Arc<dyn ToolRegistry>, code: Arc<dyn CodeIntelligence>) -> Self {
        Self {
            inner,
            tool: Arc::new(LspTool::new(code.clone())),
            code,
        }
    }
}

impl ToolRegistry for LspTools {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.inner.tools()
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner.find(name)
    }

    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        if answers_to(self.tool.as_ref(), name) {
            return self.code.tool_offered(session).then(|| self.tool.clone());
        }
        self.inner.find_for(session, name)
    }

    /// Hidden means not offered, never "withheld for a fallback": no child may restore it by name.
    fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
        if answers_to(self.tool.as_ref(), name) {
            return None;
        }
        self.inner.withheld(name)
    }

    fn hides(&self, name: &str) -> bool {
        self.inner.hides(name)
    }

    fn keeps_order(&self) -> bool {
        self.inner.keeps_order()
    }

    fn snapshot(&self, session: &SessionId) -> ToolSnapshot {
        let mut snapshot = self.inner.snapshot(session);
        if self.code.tool_offered(session) {
            snapshot.tools.push(self.tool.clone());
        }
        snapshot
    }

    fn mcp(&self) -> Option<Arc<dyn McpConnections>> {
        self.inner.mcp()
    }
}

#[cfg(test)]
#[path = "lsp_tool_tests.rs"]
mod tests;
