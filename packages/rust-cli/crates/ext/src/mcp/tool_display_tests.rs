//! Fork: an MCP tool call carries Node's `mcp_tool` display (specs/fork-rust-plugin-ui-tool-result.md, rules 1 and 5).
use std::sync::Arc;

use rust_cli_base::TaskScope;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use rust_cli_kernel_api::permission::PermissionMode;
use rust_cli_kernel_api::testing::MemoryEnvironment;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::mcp::{McpManager, McpScope, McpServer, McpSettings};
use crate::test_support::{FakeMcp, facts, server, tool_context, workspace};

fn viewer() -> McpServer {
    McpServer {
        name: "viewer".to_owned(),
        scope: McpScope::Project,
        transport: McpTransportConfig::stdio("node".to_owned(), Vec::new()),
        options: Default::default(),
        oauth: None,
        machine: Default::default(),
    }
}

async fn called(tool: &str, plugin_id: Option<&str>) -> rust_cli_kernel_api::tool::ToolOutput {
    let fake = Arc::new(FakeMcp::default().with(
        "viewer",
        server(json!({"tools": {}}), None, |method, params| match method {
            "tools/list" => Some(Ok(json!({"tools": [
                {"name": "open", "description": "Opens the editor", "inputSchema": {"type": "object"},
                 "_meta": {"ui": {"resourceUri": "ui://viewer/editor.html", "visibility": ["model", "app"]}}},
                {"name": "plain", "inputSchema": {"type": "object"}},
                {"name": "broken", "inputSchema": {"type": "object"},
                 "_meta": {"ui": {"resourceUri": "ui://viewer/editor.html"}}},
            ]}))),
            "tools/call" if params["name"] == "broken" => Some(Ok(
                json!({"isError": true, "content": [{"type": "text", "text": "it failed"}]}),
            )),
            "tools/call" => Some(Ok(json!({
                "content": [{"type": "text", "text": "opened"}],
                "structuredContent": {"doc": 1},
            }))),
            _ => None,
        }),
    ));
    let scope = TaskScope::root("test", |_| {});
    let manager = McpManager::new(
        fake,
        scope.spawner(),
        McpSettings::default(),
        crate::clock_tests::clock(),
    );
    if let Some(id) = plugin_id {
        manager.note_plugin_ids([("viewer".to_owned(), id.to_owned())]);
    }
    manager.start(workspace(), vec![viewer()]);
    manager.wait_ready().await;
    let context = tool_context(
        Arc::new(MemoryEnvironment::new(facts())),
        PermissionMode::Default,
    );
    let (progress, _ignored) = mpsc::channel(4);
    manager
        .find(&format!("mcp__viewer__{tool}"))
        .expect("the tool is listed")
        .call(json!({"file": "a.md"}), context, progress)
        .await
        .unwrap()
}

#[tokio::test]
async fn a_ui_tool_result_carries_the_display_with_the_plugin_id() {
    let output = called("open", Some("viewer@market")).await;
    assert!(!output.is_error);
    assert_eq!(
        output.display,
        json!({
            "kind": "mcp_tool", "serverName": "viewer", "toolName": "open",
            "description": "Opens the editor",
            "ui": {"pluginId": "viewer@market", "resourceUri": "ui://viewer/editor.html",
                   "structuredContent": "{\"doc\":1}", "content": "[{\"type\":\"text\",\"text\":\"opened\"}]"}
        })
    );
}

#[tokio::test]
async fn without_a_plugin_the_server_name_is_the_plugin_id() {
    let output = called("open", None).await;
    assert_eq!(output.display["ui"]["pluginId"], "viewer");
}

#[tokio::test]
async fn a_tool_without_ui_still_carries_the_display() {
    let output = called("plain", Some("viewer@market")).await;
    assert_eq!(
        output.display,
        json!({"kind": "mcp_tool", "serverName": "viewer", "toolName": "plain"})
    );
}

#[tokio::test]
async fn an_error_result_keeps_its_row_status_and_marks_the_ui() {
    let output = called("broken", Some("viewer@market")).await;
    assert!(output.is_error);
    let ui: &Value = &output.display["ui"];
    assert_eq!(ui["isError"], true);
    assert_eq!(ui["pluginId"], "viewer@market");
}
