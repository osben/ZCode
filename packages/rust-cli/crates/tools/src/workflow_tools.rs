//! Fork: the dynamic-workflow tools (Node `core/src/tool/handlers/*-workflow*.ts`; specs/fork-rust-workflow-engine.md,
//! W7-1). The contracts (name, provider description, input schema, the flags the registry reads) are generated from Node
//! by `scripts/fork-rust-agent/workflow-tools.mts` into `assets/node_workflow_tools.json`. The tools land with their
//! PRs: SaveWorkflow and ListSavedWorkflows (W7-8b) are registered here; the others are W7-7, W7-8a, W7-9 and W7-10.
//!
//! The two predicates are Node's contract helpers (`contracts/src/tools/amend-workflow.ts`,
//! `contracts/src/tools/fill-workflow-hole.ts`): the permission service and the handler read the same fact, so both
//! live here rather than in a handler.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use rust_cli_kernel_api::message::{ContentBlock, Message};
use rust_cli_kernel_api::tool::{Tool, ToolUseContext};
use rust_cli_kernel_api::tool_names;
use rust_cli_kernel_api::workflow_analysis::WorkflowAnalyzer;
use rust_cli_kernel_api::workflow_run::DynamicWorkflowRunSessions;
use rust_cli_kernel_api::workflow_snippet::WorkflowSnippetPort;
use serde::Deserialize;
use serde_json::Value;

use crate::workflow_create::CreateWorkflowTool;
use crate::workflow_eval_snippet::EvalWorkflowSnippetTool;
use crate::workflow_list::ListSavedWorkflowsTool;
use crate::workflow_save::SaveWorkflowTool;

const CONTRACTS: &str = rust_cli_base::include_lf!("../assets/node_workflow_tools.json");

/// One generated contract (a row of `node_workflow_tools.json`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub search_hint: Option<String>,
    pub read_only: bool,
    pub destructive: bool,
    pub concurrent_safe: bool,
    pub needs_approval: bool,
    /// Node `metadata.shouldDefer`: the tool is loaded on demand through ToolSearch.
    pub should_defer: bool,
    pub input_schema: Value,
}

/// The ten contracts in Node's registration order (`core/src/tool/handlers/index.ts`).
pub fn contracts() -> &'static [Contract] {
    static PARSED: std::sync::OnceLock<Vec<Contract>> = std::sync::OnceLock::new();
    PARSED.get_or_init(|| {
        serde_json::from_str(CONTRACTS)
            .unwrap_or_else(|error| unreachable!("the workflow tool contracts parse: {error}"))
    })
}

/// The Skill that carries the authoring rules; SaveWorkflow and EvalWorkflowSnippet refuse until it has been read.
pub const DYNAMIC_WORKFLOW_SKILL: &str = "dynamic-workflows";

/// The contract of one of the ten tools, by its Node name.
pub fn contract(name: &str) -> &'static Contract {
    contracts()
        .iter()
        .find(|contract| contract.name == name)
        .unwrap_or_else(|| unreachable!("the workflow tool contract {name} exists"))
}

/// The workspace root of the call, as a local path (the saved-workflow store is local, as in Node).
pub fn workspace_dir(context: &ToolUseContext) -> String {
    context.workspace.root.as_str().to_owned()
}

/// Node `hasLoadedSkill`: a Skill call for the dynamic-workflows skill that succeeded and is still in the session's
/// committed history (compaction removes it, and the gate closes again). A session with no history to read counts as
/// not loaded: this fails closed, where Node's absent probe passes.
pub async fn skill_loaded(context: &ToolUseContext) -> bool {
    let Some(messages) = context.session_ops.conversation().await else {
        return false;
    };
    let mut calls = HashSet::new();
    for message in &messages {
        if let Message::Assistant(assistant) = message {
            for block in &assistant.content {
                if let ContentBlock::ToolUse { id, name, input } = block
                    && name == tool_names::SKILL
                    && input.get("skill").and_then(Value::as_str) == Some(DYNAMIC_WORKFLOW_SKILL)
                {
                    calls.insert(id.clone());
                }
            }
        }
    }
    messages.iter().any(|message| {
        let Message::User(user) = message else {
            return false;
        };
        user.content.iter().any(|block| {
            matches!(
                block,
                ContentBlock::ToolResult { tool_use_id, is_error: false, .. } if calls.contains(tool_use_id)
            )
        })
    })
}

/// The dynamic-workflow tools to register, in Node's registration order (CreateWorkflow, SaveWorkflow,
/// EvalWorkflowSnippet, then ListSavedWorkflows). CreateWorkflow and SaveWorkflow check scripts, so they exist only with
/// an analyzer; without one, neither is offered. CreateWorkflow starts runs through `run_port` (no port: it typechecks and
/// says it did not run). EvalWorkflowSnippet runs a snippet, so it exists only with a snippet port. All reach a session
/// only through the gate (`runtime::workflow_gate`), whose source no entry point sets yet.
pub fn workflow_tools(
    analyzer: Option<Arc<dyn WorkflowAnalyzer>>,
    home: PathBuf,
    runs: Option<Arc<dyn DynamicWorkflowRunSessions>>,
    snippets: Option<Arc<dyn WorkflowSnippetPort>>,
) -> Vec<Arc<dyn Tool>> {
    let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
    if let Some(analyzer) = analyzer {
        tools.push(Arc::new(CreateWorkflowTool::new(
            analyzer.clone(),
            runs,
            home.clone(),
        )));
        tools.push(Arc::new(SaveWorkflowTool::new(analyzer, home.clone())));
    }
    if let Some(snippets) = snippets {
        tools.push(Arc::new(EvalWorkflowSnippetTool::new(snippets)));
    }
    tools.push(Arc::new(ListSavedWorkflowsTool::new(home)));
    tools
}

/// Node `isAmendWorkflowOwnedPredecessor`: an owned predecessor that the user did not stop, and whose revision adds no
/// provider, so AmendWorkflow skips the confirmation. Any other shape asks as usual (fail closed).
pub fn is_amend_workflow_owned_predecessor(predecessor: &Value) -> bool {
    let Some(facts) = predecessor.as_object() else {
        return false;
    };
    facts.get("owned_by_this_session") == Some(&Value::Bool(true))
        && facts.get("stop_reason") != Some(&Value::String("user".to_owned()))
        && facts.get("introduces_providers").is_none()
}

/// Node `isFillWorkflowHoleOwnedRun`: a hole of this session's own run, which FillWorkflowHole may fill without asking.
pub fn is_fill_workflow_hole_owned_run(hole: &Value) -> bool {
    hole.get("owned_by_this_session") == Some(&Value::Bool(true))
}

#[cfg(test)]
#[path = "workflow_tools_tests.rs"]
mod tests;
