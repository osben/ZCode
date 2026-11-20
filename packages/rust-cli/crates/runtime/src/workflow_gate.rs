//! Fork: the dynamic-workflow tools behind the per-session gate (Node `resolveRuntimeDynamicWorkflowToolsIncluded`,
//! `core/src/runtime/helpers/tool-allowlist.ts`; specs/fork-rust-workflow-engine.md, W7-1).
//!
//! The base registry is the same for every session. This wrapper adds the workflow tools to a session's view only when
//! that session's recorded gate is open, and fails closed everywhere the session is unknown: `tools()` and `find()`
//! (no session) never see them. On-demand mode wraps each tool so that it reports `should_defer`, which hides it from
//! the model until ToolSearch loads it.

use std::borrow::Cow;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::dynamic_workflow::{DynamicWorkflowGate, DynamicWorkflowGates};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp::McpToolInfo;
use rust_cli_kernel_api::mcp_state::McpConnections;
use rust_cli_kernel_api::orchestration::{ToolRegistry, ToolSnapshot};
use rust_cli_kernel_api::permission::PermissionDecision;
use rust_cli_kernel_api::tool::{
    InterruptBehavior, PromptContext, Tool, ToolCallOutput, ToolError, ToolOutput, ToolProgress,
    ToolUseContext, Validation, answers_to,
};
use serde_json::Value;
use tokio::sync::mpsc;

/// The base registry plus the session-gated workflow tools.
pub struct GatedRegistry {
    base: Arc<dyn ToolRegistry>,
    gates: Arc<dyn DynamicWorkflowGates>,
    workflow: Vec<Arc<dyn Tool>>,
}

impl GatedRegistry {
    pub fn new(
        base: Arc<dyn ToolRegistry>,
        gates: Arc<dyn DynamicWorkflowGates>,
        workflow: Vec<Arc<dyn Tool>>,
    ) -> Self {
        Self {
            base,
            gates,
            workflow,
        }
    }

    /// The workflow tools one session sees: none unless its record opens the gate (no record is closed).
    fn visible(&self, session: &SessionId) -> Vec<Arc<dyn Tool>> {
        let Some(gate) = self.gates.gate(session).filter(|gate| gate.enabled) else {
            return Vec::new();
        };
        self.workflow
            .iter()
            .map(|tool| -> Arc<dyn Tool> {
                if gate.tools_on_demand {
                    Arc::new(OnDemand {
                        inner: tool.clone(),
                    })
                } else {
                    tool.clone()
                }
            })
            .collect()
    }

    fn is_workflow(&self, name: &str) -> bool {
        self.workflow
            .iter()
            .any(|tool| answers_to(tool.as_ref(), name))
    }
}

impl ToolRegistry for GatedRegistry {
    /// Session-less: the workflow tools are never listed here (fail closed).
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.base.tools()
    }

    /// Session-less: the workflow tools are never found here (fail closed).
    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.base.find(name)
    }

    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        if self.is_workflow(name) {
            return self
                .visible(session)
                .into_iter()
                .find(|tool| answers_to(tool.as_ref(), name));
        }
        self.base.find_for(session, name)
    }

    fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.base.withheld(name)
    }

    fn hides(&self, name: &str) -> bool {
        self.base.hides(name)
    }

    fn keeps_order(&self) -> bool {
        self.base.keeps_order()
    }

    fn snapshot(&self, session: &SessionId) -> ToolSnapshot {
        let mut snapshot = self.base.snapshot(session);
        snapshot.tools.extend(self.visible(session));
        snapshot
    }

    fn mcp(&self) -> Option<Arc<dyn McpConnections>> {
        self.base.mcp()
    }

    fn mcp_for(&self, session: &SessionId) -> Option<Arc<dyn McpConnections>> {
        self.base.mcp_for(session)
    }
}

/// Fork (W7-7a, 9.36; W7-8d, 9.39; W7-9, 9.40): the workflow tools wired in this build, in Node's order: CreateWorkflow
/// (with the analyzer and the run sessions), SaveWorkflow (with the analyzer), the run tools (ListWorkflowRuns,
/// ResumeWorkflowRun, ResolveWorkflowQuestion) through `runs`, then ListSavedWorkflows. EvalWorkflowSnippet is not offered:
/// its reads are rooted at the process workspace, not at the session's directory (9.36, divergence 313).
pub fn wired_workflow_tools(
    analyzer: Option<Arc<dyn rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer>>,
    home: &std::path::Path,
    runs: Arc<dyn rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions>,
) -> Vec<Arc<dyn Tool>> {
    let mut tools: Vec<Arc<dyn Tool>> =
        rust_cli_tools::workflow_tools(analyzer, home.to_path_buf(), Some(runs.clone()), None);
    let list_saved = tools
        .iter()
        .position(|tool| tool.name() == rust_cli_kernel_api::tool_names::LIST_SAVED_WORKFLOWS)
        .unwrap_or(tools.len());
    tools.splice(
        list_saved..list_saved,
        rust_cli_tools::workflow_run_tools(runs),
    );
    tools
}

