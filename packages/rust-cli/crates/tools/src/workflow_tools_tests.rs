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
fn the_registration_returns_no_tool_before_the_engine_lands() {
    assert!(workflow_tools().is_empty());
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
