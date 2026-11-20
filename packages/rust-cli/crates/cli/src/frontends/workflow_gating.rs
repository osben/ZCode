//! Fork (W7-7a, specs/fork-rust-workflow-engine.md 9.36): the dynamic-workflow gate source and the workflow tools the app
//! server registers behind it. The table is the context's (divergence 56); the kernel reads it through the extensions,
//! and the incognito toggle closes a session's gate in the runtime (divergence 55).
//!
//! Registered here: CreateWorkflow (9.39: with the helper's analyzer and the run sessions), SaveWorkflow (with the
//! analyzer) and ListSavedWorkflows. EvalWorkflowSnippet is not: its reads are rooted at the process workspace, not at
//! the session's directory (9.36, divergence 313).

use std::path::Path;
use std::sync::Arc;

use rust_cli_kernel_api::dynamic_workflow::{DynamicWorkflowGates, SessionGates};
use rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer;
use rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions;
use rust_cli_protocol_zcode::NodeHelper;
use rust_cli_protocol_zcode::workflow_compile::HelperWorkflowAnalyzer;
use rust_cli_runtime::{DynamicWorkflowGating, wired_workflow_tools};

/// The gate source the kernel's extensions hold: the shared table, and the workflow tools behind it. The helper is the
/// analyzer's transport; without one, CreateWorkflow and SaveWorkflow are not registered. `runs` is the run service's
/// per-session ports (9.39); the composition sets them once the service is built.
pub(crate) fn gating(
    gates: Arc<SessionGates>,
    helper: Option<&Arc<NodeHelper>>,
    home: &Path,
    runs: Arc<dyn DynamicWorkflowRunSessions>,
) -> DynamicWorkflowGating {
    let analyzer = helper.map(|helper| {
        Arc::new(HelperWorkflowAnalyzer::new(helper.clone())) as Arc<dyn WorkflowAnalyzer>
    });
    let gates: Arc<dyn DynamicWorkflowGates> = gates;
    DynamicWorkflowGating {
        gates,
        tools: wired_workflow_tools(analyzer, home, Some(runs)),
    }
}

#[cfg(test)]
#[path = "workflow_gating_tests.rs"]
mod tests;
