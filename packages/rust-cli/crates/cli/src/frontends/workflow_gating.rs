//! Fork (W7-7a, specs/fork-rust-workflow-engine.md 9.36): the dynamic-workflow gate source and the workflow tools the app
//! server registers behind it. The table is the context's (divergence 56); the kernel reads it through the extensions,
//! and the incognito toggle closes a session's gate in the runtime (divergence 55).
//!
//! Registered here: CreateWorkflow and SaveWorkflow (with the helper's analyzer), EvalWorkflowSnippet (with the snippet
//! port, 9.44), the run tools (9.40) and ListSavedWorkflows, all reaching the run sessions through one late slot the
//! composition sets once the run service is built (9.39, 9.40).

use std::path::Path;
use std::sync::Arc;

use rust_cli_kernel_api::dynamic_workflow::{DynamicWorkflowGates, SessionGates};
use rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer;
use rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions;
use rust_cli_kernel_api::workflow_snippet::WorkflowSnippetPort;
use rust_cli_protocol_zcode::NodeHelper;
use rust_cli_protocol_zcode::workflow_compile::HelperWorkflowAnalyzer;
use rust_cli_runtime::{DynamicWorkflowGating, wired_workflow_tools};

/// The gate source the kernel's extensions hold: the shared table, and the workflow tools behind it. The helper is the
/// analyzer's transport; without one, SaveWorkflow is not registered. `runs` is the run sessions the run tools reach
/// (9.40); the composition sets it once the run service exists. `snippets` is the port EvalWorkflowSnippet runs through
/// (9.44): the composition passes it only when the helper exists, and the port itself is set later.
pub(crate) fn gating(
    gates: Arc<SessionGates>,
    helper: Option<&Arc<NodeHelper>>,
    home: &Path,
    runs: Arc<dyn DynamicWorkflowRunSessions>,
    snippets: Option<Arc<dyn WorkflowSnippetPort>>,
    models: Arc<rust_cli_kernel_api::provider::LateModelDirectory>,
) -> DynamicWorkflowGating {
    let analyzer = helper.map(|helper| {
        Arc::new(HelperWorkflowAnalyzer::new(helper.clone())) as Arc<dyn WorkflowAnalyzer>
    });
    let gates: Arc<dyn DynamicWorkflowGates> = gates;
    DynamicWorkflowGating {
        gates,
        tools: wired_workflow_tools(analyzer, home, runs, snippets, models),
    }
}

#[cfg(test)]
#[path = "workflow_gating_tests.rs"]
mod tests;
