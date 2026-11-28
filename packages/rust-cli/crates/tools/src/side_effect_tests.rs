//! Node `isWorkspaceMutatingToolCall` (contracts/src/tools/contract.ts) over Rust's real tools: a read-only call is never a
//! workspace write, and every known Rust tool name has an entry in the side-effect table.

use std::sync::Arc;

use rust_cli_kernel_api::orchestration::ToolRegistry;
use rust_cli_kernel_api::side_effect::{is_workspace_mutating_call, lookup};
use rust_cli_kernel_api::tool_names as names;
use serde_json::json;

use crate::BashTool;

#[test]
fn a_read_only_bash_call_does_not_fire() {
    // Bash classifies by its command: `ls` is read-only, `rm` writes.
    let tool = BashTool::new(Default::default());
    assert!(!is_workspace_mutating_call(
        &tool,
        &json!({"command": "ls"})
    ));
    assert!(is_workspace_mutating_call(
        &tool,
        &json!({"command": "rm -rf target"})
    ));
}

#[test]
fn every_builtin_tool_is_named_in_the_table() {
    let gate = Arc::new(rust_cli_kernel_api::testing::FixedGate::allow());
    let missing: Vec<String> = crate::builtin(gate)
        .tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .filter(|name| lookup(name).is_none())
        .collect();
    assert!(
        missing.is_empty(),
        "a builtin tool with no table entry: {missing:?}"
    );
}

/// Every known Rust tool name, web, LSP, workflow and plan tools included, plus the protocol tools the agents crate
/// declares by literal name. Only MCP and plugin tools are outside the table, and they take the runtime default.
#[test]
fn every_known_tool_name_is_named_in_the_table() {
    let known: &[&str] = &[
        names::AGENT,
        names::ASK_USER_QUESTION,
        names::BASH,
        names::CRON_CREATE,
        names::CRON_DELETE,
        names::CRON_LIST,
        names::CRON_PAUSE_SELF,
        names::CRON_UPDATE,
        names::EDIT,
        names::ENTER_PLAN_MODE,
        names::ENTER_WORKTREE,
        names::EXIT_PLAN_MODE,
        names::EXIT_WORKTREE,
        names::GLOB,
        names::GREP,
        names::LIST_AGENTS,
        names::LIST_MCP_RESOURCES,
        names::LIST_MODELS,
        names::LSP,
        names::MONITOR,
        names::MULTI_EDIT,
        names::NOTEBOOK_EDIT,
        names::OFF_PEAK_CREATE,
        names::OFF_PEAK_LIST,
        names::AMEND_WORKFLOW,
        names::CREATE_WORKFLOW,
        names::EVAL_WORKFLOW_SNIPPET,
        names::FILL_WORKFLOW_HOLE,
        names::GET_WORKFLOW_RUN,
        names::LIST_SAVED_WORKFLOWS,
        names::LIST_WORKFLOW_RUNS,
        names::RESOLVE_WORKFLOW_QUESTION,
        names::RESUME_WORKFLOW_RUN,
        names::SAVE_WORKFLOW,
        names::POWER_SHELL,
        names::READ,
        names::READ_MCP_RESOURCE,
        names::READ_MCP_RESOURCE_DIR,
        names::READ_TOPIC_RESOURCE,
        names::REPORT_FINDINGS,
        names::SCHEDULE_WAKEUP,
        names::SEND_MESSAGE,
        names::SEND_USER_MESSAGE,
        names::SKILL,
        names::TASK_CREATE,
        names::TASK_GET,
        names::TASK_LIST,
        names::TASK_OUTPUT,
        names::TASK_STOP,
        names::TASK_UPDATE,
        names::TODO_WRITE,
        names::TOOL_SEARCH,
        names::WAIT_FOR_MCP_SERVERS,
        names::WEB_FETCH,
        names::WEB_SEARCH,
        names::WRITE,
        "submit_result",
        "escalate",
        "RespondToCoordinator",
    ];
    let missing: Vec<&str> = known
        .iter()
        .copied()
        .filter(|name| lookup(name).is_none())
        .collect();
    assert!(
        missing.is_empty(),
        "known tool names with no table entry: {missing:?}"
    );
}

/// ReadTopicResource is session-scoped in Node's handler files (origin/fork, read-topic-resource.ts), so it is never a
/// workspace write.
#[test]
fn read_topic_resource_is_session_scoped_and_not_mutating() {
    assert!(!rust_cli_kernel_api::side_effect::is_workspace_mutating(
        names::READ_TOPIC_RESOURCE,
        false
    ));
}

/// The predicate's two branches a table lookup does not reach: a scope-none tool that is not read-only (Grep declares
/// no workspace scope) is not mutating, and an unknown name is mutating (undeclared means mutating).
#[test]
fn a_scope_none_tool_is_not_mutating_and_an_unknown_name_is_mutating() {
    assert!(!rust_cli_kernel_api::side_effect::is_workspace_mutating(
        names::GREP,
        false
    ));
    assert!(rust_cli_kernel_api::side_effect::is_workspace_mutating(
        "mcp_server_tool",
        false
    ));
}
