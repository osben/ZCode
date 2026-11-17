//! Node parity for the sized tool contract: `toolCategory` in Node's `classifier.ts` sizes ten contract fields for a
//! tool that is sent in full, and name and description only for a deferred one. The expected strings come from the
//! `tools` section of `tests/fixtures/composition_projection.json`, written by Node's own `stringifyForEstimation`.

use super::*;
use rust_cli_base::js::string::utf16_len;
use rust_cli_base::tokens::estimate_text;
use rust_cli_kernel_api::model::{ToolContract, ToolDefinition};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../tests/fixtures/composition_projection.json");

/// The tool each fixture case stands for, with the contract data the Rust side holds for it.
fn tool_for(name: &str) -> ToolDefinition {
    match name {
        "read_tool_full_contract" => ToolDefinition {
            name: "Read".to_owned(),
            description: "Read a file".to_owned(),
            input_schema: json!({"type": "object", "properties": {"file_path": {"type": "string"}}}),
            cache_control: None,
            contract: ToolContract {
                capability: Some("file_read".to_owned()),
                read_only: Some(true),
                destructive: Some(false),
                side_effect_scope: Some("none".to_owned()),
                ..ToolContract::default()
            },
        },
        "bash_tool_no_contract_flags" => ToolDefinition {
            name: "Bash".to_owned(),
            description: "Run a shell command".to_owned(),
            input_schema: json!({"type": "object", "properties": {"command": {"type": "string"}}}),
            cache_control: None,
            contract: ToolContract::default(),
        },
        "deferred_mcp_tool" => ToolDefinition {
            name: "mcp__github__search".to_owned(),
            description: "Search repositories".to_owned(),
            input_schema: json!({"type": "object"}),
            cache_control: None,
            contract: ToolContract {
                capability: Some("network".to_owned()),
                read_only: Some(true),
                ..ToolContract::default()
            },
        },
        other => panic!("no tool for fixture case {other}"),
    }
}

#[test]
fn every_tool_contract_is_sized_as_node_sizes_it() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture is JSON");
    let cases = fixture["tools"].as_array().expect("tools");
    assert_eq!(cases.len(), 3);
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let deferred = case["deferred"].as_bool().expect("deferred");
        let content = tool_content(&tool_for(name), deferred);
        assert_eq!(
            content,
            case["projected"].as_str().expect("projected"),
            "{name}: bytes"
        );
        assert_eq!(
            utf16_len(&content) as u64,
            case["chars"].as_u64().expect("chars"),
            "{name}: chars"
        );
        assert_eq!(
            estimate_text(&content),
            case["tokens"].as_u64().expect("tokens"),
            "{name}: tokens"
        );
    }
}
