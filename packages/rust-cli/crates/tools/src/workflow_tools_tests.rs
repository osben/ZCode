use serde_json::json;

use super::*;
use rust_cli_kernel_api::tool_names;

#[test]
fn the_contracts_are_node_s_ten_workflow_tools_in_node_s_order() {
    let contracts = contracts();
    let names: Vec<&str> = contracts
        .iter()
        .map(|contract| contract.name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            tool_names::CREATE_WORKFLOW,
            tool_names::AMEND_WORKFLOW,
            tool_names::SAVE_WORKFLOW,
            tool_names::EVAL_WORKFLOW_SNIPPET,
            tool_names::LIST_WORKFLOW_RUNS,
            tool_names::GET_WORKFLOW_RUN,
            tool_names::RESUME_WORKFLOW_RUN,
            tool_names::RESOLVE_WORKFLOW_QUESTION,
            tool_names::FILL_WORKFLOW_HOLE,
            tool_names::LIST_SAVED_WORKFLOWS,
        ]
    );
    // The set is the canonical array in tool_names, so a new member is caught here.
    for name in tool_names::DYNAMIC_WORKFLOW_TOOLS {
        assert!(names.contains(&name), "{name} has no contract");
    }
}

#[test]
fn every_contract_carries_a_provider_description_and_an_object_schema() {
    for contract in contracts() {
        assert!(
            !contract.description.is_empty(),
            "{} has no description",
            contract.name
        );
        assert_eq!(
            contract.input_schema["type"], "object",
            "{} input schema is not an object",
            contract.name
        );
    }
}

#[test]
fn without_an_analyzer_only_list_saved_workflows_is_registered() {
    let names: Vec<String> = workflow_tools(None, std::path::PathBuf::from("/home"))
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert_eq!(names, ["ListSavedWorkflows"]);
}

#[test]
fn with_an_analyzer_save_workflow_is_registered_before_list_saved_workflows() {
    let analyzer: std::sync::Arc<dyn rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer> =
        std::sync::Arc::new(NoAnalyzer);
    let tools = workflow_tools(Some(analyzer), std::path::PathBuf::from("/home"));
    let names: Vec<&str> = tools.iter().map(|tool| tool.name()).collect();
    assert_eq!(names, ["SaveWorkflow", "ListSavedWorkflows"]);
    for tool in &tools {
        assert!(tool.should_defer(), "{} is deferred", tool.name());
        let contract = contract(tool.name());
        assert_eq!(tool.description(&prompt()), contract.description);
        assert_eq!(tool.input_schema(), contract.input_schema);
    }
}

fn prompt() -> rust_cli_kernel_api::tool::PromptContext {
    rust_cli_kernel_api::tool::PromptContext {
        tool_names: Vec::new(),
        mode: rust_cli_kernel_api::permission::PermissionMode::Default,
    }
}

struct NoAnalyzer;

#[async_trait::async_trait]
impl rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer for NoAnalyzer {
    async fn analyze(
        &self,
        _script: &str,
    ) -> Result<
        rust_cli_kernel_api::workflow_analysis::WorkflowAnalysis,
        rust_cli_kernel_api::workflow_analysis::WorkflowAnalysisError,
    > {
        unreachable!("registration does not analyze")
    }
}

#[test]
fn an_amendment_skips_confirmation_only_for_an_owned_predecessor_not_stopped_by_the_user() {
    assert!(is_amend_workflow_owned_predecessor(&json!({
        "owned_by_this_session": true,
        "stop_reason": "model",
    })));
    assert!(is_amend_workflow_owned_predecessor(&json!({
        "owned_by_this_session": true,
    })));
    // A user stop is the user's own decision: ask again.
    assert!(!is_amend_workflow_owned_predecessor(&json!({
        "owned_by_this_session": true,
        "stop_reason": "user",
    })));
    // A new provider in the revision is not confirmation-free, even for an owned run.
    assert!(!is_amend_workflow_owned_predecessor(&json!({
        "owned_by_this_session": true,
        "introduces_providers": ["openai/gpt"],
    })));
    assert!(!is_amend_workflow_owned_predecessor(&json!({
        "owned_by_this_session": false,
    })));
    assert!(!is_amend_workflow_owned_predecessor(&json!("owned")));
    assert!(!is_amend_workflow_owned_predecessor(&json!(null)));
}

#[test]
fn a_hole_fill_skips_confirmation_only_for_a_hole_of_this_session() {
    assert!(is_fill_workflow_hole_owned_run(
        &json!({ "owned_by_this_session": true })
    ));
    assert!(!is_fill_workflow_hole_owned_run(
        &json!({ "owned_by_this_session": false })
    ));
    assert!(!is_fill_workflow_hole_owned_run(
        &json!({ "owned_by_this_session": "true" })
    ));
    assert!(!is_fill_workflow_hole_owned_run(&json!(true)));
}
