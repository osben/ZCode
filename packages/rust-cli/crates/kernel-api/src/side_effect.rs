//! Node `isWorkspaceMutatingToolCall` (contracts/src/tools/contract.ts), ported. A call is a workspace write unless it
//! is read-only (`Tool::is_read_only` on the call's input); otherwise its scope decides, and a name without a declared
//! scope counts as mutating (Node: "undeclared means untrusted"). The table gives Node's scope per Rust tool name, taken
//! from Node's tool handlers (`core/src/tool/handlers/*.ts`); a Rust name the table lists as `None` has no scope in those
//! sources and is mutating. A name the table does not list at all (MCP, plugin tools) is mutating too.

use serde_json::Value;

use crate::tool::Tool;
use crate::tool_names as names;

/// Node `ToolSideEffectScope`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    None,
    Workspace,
    Git,
    Network,
    System,
    Session,
    UserInteraction,
}

/// Node's scope per Rust tool name. `None` = the sources declare no scope for it.
const TABLE: &[(&str, Option<Scope>)] = &[
    (names::AGENT, Some(Scope::Session)),
    (names::ASK_USER_QUESTION, Some(Scope::UserInteraction)),
    (names::BASH, Some(Scope::System)),
    (names::CRON_CREATE, Some(Scope::Workspace)),
    (names::CRON_DELETE, Some(Scope::Workspace)),
    (names::CRON_LIST, Some(Scope::None)),
    (names::CRON_PAUSE_SELF, Some(Scope::Workspace)),
    (names::CRON_UPDATE, Some(Scope::Workspace)),
    (names::EDIT, Some(Scope::Workspace)),
    (names::ENTER_PLAN_MODE, Some(Scope::Session)),
    (names::ENTER_WORKTREE, None),
    (names::EXIT_PLAN_MODE, Some(Scope::Session)),
    (names::EXIT_WORKTREE, None),
    (names::GLOB, Some(Scope::None)),
    (names::GREP, Some(Scope::None)),
    (names::LIST_AGENTS, None),
    (names::LIST_MCP_RESOURCES, None),
    (names::LSP, Some(Scope::None)),
    (names::MONITOR, None),
    (names::MULTI_EDIT, None),
    (names::NOTEBOOK_EDIT, None),
    (names::OFF_PEAK_CREATE, Some(Scope::Workspace)),
    (names::OFF_PEAK_LIST, Some(Scope::None)),
    (names::AMEND_WORKFLOW, Some(Scope::None)),
    (names::CREATE_WORKFLOW, Some(Scope::None)),
    (names::EVAL_WORKFLOW_SNIPPET, Some(Scope::Workspace)),
    (names::FILL_WORKFLOW_HOLE, Some(Scope::None)),
    (names::GET_WORKFLOW_RUN, Some(Scope::None)),
    (names::LIST_SAVED_WORKFLOWS, Some(Scope::None)),
    (names::LIST_WORKFLOW_RUNS, Some(Scope::None)),
    (names::RESOLVE_WORKFLOW_QUESTION, Some(Scope::None)),
    (names::RESUME_WORKFLOW_RUN, Some(Scope::None)),
    (names::SAVE_WORKFLOW, Some(Scope::Workspace)),
    (names::POWER_SHELL, None),
    (names::READ, Some(Scope::None)),
    (names::READ_MCP_RESOURCE, None),
    (names::READ_MCP_RESOURCE_DIR, None),
    (names::READ_TOPIC_RESOURCE, Some(Scope::Session)),
    (names::REPORT_FINDINGS, None),
    (names::SCHEDULE_WAKEUP, None),
    (names::SEND_MESSAGE, Some(Scope::Session)),
    (names::SEND_USER_MESSAGE, None),
    (names::SKILL, Some(Scope::Session)),
    (names::TASK_CREATE, None),
    (names::TASK_GET, None),
    (names::TASK_LIST, None),
    (names::TASK_OUTPUT, Some(Scope::None)),
    (names::TASK_STOP, Some(Scope::Session)),
    (names::TASK_UPDATE, None),
    (names::TODO_WRITE, Some(Scope::Session)),
    (names::TOOL_SEARCH, Some(Scope::None)),
    (names::WAIT_FOR_MCP_SERVERS, None),
    (names::WEB_FETCH, Some(Scope::Network)),
    (names::WEB_SEARCH, Some(Scope::Network)),
    (names::WRITE, Some(Scope::Workspace)),
    // Protocol tools the agents crate declares by literal name (Node: session scope).
    ("submit_result", Some(Scope::Session)),
    ("escalate", Some(Scope::Session)),
    ("RespondToCoordinator", Some(Scope::Session)),
    ("ReadSessionContext", Some(Scope::Session)),
];

/// The table's entry for `name`: the outer `Option` is "listed", the inner one is the declared scope.
pub fn lookup(name: &str) -> Option<Option<Scope>> {
    TABLE
        .iter()
        .find(|(listed, _)| *listed == name)
        .map(|(_, scope)| *scope)
}

/// Node `isWorkspaceMutatingToolCall`. `read_only` is the call's own classification (`Tool::is_read_only(input)`).
pub fn is_workspace_mutating(name: &str, read_only: bool) -> bool {
    if read_only {
        return false;
    }
    match lookup(name) {
        Some(Some(scope)) => matches!(scope, Scope::Workspace | Scope::Git | Scope::System),
        // Declared without a scope, or not in the table at all: undeclared means mutating.
        Some(None) | None => true,
    }
}

/// The predicate for a call of `tool` with `input`: its own read-only classification (Bash reads the command), then
/// [`is_workspace_mutating`]. The query executor calls it when a call is admitted.
pub fn is_workspace_mutating_call(tool: &dyn Tool, input: &Value) -> bool {
    is_workspace_mutating(tool.name(), tool.is_read_only(input))
}