/// Fork (W7-7a, divergence 55): the gate source with Node's incognito `automationTools` toggle in it
/// (`resolveRuntimeDynamicWorkflowToolsIncluded`). A session whose incognito profile excludes automation tools is closed
/// whatever its record says. The profile is read at each call, so a profile recorded after the record still applies.
pub struct AutomationGated {
    inner: Arc<dyn DynamicWorkflowGates>,
    incognito: rust_cli_kernel_api::incognito::IncognitoProfiles,
}

impl AutomationGated {
    pub fn new(
        inner: Arc<dyn DynamicWorkflowGates>,
        incognito: rust_cli_kernel_api::incognito::IncognitoProfiles,
    ) -> Self {
        Self { inner, incognito }
    }
}

impl DynamicWorkflowGates for AutomationGated {
    fn gate(&self, session: &SessionId) -> Option<DynamicWorkflowGate> {
        let excluded = self.incognito.excludes(
            session,
            rust_cli_kernel_api::incognito::IncognitoKey::AutomationTools,
        );
        if excluded {
            return None;
        }
        self.inner.gate(session)
    }
}

/// On-demand: the same tool, deferred until ToolSearch loads it.
struct OnDemand {
    inner: Arc<dyn Tool>,
}

#[async_trait]
impl Tool for OnDemand {
    fn name(&self) -> &str {
        self.inner.name()
    }

    fn input_schema(&self) -> Value {
        self.inner.input_schema()
    }

    fn strips_unknown_keys(&self) -> bool {
        self.inner.strips_unknown_keys()
    }

    fn description(&self, context: &PromptContext) -> String {
        self.inner.description(context)
    }

    fn rewrite_input(&self, input: &Value) -> Option<Value> {
        self.inner.rewrite_input(input)
    }

    fn allow_session(&self) -> bool {
        self.inner.allow_session()
    }

    fn is_enabled(&self) -> bool {
        self.inner.is_enabled()
    }

    fn machine_param(&self) -> rust_cli_kernel_api::machine_param::MachineParam {
        self.inner.machine_param()
    }

    fn needs_native_web_search(&self) -> bool {
        self.inner.needs_native_web_search()
    }

    fn cancel_message(&self) -> Option<Cow<'_, str>> {
        self.inner.cancel_message()
    }

    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        self.inner.search_hint()
    }

    fn is_read_only(&self, input: &Value) -> bool {
        self.inner.is_read_only(input)
    }

    fn is_destructive(&self, input: &Value) -> bool {
        self.inner.is_destructive(input)
    }

    fn is_concurrency_safe(&self, input: &Value) -> bool {
        self.inner.is_concurrency_safe(input)
    }

    fn interrupt_behavior(&self) -> InterruptBehavior {
        self.inner.interrupt_behavior()
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        self.inner.max_result_size_chars()
    }

    fn result_budget_bytes(&self) -> Option<usize> {
        self.inner.result_budget_bytes()
    }

    fn result_budget_truncate_bytes(&self) -> Option<usize> {
        self.inner.result_budget_truncate_bytes()
    }

    async fn validate_input(&self, input: &Value, context: &ToolUseContext) -> Validation {
        self.inner.validate_input(input, context).await
    }

    async fn check_permissions(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> PermissionDecision {
        self.inner.check_permissions(input, context).await
    }

    fn permission_subject(
        &self,
        input: &Value,
    ) -> Option<rust_cli_kernel_api::permission::PermissionSubject> {
        self.inner.permission_subject(input)
    }

    async fn call(
        &self,
        input: Value,
        context: ToolUseContext,
        progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        self.inner.call(input, context, progress).await
    }

    async fn call_with_messages(
        &self,
        input: Value,
        context: ToolUseContext,
        progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolCallOutput, ToolError> {
        self.inner
            .call_with_messages(input, context, progress)
            .await
    }

    fn mcp_info(&self) -> Option<&McpToolInfo> {
        self.inner.mcp_info()
    }
}

#[cfg(test)]
#[path = "workflow_gate_tests.rs"]
mod tests;
