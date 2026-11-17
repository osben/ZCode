//! MCP 名字规范化（ext.md §3.4）。

use super::*;

#[test]
fn names_keep_only_api_safe_characters() {
    assert_eq!(normalize_name("my server.v2"), "my_server_v2");
    assert_eq!(tool_name("files", "read-file"), "mcp__files__read-file");
    assert_eq!(
        tool_name("plugin:kit:db", "query"),
        "mcp__plugin_kit_db__query"
    );
    // Fork (PLM-LC-010): the desktop spec asserts this exact composition for the installed plugin's server
    // (`plugin:<plugin>:<server>` — dashes stay, only the non `[a-zA-Z0-9_-]` run turns into `_`).
    assert_eq!(
        tool_name(
            "plugin:e2e-plugin-secret-agent:secret-verifier",
            "verify_secret_env"
        ),
        "mcp__plugin_e2e-plugin-secret-agent_secret-verifier__verify_secret_env"
    );
    assert_eq!(McpSettings::default().max_output_tokens, 25_000);
}
