//! Node's retired CUA MCP filter (`isRetiredCuaMcpServer`, `bootstrap/src/mcp-config.ts`, matchers in
//! `packages/shared/src/mcp.ts`). The standalone zcode-cua MCP server is historical config: computer use runs
//! through the shared `node_repl`, so every other CUA-shaped stdio entry is dropped before it connects or shows
//! in Settings. The match is deliberately wide (a false positive is preferred to a miss at this boundary).

use std::collections::BTreeMap;

use super::config::McpServer;
use rust_cli_kernel_api::mcp::McpTransportConfig;

/// The one supported CUA host; it may carry the CUA plugin's id and is never retired.
const NODE_REPL_SERVER_NAME: &str = "node_repl";
/// The server name the old standalone CUA entry used.
const COMPUTER_USE_SERVER_NAME: &str = "computer-use";
/// Node `ZCODE_PLUGIN_ID_ENV_KEY` and `ZCODE_CUA_OFFICIAL_PLUGIN_ID`.
const PLUGIN_ID_ENV_KEY: &str = "ZCODE_PLUGIN_ID";
const CUA_OFFICIAL_PLUGIN_ID: &str = "computer-use@zcode-plugins-official";
const CUA_PACKAGE: &str = "zcode-cua";

/// Node `zcodeCuaArgLeaf`: the last path segment after trailing separators are removed.
fn leaf(value: &str) -> &str {
    let trimmed = value.trim_end_matches(['/', '\\']);
    trimmed.rsplit(['/', '\\']).next().unwrap_or(value)
}

/// Node `matchesZCodeCuaSpec`: `_` equals `-`, then the package name alone or followed by `[`, `@`, `==` or `.`
/// (`zcode-cua-proxy` stays out). Case-sensitive.
fn matches_spec(candidate: &str) -> bool {
    let normalized = candidate.replace('_', "-");
    normalized.strip_prefix(CUA_PACKAGE).is_some_and(|rest| {
        rest.is_empty() || ["[", "@", "==", "."].iter().any(|p| rest.starts_with(p))
    })
}

/// Node `isZCodeCuaMcpCommand` and `isZCodeCuaMcpPackageArg`: the raw value or its leaf names zcode-cua.
fn names_package(value: &str) -> bool {
    matches_spec(value) || matches_spec(leaf(value))
}

/// The retired check over the parts of a stdio server (Node `isZCodeCuaStdioServer`, `type === "stdio"`).
pub fn is_retired_cua_stdio(
    name: &str,
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> bool {
    if name == NODE_REPL_SERVER_NAME {
        return false;
    }
    name == COMPUTER_USE_SERVER_NAME
        || env
            .get(PLUGIN_ID_ENV_KEY)
            .is_some_and(|id| id.trim().to_lowercase() == CUA_OFFICIAL_PLUGIN_ID)
        || names_package(command)
        || args.iter().any(|arg| names_package(arg))
}

/// Node `isRetiredCuaMcpServer(name, config)` over a configured server. Only stdio servers can be retired.
pub fn is_retired_cua_server(server: &McpServer) -> bool {
    match &server.transport {
        McpTransportConfig::Stdio {
            command, args, env, ..
        } => is_retired_cua_stdio(&server.name, command, args, env),
        McpTransportConfig::Sse { .. }
        | McpTransportConfig::Http { .. }
        | McpTransportConfig::NodeHelper => false,
    }
}

#[cfg(test)]
#[path = "retired_tests.rs"]
mod tests;
