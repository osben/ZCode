//! Fork: the workspace key of a session's workspace and the session→workspace registry
//! (specs/fork-rust-workspace-plugins-mcp.md). `project_key` moved here from `rust-cli-hooks`
//! (projects.rs) so every per-workspace owner — hooks, plugins, MCP — shares one key derivation.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use crate::env::WorkspaceRef;
use crate::ids::SessionId;

/// The entry key of a workspace root (`workspaceIdentity?.trim() || workspacePath` for a local workspace). A trailing
/// separator of the path's own style does not make another workspace (on POSIX a backslash is a name character);
/// whitespace does, because only an explicit identity is trimmed.
pub fn project_key(root: &str) -> String {
    let style = crate::env_files::PathStyle::infer(root);
    let trimmed = root.trim_end_matches(|c| style.is_separator(c));
    if trimmed.is_empty() || (style == crate::env_files::PathStyle::Windows && trimmed.ends_with(':')) {
        // `/` and `C:\` keep their separator: without it they name another path.
        return root.to_owned();
    }
    trimmed.to_owned()
}

/// Process-wide map from session to the workspace its meta froze at create time: the one in-memory
/// owner the per-workspace reads (plugins, MCP groups) look a session up in. Recorded where a
/// session's meta is materialized (kernel create and open, subagent spawn), like
/// [`crate::incognito::IncognitoProfiles`]. A workspace, once recorded, never changes, so an entry
/// is never replaced or removed.
#[derive(Debug, Clone, Default)]
pub struct SessionWorkspaces(Arc<RwLock<HashMap<SessionId, WorkspaceRef>>>);

impl SessionWorkspaces {
    /// Record the workspace of `session`.
    pub fn record(&self, session: &SessionId, workspace: WorkspaceRef) {
        let mut map = self.0.write().unwrap_or_else(std::sync::PoisonError::into_inner);
        map.insert(session.clone(), workspace);
    }

    pub fn get(&self, session: &SessionId) -> Option<WorkspaceRef> {
        let map = self.0.read().unwrap_or_else(std::sync::PoisonError::into_inner);
        map.get(session).cloned()
    }
}

#[cfg(test)]
#[path = "workspace_key_tests.rs"]
mod tests;
