//! Fork: the MCP groups of the shared task runtime's workspaces
//! (specs/fork-rust-workspace-plugins-mcp.md). One [`McpManager`] instance per workspace key — the
//! process group serves the TUI, `-p` and sessions without a workspace; a session with a recorded
//! workspace reads its own group's snapshot, like Node's per-app pool keyed by
//! `workspaceIdentity || workingDirectory`. Each instance keeps every per-server semantic
//! (generations, reconnect, deferred and dormant servers) unchanged and owns its connections.

use std::collections::HashMap;
use std::sync::Arc;

use std::sync::RwLock;

use rust_cli_base::Spawner;
use rust_cli_base::sync::RwLockUnpoisoned;
use rust_cli_kernel_api::clock::Clock;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::env_registry::EnvironmentRegistry;
use rust_cli_kernel_api::mcp::McpTransport;

use super::config::{McpServer, McpSettings};
use super::manager::McpManager;

/// The empty key of the process group (the workspace the process was started in).
pub(crate) const PROCESS: &str = "";

/// The MCP connection groups: the process group plus one per workspace key.
///
/// A group is created by [`Self::start`] when a workspace's layer is loaded; sessions resolve their
/// group through [`rust_cli_kernel_api::workspace_key::SessionWorkspaces`]. Names are independent
/// across groups (Node's per-app pools run same-named servers separately).
pub(crate) struct WorkspaceMcp {
    transport: Arc<dyn McpTransport>,
    spawner: Spawner,
    settings: McpSettings,
    clock: Arc<dyn Clock>,
    machines: Option<Arc<dyn EnvironmentRegistry>>,
    process: Arc<McpManager>,
    groups: RwLock<HashMap<String, Arc<McpManager>>>,
    /// Fork: print mode is process-wide; groups created later inherit it.
    print: std::sync::atomic::AtomicBool,
}

impl WorkspaceMcp {
    pub(crate) fn new(
        transport: Arc<dyn McpTransport>,
        spawner: Spawner,
        settings: McpSettings,
        clock: Arc<dyn Clock>,
        machines: Option<Arc<dyn EnvironmentRegistry>>,
        process: Arc<McpManager>,
    ) -> Self {
        Self {
            transport,
            spawner,
            settings,
            clock,
            machines,
            process,
            groups: RwLock::default(),
            print: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Fork: the print startup wait covers the process group and every workspace group (the print
    /// entry prewarms a resumed workspace before waiting, so its group exists here).
    pub(crate) async fn wait_for_print_all(&self) {
        let groups: Vec<Arc<McpManager>> = {
            let mut all = vec![self.process.clone()];
            all.extend(self.groups.read_unpoisoned().values().cloned());
            all
        };
        for manager in groups {
            manager.wait_for_print().await;
        }
    }

    /// Fork: print mode is process-wide; groups created later inherit it.
    pub(crate) fn set_print_session(&self, print: bool) {
        self.print
            .store(print, std::sync::atomic::Ordering::Relaxed);
    }

    /// The process group (the TUI, `-p` and sessions without a workspace); read by the tests.
    #[cfg(test)]
    pub(crate) fn process(&self) -> &Arc<McpManager> {
        &self.process
    }

    /// The group of `key`, if a loaded layer started one.
    pub(crate) fn group(&self, key: &str) -> Option<Arc<McpManager>> {
        if key == PROCESS {
            return Some(self.process.clone());
        }
        self.groups.read_unpoisoned().get(key).cloned()
    }

    /// Fork: the group a session reads — its workspace's group when a loaded layer started one,
    /// else the process group (no workspace, an `Invalid` slot, or the TUI/`-p`).
    pub(crate) fn for_session(
        &self,
        sessions: &rust_cli_kernel_api::workspace_key::SessionWorkspaces,
        session: &rust_cli_kernel_api::ids::SessionId,
    ) -> Arc<McpManager> {
        sessions
            .get(session)
            .map(|workspace| {
                rust_cli_kernel_api::workspace_key::project_key(workspace.root.as_str())
            })
            .and_then(|key| self.group(&key))
            .unwrap_or_else(|| self.process.clone())
    }

    /// Starts (or replaces) the group of `key` with the workspace's server list. A replaced group's
    /// connections stop ([`McpManager::shutdown`]), so a config change reloads the whole group like
    /// Node re-reads the app's config; the sessions of the workspace see the new set on their next
    /// snapshot. The print startup wait of a resumed workspace runs in the print entry's prewarm
    /// (`frontends/print.rs`), where it stays cancellable against the stop token.
    pub(crate) fn start(&self, key: &str, workspace: WorkspaceRef, servers: Vec<McpServer>) {
        if key == PROCESS {
            self.process.start(workspace, servers);
            return;
        }
        let manager = McpManager::new(
            self.transport.clone(),
            self.spawner.clone(),
            self.settings.clone(),
            self.clock.clone(),
        );
        if let Some(machines) = self.machines.clone() {
            manager.set_machines(machines);
        }
        if self.print.load(std::sync::atomic::Ordering::Relaxed) {
            manager.set_print_session(true);
        }
        manager.start(workspace, servers);
        if let Some(previous) = self
            .groups
            .write_unpoisoned()
            .insert(key.to_owned(), Arc::new(manager))
        {
            previous.shutdown();
        }
    }

    /// Stops the group of `key` (a slot that turned `Invalid`): its connections end and the
    /// sessions of that workspace fall back to the process group.
    pub(crate) fn stop(&self, key: &str) {
        if key == PROCESS {
            return;
        }
        if let Some(manager) = self.groups.write_unpoisoned().remove(key) {
            manager.shutdown();
        }
    }
}

#[cfg(test)]
#[path = "workspaces_tests.rs"]
mod tests;
