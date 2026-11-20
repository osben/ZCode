//! Fork: the dynamic-workflow tools (Node `core/src/tool/handlers/*-workflow*.ts`; specs/fork-rust-workflow-engine.md,
//! W7-1). The contracts (name, provider description, input schema, the flags the registry reads) are generated from Node
//! by `scripts/fork-rust-agent/workflow-tools.mts` into `assets/node_workflow_tools.json`. The tools themselves land
//! with their PRs (W7-7..10); until then [`workflow_tools`] registers nothing, and the registry and the gate are tested
//! with stub tools.
//!
//! The two predicates are Node's contract helpers (`contracts/src/tools/amend-workflow.ts`,
//! `contracts/src/tools/fill-workflow-hole.ts`): the permission service and the handler read the same fact, so both
//! live here rather than in a handler.

use std::sync::Arc;

use rust_cli_kernel_api::tool::Tool;
use serde::Deserialize;
use serde_json::Value;

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

/// The dynamic-workflow tools to register. Empty until the tools land (W7-7..10); the gate filter and the
/// denylists (`agents::toolset`) are already in place for them.
pub fn workflow_tools() -> Vec<Arc<dyn Tool>> {
    Vec::new()
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
