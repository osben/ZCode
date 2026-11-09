use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId, TraceId};
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::session_api::SessionView;
use rust_cli_kernel_api::store::{SessionKind, SessionMeta};
use rust_cli_kernel_api::testing::selection;
use serde_json::{Map, json};

use super::super::state::Followup;
use super::*;

fn projection(rows: Vec<Value>) -> Projection {
    let view = SessionView::new(
        SessionMeta {
            id: SessionId::new("session_1"),
            kind: SessionKind::Interactive,
            parent: None,
            workspace: WorkspaceRef {
                environment: EnvironmentId::new("local"),
                root: EnvPath::new("/w"),
            },
            title: String::new(),
            trace: TraceId::new("trace"),
            created_at_ms: 1000,
        },
        Vec::new(),
        selection(),
        PermissionMode::Default,
    );
    let mut projection = Projection::from_view(&view, Followup::Queue, Vec::new());
    projection.rows = rows
        .into_iter()
        .map(|row| row.as_object().cloned().unwrap_or_else(Map::new))
        .collect();
    projection
}

fn tool(row: u64, name: &str, status: &str, input: Value) -> Value {
    json!({"rowId": row, "kind": "toolCall", "toolName": name, "status": status, "input": input,
        "inputText": input.to_string()})
}

#[test]
fn only_settled_plans_with_text_are_listed_newest_first() {
    let plans = projection(vec![
        tool(1, "ExitPlanMode", "success", json!({"plan": "# one"})),
        tool(2, "ExitPlanMode", "running", json!({"plan": "# running"})),
        tool(3, "Write", "success", json!({"plan": "# not a plan tool"})),
        tool(4, "ExitPlanMode", "cancelled", json!({"plan": "  "})),
        tool(5, "ExitPlanMode", "error", json!({"plan": "# five"})),
    ])
    .plans();
    let ids: Vec<u64> = plans
        .iter()
        .filter_map(|row| row["rowId"].as_u64())
        .collect();
    assert_eq!(ids, vec![5, 1]);
}

#[test]
fn the_plan_can_come_from_the_input_text() {
    let mut row = tool(1, "ExitPlanMode", "success", Value::Null);
    row.as_object_mut().unwrap().remove("input");
    row["inputText"] = json!(json!({"plan": "# text"}).to_string());
    assert_eq!(projection(vec![row]).plans().len(), 1);
}
