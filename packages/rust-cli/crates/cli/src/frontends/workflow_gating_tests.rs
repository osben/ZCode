//! W7-7a (specs/fork-rust-workflow-engine.md 9.36): the tools the app server wires behind the gate.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::dynamic_workflow::{DynamicWorkflowGate, SessionGates};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::tool::Tool;
use rust_cli_kernel_api::workflow_analysis::{
    WorkflowAnalysis, WorkflowAnalysisError, WorkflowAnalyzer,
};
use rust_cli_runtime::wired_workflow_tools;

use super::gating;

struct NoAnalyzer;

#[async_trait]
impl WorkflowAnalyzer for NoAnalyzer {
    async fn analyze(&self, _script: &str) -> Result<WorkflowAnalysis, WorkflowAnalysisError> {
        Err(WorkflowAnalysisError {
            message: "the checker is not called in these tests".to_owned(),
        })
    }
}

fn names(tools: &[Arc<dyn Tool>]) -> Vec<String> {
    tools.iter().map(|tool| tool.name().to_owned()).collect()
}

#[test]
fn without_an_analyzer_only_list_saved_workflows_is_wired() {
    let tools = wired_workflow_tools(None, &PathBuf::from("/home"));
    assert_eq!(names(&tools), ["ListSavedWorkflows"]);
}

#[test]
fn with_an_analyzer_save_is_wired_before_list_and_create_never_is() {
    let analyzer: Arc<dyn WorkflowAnalyzer> = Arc::new(NoAnalyzer);
    let tools = wired_workflow_tools(Some(analyzer), &PathBuf::from("/home"));
    assert_eq!(names(&tools), ["SaveWorkflow", "ListSavedWorkflows"]);
}

#[test]
fn the_gate_source_reads_the_shared_table_the_server_records_into() {
    let table = Arc::new(SessionGates::default());
    let source = gating(table.clone(), None, &PathBuf::from("/home"));
    let open = DynamicWorkflowGate {
        enabled: true,
        tools_on_demand: false,
    };
    table.record(&SessionId::new("ses_a"), open);
    assert_eq!(source.gates.gate(&SessionId::new("ses_a")), Some(open));
    assert_eq!(source.gates.gate(&SessionId::new("ses_b")), None);
    assert_eq!(names(&source.tools), ["ListSavedWorkflows"]);
}
