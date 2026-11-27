//! Fork (specs/fork-rust-context-breakdown.md): the `{source, chars}` list the App's context usage shows.

use rust_cli_kernel_api::model::{SystemBlock, ToolDefinition};
use serde_json::json;

use super::*;

fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        contract: Default::default(),
        name: name.to_owned(),
        description: "does things".to_owned(),
        input_schema: json!({"type": "object"}),
        cache_control: None,
    }
}

fn system(text: &str) -> SystemBlock {
    SystemBlock {
        text: text.to_owned(),
        cache_control: None,
    }
}

fn classify_tools(system: &[SystemBlock], tools: &[(ToolDefinition, bool)]) -> Breakdown {
    let parts: Vec<ToolPart<'_>> = tools
        .iter()
        .map(|(definition, deferred)| ToolPart {
            definition,
            deferred: *deferred,
        })
        .collect();
    classify(&Input {
        system,
        messages: &[],
        tools: &parts,
    })
}

fn source_names(breakdown: &Breakdown) -> Vec<&'static str> {
    usage_sources(breakdown)
        .iter()
        .map(|(source, _, _)| source.as_str())
        .collect()
}

#[test]
fn a_deferred_mcp_tool_counts_as_mcp_and_a_deferred_built_in_as_system() {
    let breakdown = classify_tools(
        &[],
        &[
            (tool("mcp__github__search"), true),
            (tool("WebFetch"), true),
        ],
    );
    assert_eq!(
        source_names(&breakdown),
        ["system_tool_schemas", "mcp_tool_schemas"]
    );
}

#[test]
fn a_name_that_is_not_a_full_mcp_tool_name_is_not_mcp() {
    // Node `parseMcpToolName` needs a server and a tool part.
    let breakdown = classify_tools(&[], &[(tool("mcp__only"), true), (tool("mcp____x"), true)]);
    assert_eq!(source_names(&breakdown), ["system_tool_schemas"]);
}

#[test]
fn breakdown_items_are_the_non_zero_sources_with_their_chars_in_ring_order() {
    let breakdown = classify_tools(
        &[system("sys")],
        &[(tool("Read"), false), (tool("mcp__s__t"), false)],
    );
    let items = usage_breakdown(&breakdown);
    let names: Vec<&str> = items.iter().map(|item| item.source.as_str()).collect();
    assert_eq!(
        names,
        ["system_prompt", "system_tool_schemas", "mcp_tool_schemas"]
    );
    assert_eq!(items[0].chars, 3);
    assert!(items.iter().all(|item| item.chars > 0));
}

#[test]
fn an_empty_request_has_an_empty_breakdown() {
    assert!(usage_breakdown(&classify_tools(&[], &[])).is_empty());
}
