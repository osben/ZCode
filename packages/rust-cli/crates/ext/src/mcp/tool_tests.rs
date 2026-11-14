//! 工具自己的不延迟标记（docs/specs/rust-cli/ext.md §3.1、D35）：`_meta` 里新旧两个键任一为 true 就不延迟。
use std::sync::Weak;

use serde_json::{Value, json};

use super::McpTool;

fn always_load(listed: &Value, server_always_load: bool) -> bool {
    McpTool::from_listed("files", listed, server_always_load, Weak::new())
        .unwrap()
        .info
        .always_load
}

fn with_meta(meta: Value) -> Value {
    json!({"name": "read", "inputSchema": {"type": "object"}, "_meta": meta})
}

#[test]
fn either_meta_key_keeps_the_tool_loaded() {
    assert!(always_load(
        &with_meta(json!({"zcode/alwaysLoad": true})),
        false
    ));
    // 旧键：Node 与已有的 MCP 服务器用它。
    assert!(always_load(
        &with_meta(json!({"anthropic/alwaysLoad": true})),
        false
    ));
}

#[test]
fn other_values_and_keys_leave_the_tool_deferred() {
    for meta in [
        json!({"anthropic/alwaysLoad": false}),
        json!({"anthropic/alwaysLoad": "true"}),
        json!({"zcode/alwaysLoad": 1}),
        json!({"other/alwaysLoad": true}),
        json!({"alwaysLoad": true}),
        json!(null),
    ] {
        assert!(!always_load(&with_meta(meta.clone()), false), "{meta}");
    }
    assert!(!always_load(&json!({"name": "read"}), false));
}

#[test]
fn the_server_option_does_not_look_at_the_tool() {
    assert!(always_load(&json!({"name": "read"}), true));
    assert!(always_load(
        &with_meta(json!({"anthropic/alwaysLoad": false})),
        true
    ));
}

fn destructive(listed: Value) -> bool {
    McpTool::from_listed("files", &listed, false, Weak::new())
        .unwrap()
        .destructive
}

/// Fork: Node counts `destructiveHint` only when it is literally `true` (specs/fork-rust-agent-parity.md).
#[test]
fn only_a_true_destructive_hint_marks_the_tool_destructive() {
    assert!(destructive(
        json!({"name": "reset", "annotations": {"destructiveHint": true}})
    ));
    for listed in [
        json!({"name": "lookup", "annotations": {"destructiveHint": false}}),
        json!({"name": "lookup", "annotations": {"destructiveHint": "true"}}),
        json!({"name": "lookup", "annotations": {}}),
        json!({"name": "lookup"}),
    ] {
        assert!(!destructive(listed));
    }
}

/// Fork (specs/fork-rust-node-helper.md F3): only a helper-hosted server's call carries the helper context, so the
/// helper runs it on that session's lease; a subagent's call says so.
#[test]
fn helper_hosted_calls_carry_the_helper_context() {
    assert_eq!(
        super::call_meta("toolu_1", None),
        json!({"zcode/toolUseId": "toolu_1"})
    );
    assert_eq!(
        super::call_meta(
            "toolu_2",
            Some(super::HelperCall {
                session: "s-1",
                turn: "run-1",
                subagent: false
            })
        ),
        json!({
            "zcode/toolUseId": "toolu_2",
            "zcode/helperContext": {"sessionId": "s-1", "turnId": "run-1", "runtimeScope": "main"}
        })
    );
    assert_eq!(
        super::call_meta(
            "toolu_3",
            Some(super::HelperCall {
                session: "s-2",
                turn: "run-2",
                subagent: true
            })
        )["zcode/helperContext"]["runtimeScope"],
        "subagent"
    );
}

/// Fork (specs/fork-rust-node-helper.md F3, `helper/authorizeAppTool`): the transient tool of an App call is named and
/// shaped like a listed tool of that server, so rules and hooks match it as they match the model's calls.
#[test]
fn an_app_tool_is_shaped_like_a_listed_tool_of_its_server() {
    let tool = super::app_tool(
        "plugin:viewer:view",
        "search",
        &json!({
            "description": "Search the viewer",
            "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}},
            "annotations": {"readOnlyHint": true},
        }),
    );
    assert_eq!(tool.name(), "mcp__plugin_viewer_view__search");
    assert_eq!(
        tool.input_schema(),
        json!({"type": "object", "properties": {"query": {"type": "string"}}})
    );
    assert!(tool.is_read_only(&json!({})));
    let info = tool.mcp_info().expect("an MCP tool");
    assert_eq!(
        (info.server.as_str(), info.tool.as_str()),
        ("plugin:viewer:view", "search")
    );
    // A descriptor without a schema gets the listed tools' default.
    let bare = super::app_tool("plugin:viewer:view", "open", &json!({}));
    assert_eq!(bare.input_schema(), json!({"type": "object"}));
    assert!(!bare.is_read_only(&json!({})));
}

/// Fork: Node's MCP cancel message names the registered tool (core `mcp/index.ts` `createMcpToolEntry`,
/// `MCP tool ${name} was cancelled`).
#[test]
fn a_cancelled_mcp_call_names_the_registered_tool() {
    use rust_cli_kernel_api::tool::Tool;
    let tool = McpTool::from_listed(
        "files",
        &json!({"name": "read", "inputSchema": {"type": "object"}}),
        false,
        Weak::new(),
    )
    .unwrap();
    assert_eq!(tool.name(), "mcp__files__read");
    assert_eq!(
        tool.cancel_message().as_deref(),
        Some("MCP tool mcp__files__read was cancelled")
    );
}
