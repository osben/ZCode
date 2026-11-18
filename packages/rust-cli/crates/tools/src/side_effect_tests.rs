//! Node `isWorkspaceMutatingToolCall` (contracts/src/tools/contract.ts): a read-only call is never a workspace write;
//! otherwise the scope decides, and a missing scope counts as mutating.

use rust_cli_kernel_api::orchestration::ToolRegistry;
use rust_cli_kernel_api::tool_names as names;

use super::{is_workspace_mutating, lookup};

#[test]
fn a_read_only_call_is_never_mutating() {
    assert!(!is_workspace_mutating(names::BASH, true));
    assert!(!is_workspace_mutating(names::WRITE, true));
    assert!(!is_workspace_mutating("mcp__x__y", true));
}

#[test]
fn the_scope_decides_for_a_call_that_is_not_read_only() {
    assert!(is_workspace_mutating(names::WRITE, false));
    assert!(is_workspace_mutating(names::EDIT, false));
    assert!(is_workspace_mutating(names::BASH, false));
    assert!(is_workspace_mutating(names::CRON_CREATE, false));
    assert!(is_workspace_mutating(names::SAVE_WORKFLOW, false));
    assert!(
        !is_workspace_mutating(names::WEB_FETCH, false),
        "network does not write the workspace"
    );
    assert!(
        !is_workspace_mutating(names::AGENT, false),
        "session scope is protocol-only"
    );
    assert!(
        !is_workspace_mutating(names::ASK_USER_QUESTION, false),
        "userInteraction asks the user"
    );
    assert!(!is_workspace_mutating(names::GLOB, false));
    assert!(!is_workspace_mutating(names::READ, false));
}

#[test]
fn a_name_without_a_declared_scope_or_outside_the_table_is_mutating() {
    assert!(is_workspace_mutating("mcp__plugin_demo_api__lookup", false));
    assert!(is_workspace_mutating("SomeUnknownTool", false));
    // Declared in Rust but with no Node scope in the sources: conservative, as a missing scope is in Node.
    assert!(is_workspace_mutating(names::MONITOR, false));
    assert!(
        lookup(names::MONITOR).is_some(),
        "the table names it, as undeclared"
    );
}

#[test]
fn every_builtin_tool_is_named_in_the_table() {
    let gate = std::sync::Arc::new(rust_cli_kernel_api::testing::FixedGate::allow());
    let missing: Vec<String> = crate::builtin(gate)
        .tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .filter(|name| lookup(name).is_none())
        .collect();
    assert!(
        missing.is_empty(),
        "a builtin tool with no entry in the side-effect table: {missing:?}"
    );
}
