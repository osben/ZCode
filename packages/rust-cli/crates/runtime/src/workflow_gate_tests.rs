use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::dynamic_workflow::{DynamicWorkflowGate, DynamicWorkflowGates};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_state::McpConnections;
use rust_cli_kernel_api::orchestration::{ToolRegistry, ToolSnapshot};
use rust_cli_kernel_api::tool::{Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext};
use rust_cli_kernel_api::tool_names;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::GatedRegistry;

/// A stub tool: the gate only reads its name and `should_defer`.
struct Stub {
    name: &'static str,
}

#[async_trait]
impl Tool for Stub {
    fn name(&self) -> &str {
        self.name
    }

    fn input_schema(&self) -> Value {
        json!({ "type": "object" })
    }

    fn description(&self, _context: &rust_cli_kernel_api::tool::PromptContext) -> String {
        format!("stub {}", self.name)
    }

    async fn call(
        &self,
        _input: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        Ok(rust_cli_kernel_api::tool::text(String::new()))
    }
}

/// The base registry: the same tools for every session, with no workflow tools.
struct Base {
    tools: Vec<Arc<dyn Tool>>,
}

impl ToolRegistry for Base {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.tools.clone()
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.iter().find(|tool| tool.name() == name).cloned()
    }

    fn find_for(&self, _session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        self.find(name)
    }

    fn withheld(&self, _name: &str) -> Option<Arc<dyn Tool>> {
        None
    }

    fn hides(&self, _name: &str) -> bool {
        false
    }

    fn keeps_order(&self) -> bool {
        false
    }

    fn snapshot(&self, _session: &SessionId) -> ToolSnapshot {
        ToolSnapshot {
            tools: self.tools.clone(),
            mcp: None,
        }
    }

    fn mcp(&self) -> Option<Arc<dyn McpConnections>> {
        None
    }
}

/// The gate source: one record per session, as `Server` keeps them.
struct Gates(HashMap<String, DynamicWorkflowGate>);

impl DynamicWorkflowGates for Gates {
    fn gate(&self, session: &SessionId) -> Option<DynamicWorkflowGate> {
        self.0.get(session.as_str()).copied()
    }
}

const OPEN: DynamicWorkflowGate = DynamicWorkflowGate {
    enabled: true,
    tools_on_demand: false,
};
const ON_DEMAND: DynamicWorkflowGate = DynamicWorkflowGate {
    enabled: true,
    tools_on_demand: true,
};
const CLOSED: DynamicWorkflowGate = DynamicWorkflowGate {
    enabled: false,
    tools_on_demand: false,
};

fn workflow_stubs() -> Vec<Arc<dyn Tool>> {
    tool_names::DYNAMIC_WORKFLOW_TOOLS
        .iter()
        .map(|name| Arc::new(Stub { name }) as Arc<dyn Tool>)
        .collect()
}

fn registry(records: &[(&str, DynamicWorkflowGate)]) -> GatedRegistry {
    let base = Base {
        tools: vec![Arc::new(Stub { name: "Read" }) as Arc<dyn Tool>],
    };
    let gates = Gates(
        records
            .iter()
            .map(|(session, gate)| ((*session).to_owned(), *gate))
            .collect(),
    );
    GatedRegistry::new(Arc::new(base), Arc::new(gates), workflow_stubs())
}

fn names(tools: &[Arc<dyn Tool>]) -> Vec<String> {
    tools.iter().map(|tool| tool.name().to_owned()).collect()
}

#[test]
fn a_session_without_a_record_sees_no_workflow_tool() {
    let registry = registry(&[]);
    let session = SessionId::new("s1");
    assert!(
        registry
            .find_for(&session, tool_names::CREATE_WORKFLOW)
            .is_none()
    );
    assert_eq!(names(&registry.snapshot(&session).tools), ["Read"]);
}

#[test]
fn a_closed_record_sees_no_workflow_tool() {
    let registry = registry(&[("s1", CLOSED)]);
    let session = SessionId::new("s1");
    assert!(
        registry
            .find_for(&session, tool_names::CREATE_WORKFLOW)
            .is_none()
    );
    assert_eq!(names(&registry.snapshot(&session).tools), ["Read"]);
}

#[test]
fn an_open_record_sees_the_ten_workflow_tools_always_on() {
    let registry = registry(&[("s1", OPEN)]);
    let session = SessionId::new("s1");
    let snapshot = names(&registry.snapshot(&session).tools);
    assert_eq!(snapshot.len(), 11);
    for name in tool_names::DYNAMIC_WORKFLOW_TOOLS {
        assert!(snapshot.iter().any(|tool| tool == name), "{name} missing");
    }
    let found = registry
        .find_for(&session, tool_names::FILL_WORKFLOW_HOLE)
        .expect("the open gate finds FillWorkflowHole");
    assert!(!found.should_defer());
}

#[test]
fn on_demand_defers_every_workflow_tool_and_keeps_the_base_tools_undeferred() {
    let registry = registry(&[("s1", ON_DEMAND)]);
    let session = SessionId::new("s1");
    let snapshot = registry.snapshot(&session).tools;
    for tool in &snapshot {
        if tool.name() == "Read" {
            assert!(!tool.should_defer());
        } else {
            assert!(tool.should_defer(), "{} is not deferred", tool.name());
        }
    }
    let found = registry
        .find_for(&session, tool_names::CREATE_WORKFLOW)
        .expect("on demand still finds the tool for execution");
    assert!(found.should_defer());
}

#[test]
fn the_gate_is_per_session() {
    let registry = registry(&[("open", OPEN), ("closed", CLOSED)]);
    let open = SessionId::new("open");
    let closed = SessionId::new("closed");
    assert!(
        registry
            .find_for(&open, tool_names::CREATE_WORKFLOW)
            .is_some()
    );
    assert!(
        registry
            .find_for(&closed, tool_names::CREATE_WORKFLOW)
            .is_none()
    );
    assert_eq!(names(&registry.snapshot(&closed).tools), ["Read"]);
}

#[test]
fn the_session_less_views_never_list_or_find_a_workflow_tool() {
    let registry = registry(&[("s1", OPEN)]);
    assert_eq!(names(&registry.tools()), ["Read"]);
    assert!(registry.find(tool_names::CREATE_WORKFLOW).is_none());
}
