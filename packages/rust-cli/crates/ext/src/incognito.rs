//! Fork (desktop App): what an incognito profile removes from the extensions (specs/fork-rust-agent-parity.md,
//! "Incognito sessions"). Node starts an incognito session's CLI with the excluded sources left out of its config;
//! zcode-rs shares one process between sessions, so every gate reads the session's profile instead.
//!
//! - MCP servers: plugin servers follow `plugins`, every other server follows `mcp` (Node keeps plugin servers when
//!   only `mcp` is off).
//! - The resource tools and WaitForMcpServers are global, so they stay only while both `mcp` and `plugins` are kept.
//! - The Cron tools follow `automationTools`.
//! - The five Cron tools are also hidden in a session on a remote workspace identity, with or without a profile (Node
//!   `resolveSessionToolDenylist`: a remote workspace has no reliable trigger boundary for the Host's scheduler).

use std::sync::Arc;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::incognito::{IncognitoProfile, IncognitoProfiles, IncognitoToolGate};
use rust_cli_kernel_api::tool::Tool;
use rust_cli_kernel_api::tool_names;

use crate::mcp::McpScope;

/// Tools that read every server instead of one.
const GLOBAL_MCP_TOOLS: [&str; 4] = [
    tool_names::LIST_MCP_RESOURCES,
    tool_names::READ_MCP_RESOURCE,
    tool_names::READ_MCP_RESOURCE_DIR,
    tool_names::WAIT_FOR_MCP_SERVERS,
];

/// Node's incognito `automationTools`: whether `profile` hides the tool `name`; `None` when it is not a Cron tool.
fn hides_automation_tool(profile: &IncognitoProfile, name: &str) -> Option<bool> {
    (tool_names::CRON_TOOLS.contains(&name) || tool_names::OFF_PEAK_TOOLS.contains(&name))
        .then_some(!profile.automation_tools)
}

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
    /// Fork (specs/fork-rust-workspace-plugins-mcp.md): the workspace groups; a session's scope
    /// checks resolve its group, so an allowed workspace server is not judged by the process set.
    workspace_mcp: Arc<crate::mcp::workspaces::WorkspaceMcp>,
    sessions: rust_cli_kernel_api::workspace_key::SessionWorkspaces,
}

impl IncognitoTools {
    pub(crate) fn new(
        profiles: IncognitoProfiles,
        workspace_mcp: Arc<crate::mcp::workspaces::WorkspaceMcp>,
        sessions: rust_cli_kernel_api::workspace_key::SessionWorkspaces,
    ) -> Self {
        Self {
            profiles,
            workspace_mcp,
            sessions,
        }
    }

    /// Whether the session's workspace key is a well-formed remote identity (Node `isRemoteWorkspaceIdentity`; a
    /// malformed `remote:` key is not remote there either).
    fn on_remote_workspace(&self, session: &SessionId) -> bool {
        self.sessions.get(session).is_some_and(|workspace| {
            rust_cli_kernel_api::remote_identity::is_remote_workspace_identity(
                workspace.root.as_str(),
            )
        })
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
        if tool_names::CRON_TOOLS.contains(&tool.name()) && self.on_remote_workspace(session) {
            return true;
        }
        let Some(profile) = self.profiles.get(session) else {
            return false;
        };
        let name = tool.name();
        if let Some(hidden) = hides_automation_tool(&profile, name) {
            return hidden;
        }
        if let Some(info) = tool.mcp_info() {
            // A server that is gone has no scope to admit it. Fork: the lookup goes through the
            // session's workspace group, falling back to the process manager.
            let mcp = self.workspace_mcp.for_session(&self.sessions, session);
            return !mcp
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
