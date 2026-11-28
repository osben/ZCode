//! The user MCP fallback `~/.agents/mcp.json` (Node `dynamic-mcp-config.ts` registers it for the user config path,
//! `adapters/src/mcp/config-loader.ts` reads it). It applies when the user config declares no server: a missing or
//! unreadable `~/.zcode/cli/config.json`, an empty `mcp.servers`, or one whose entries are all invalid. Its
//! `mcpServers` become user-scope servers, merged after the project layers, so they shadow a same-named project
//! server. No workspace review is involved (the source is the user's own home), and a stdio `cwd` resolves like any
//! user server's. A file that is not a JSON object yields nothing and a warning; a broken entry is skipped alone.
//!
//! Node's workspace trust discovery and `mcp/list` (without a Host list) read the config through `createConfig`,
//! which never sees this file, so `mcp_trust` does not know it either.

use rust_cli_ext::mcp::{McpScope, parse_node_servers};
use rust_cli_kernel_api::env_files::PathStyle;
use rust_cli_paths::StoragePaths;
use rust_cli_platform::local::{ConfigFile, read_user_agents_mcp};
use serde_json::{Map, Value};

use super::mcp_trust::{FALLBACK_DIR, FALLBACK_FILE};

/// The fallback read as a config layer: `{"mcp": {"servers": <mcpServers>}}`, so the ordinary user-layer merge
/// parses it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct UserFallback {
    pub(crate) path: String,
    pub(crate) object: Map<String, Value>,
}

/// Whether the user config leaves the fallback in effect: it declares no server (Node `patch.mcp.servers` empty
/// after the schema skipped invalid entries; a disabled entry still counts).
pub(crate) fn applies(user: Option<&Map<String, Value>>) -> bool {
    let table = user
        .and_then(|user| user.get("mcp"))
        .and_then(|mcp| mcp.get("servers"));
    match table {
        Some(table) => parse_node_servers(table, McpScope::User).0.is_empty(),
        None => true,
    }
}

/// The layer for `file`, or None when the file declares no server table.
pub(crate) fn from_file(path: &str, file: ConfigFile) -> Option<UserFallback> {
    let object = match file {
        ConfigFile::Missing => return None,
        ConfigFile::Invalid { reason } => {
            tracing::warn!(path, reason, "the user MCP fallback is ignored");
            return None;
        }
        ConfigFile::Loaded(object) => object,
    };
    let servers = match object.get("mcpServers") {
        None => return None,
        Some(Value::Object(servers)) => servers,
        Some(_) => {
            tracing::warn!(
                path,
                "the user MCP fallback ignores a non-object mcpServers"
            );
            return None;
        }
    };
    if servers.is_empty() {
        return None;
    }
    let mut mcp = Map::new();
    mcp.insert("servers".to_owned(), Value::Object(servers.clone()));
    let mut layer = Map::new();
    layer.insert("mcp".to_owned(), Value::Object(mcp));
    Some(UserFallback {
        path: path.to_owned(),
        object: layer,
    })
}

/// Reads `~/.agents/mcp.json` when the user config leaves it in effect.
pub(crate) async fn read(
    paths: &StoragePaths,
    user: Option<&Map<String, Value>>,
) -> Option<UserFallback> {
    if !applies(user) {
        return None;
    }
    let path = paths.user_agents_mcp().as_path().display().to_string();
    from_file(&path, read_user_agents_mcp(paths).await)
}

/// Whether `path` names a fallback file (`<dir>/.agents/mcp.json`): its servers sit under `mcpServers`, not
/// `mcp.servers`, so a toggle writes that shape.
pub(crate) fn is_fallback_path(path: &str) -> bool {
    let style = PathStyle::infer(path);
    style.file_name(path) == FALLBACK_FILE && style.file_name(&style.dirname(path)) == FALLBACK_DIR
}

#[cfg(test)]
#[path = "user_fallback_tests.rs"]
mod tests;
