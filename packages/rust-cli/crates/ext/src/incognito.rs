//! Fork (desktop App): what an incognito profile removes from the extensions (specs/fork-rust-agent-parity.md,
//! "Incognito sessions"). Node starts an incognito session's CLI with the excluded sources left out of its config;
//! zcode-rs shares one process between sessions, so every gate reads the session's profile instead.
//!
//! - MCP servers: plugin servers follow `plugins`, every other server follows `mcp` (Node keeps plugin servers when
//!   only `mcp` is off).
//! - The resource tools and WaitForMcpServers are global, so they stay only while both `mcp` and `plugins` are kept.
//! - The Cron tools follow `automationTools`.

use std::sync::Arc;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::incognito::{IncognitoProfile, IncognitoProfiles, IncognitoToolGate};
use rust_cli_kernel_api::tool::Tool;
use rust_cli_kernel_api::tool_names;

use crate::mcp::{McpManager, McpScope};

/// Tools that read every server instead of one.
const GLOBAL_MCP_TOOLS: [&str; 4] = [
    tool_names::LIST_MCP_RESOURCES,
    tool_names::READ_MCP_RESOURCE,
    tool_names::READ_MCP_RESOURCE_DIR,
    tool_names::WAIT_FOR_MCP_SERVERS,
];

const AUTOMATION_TOOLS: [&str; 3] = [
    tool_names::CRON_CREATE,
    tool_names::CRON_DELETE,
    tool_names::CRON_LIST,
];

/// Whether the profile keeps an MCP server of `scope`.
pub(crate) fn keeps_scope(profile: &IncognitoProfile, scope: McpScope) -> bool {
    match scope {
        McpScope::Plugin => profile.plugins,
        _ => profile.mcp,
    }
}

/// The incognito tool gate over the extensions' tools and the built-in automation tools.
#[derive(Clone)]
pub struct IncognitoTools {
    profiles: IncognitoProfiles,
    mcp: Arc<McpManager>,
}

impl IncognitoTools {
    pub(crate) fn new(profiles: IncognitoProfiles, mcp: Arc<McpManager>) -> Self {
        Self { profiles, mcp }
    }

    pub(crate) fn profile(&self, session: &SessionId) -> Option<IncognitoProfile> {
        self.profiles.get(session)
    }

    pub(crate) fn profiles(&self) -> &IncognitoProfiles {
        &self.profiles
    }
}

impl IncognitoToolGate for IncognitoTools {
    fn hides(&self, session: &SessionId, tool: &dyn Tool) -> bool {
        let Some(profile) = self.profiles.get(session) else {
            return false;
        };
        let name = tool.name();
        if AUTOMATION_TOOLS.contains(&name) {
            return !profile.automation_tools;
        }
        if let Some(info) = tool.mcp_info() {
            // A server that is gone has no scope to admit it.
            return !self
                .mcp
                .scope_of(&info.server)
                .is_some_and(|scope| keeps_scope(&profile, scope));
        }
        if GLOBAL_MCP_TOOLS.contains(&name) {
            return !(profile.mcp && profile.plugins);
        }
        false
    }
}

#[cfg(test)]
#[path = "incognito_tests.rs"]
mod tests;
