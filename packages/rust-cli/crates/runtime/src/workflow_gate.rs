//! Fork: the dynamic-workflow tools behind the per-session gate (Node `resolveRuntimeDynamicWorkflowToolsIncluded`,
//! `core/src/runtime/helpers/tool-allowlist.ts`; specs/fork-rust-workflow-engine.md, W7-1).
//!
//! The base registry is the same for every session. This wrapper adds the workflow tools to a session's view only when
//! that session's recorded gate is open, and fails closed everywhere the session is unknown: `tools()` and `find()`
//! (no session) never see them. An on-demand session sees none of them until it activates them (W9h, 9.64), as Node
//! registers none before activation.

use std::sync::Arc;

use rust_cli_kernel_api::dynamic_workflow::{DynamicWorkflowGate, DynamicWorkflowGates};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_state::McpConnections;
use rust_cli_kernel_api::orchestration::{ToolRegistry, ToolSnapshot};
use rust_cli_kernel_api::tool::{Tool, answers_to};

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

    /// The workflow tools one session sees: none unless its record opens the gate (no record is closed), and none for an
    /// on-demand session that has not activated them (Node `enabled ∧ (¬onDemand ∨ activated)`). W9h (9.64): they were
    /// deferred before, which still listed their names in the request (gray-on-demand DWO-01).
    fn visible(&self, session: &SessionId) -> Vec<Arc<dyn Tool>> {
        let Some(gate) = self.gates.gate(session).filter(|gate| gate.enabled) else {
            return Vec::new();
        };
        if gate.tools_on_demand && !self.gates.activated(session) {
            return Vec::new();
        }
        self.workflow.clone()
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
/// (with the analyzer and the run sessions), SaveWorkflow (with the analyzer), EvalWorkflowSnippet (with `snippets`, 9.44),
/// the run tools (ListWorkflowRuns, ResumeWorkflowRun, ResolveWorkflowQuestion) through `runs`, then ListSavedWorkflows.
///
/// The run tools read and act through `runs`, the per-session run port of the calling session.
pub fn wired_workflow_tools(
    analyzer: Option<Arc<dyn rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer>>,
    home: &std::path::Path,
    runs: Arc<dyn rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions>,
    snippets: Option<Arc<dyn rust_cli_kernel_api::workflow_snippet::WorkflowSnippetPort>>,
    models: Arc<rust_cli_kernel_api::provider::LateModelDirectory>,
    ids: Arc<dyn rust_cli_kernel_api::clock::Ids>,
) -> Vec<Arc<dyn Tool>> {
    let mut tools: Vec<Arc<dyn Tool>> = rust_cli_tools::workflow_tools(
        analyzer,
        home.to_path_buf(),
        Some(runs.clone()),
        snippets,
        models,
        ids,
    );
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

    fn activated(&self, session: &SessionId) -> bool {
        self.inner.activated(session)
    }
}

#[cfg(test)]
#[path = "workflow_gate_tests.rs"]
mod tests;
