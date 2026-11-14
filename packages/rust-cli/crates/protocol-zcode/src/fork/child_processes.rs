//! Fork: `process/childProcesses` (Node `zcode-protocol/process-child-processes.ts`, specs/fork-rust-agent-parity.md
//! "`process/childProcesses`"). One row per live stdio MCP server process this agent started, in Node's
//! `{pid, serverName, mcpSource, pluginName?}` shape, so the Host's resource sampler can assign them to plugins.

use rust_cli_kernel_api::mcp::McpProcess;
use serde_json::{Value, json};

use crate::server::Server;

/// Node `PLUGIN_MCP_NAMESPACE_PREFIX`.
const PLUGIN_PREFIX: &str = "plugin:";
/// Node `BUILTIN_NODE_REPL_SERVER_NAME`.
const NODE_REPL: &str = "node_repl";
/// The first official plugin definition whose `hostMcpServerNames` lists `node_repl` (Node
/// `resolveOfficialPluginNameByHostMcpServerName`).
const NODE_REPL_PLUGIN: &str = "browser-use";

/// Node `resolveMcpSource`.
fn source(server: &str) -> &'static str {
    if server == NODE_REPL {
        "builtin"
    } else if server.starts_with(PLUGIN_PREFIX) {
        "plugin"
    } else {
        "custom"
    }
}

/// Node `resolvePluginName`, then the official plugin that hosts the server.
fn plugin_name(server: &str) -> Option<&str> {
    if let Some(rest) = server.strip_prefix(PLUGIN_PREFIX) {
        let name = rest.split(':').next().unwrap_or_default().trim();
        return (!name.is_empty()).then_some(name);
    }
    (server == NODE_REPL).then_some(NODE_REPL_PLUGIN)
}

fn row(process: &McpProcess) -> Value {
    let mut row = json!({
        "pid": process.pid,
        "serverName": process.server,
        "mcpSource": source(&process.server),
    });
    if let Some(name) = plugin_name(&process.server) {
        row["pluginName"] = json!(name);
    }
    row
}

pub(super) fn child_processes(server: &Server) -> Value {
    let processes: Vec<Value> = server
        .context
        .mcp_processes()
        .iter()
        .filter(|process| process.pid > 0)
        .map(row)
        .collect();
    json!({ "processes": processes })
}

#[cfg(test)]
#[path = "child_processes_tests.rs"]
mod tests;
