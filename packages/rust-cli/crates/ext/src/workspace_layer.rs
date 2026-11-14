//! Fork: the per-workspace plugin and MCP layer of the shared task runtime
//! (specs/fork-rust-workspace-plugins-mcp.md). One slot per workspace key, loaded lazily at the
//! session's start like the hooks crate's project entries: the cli-side loader discovers the
//! workspace's project config (plugin enablement overlay and project MCP servers with resolved
//! cwds), the layer re-selects the plugin set for that view and starts the workspace's MCP group.
//! A project layer that cannot be read or parsed is fail-closed: no group starts and the
//! workspace's sessions keep the process set.

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock, RwLock};

use async_trait::async_trait;
use rust_cli_base::sync::RwLockUnpoisoned;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::machine::Files;
use crate::mcp::McpServer;
use rust_cli_kernel_api::workspace_key::project_key;

use crate::plugins::PluginSources;
use crate::mcp::workspaces::WorkspaceMcp;

/// The project layer of one workspace: the effective plugin sources (the process candidates with
/// the project `enabledPlugins`/`suppressedBuiltins` overlay applied — a project layer never
/// contributes plugin `dirs`) and the workspace's project MCP servers with their stdio cwds
/// resolved against each declaring file's base directory.
#[derive(Clone)]
pub struct WorkspaceConfig {
    pub plugins: PluginSources,
    pub servers: Vec<McpServer>,
}

/// Discovers a workspace's project layer (the cli owns the IO and Node's merge semantics).
/// `None` is the fail-closed case: a project file could not be read or parsed.
#[async_trait]
pub trait WorkspaceConfigLoader: Send + Sync {
    async fn load(&self, workspace: &WorkspaceRef) -> Option<WorkspaceConfig>;
}

/// The per-workspace slots and the MCP groups they start. Loads serialize on one mutex: two
/// sessions of one workspace load it once, and a reload (a config change epoch) replaces the group.
pub struct WorkspaceLayer {
    files: Arc<dyn Files>,
    mcp: Arc<WorkspaceMcp>,
    plugin_dirs: Vec<EnvPath>,
    /// The process-level MCP servers (user scope): every workspace's group runs them with its own
    /// working directory, like Node's per-app config read.
    servers: Vec<McpServer>,
    loader: OnceLock<Arc<dyn WorkspaceConfigLoader>>,
    loads: tokio::sync::Mutex<BTreeMap<String, ()>>,
    slots: RwLock<BTreeMap<String, Slot>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Slot {
    Loaded,
    Invalid,
}

impl WorkspaceLayer {
    pub fn new(
        files: Arc<dyn Files>,
        mcp: Arc<WorkspaceMcp>,
        plugin_dirs: Vec<EnvPath>,
        servers: Vec<McpServer>,
    ) -> Self {
        Self {
            files,
            mcp,
            plugin_dirs,
            servers,
            loader: OnceLock::new(),
            loads: tokio::sync::Mutex::new(BTreeMap::new()),
            slots: RwLock::new(BTreeMap::new()),
        }
    }

    pub fn set_loader(&self, loader: Arc<dyn WorkspaceConfigLoader>) {
        let _ = self.loader.set(loader);
    }

    /// The slot of `key` (read by tests and diagnostics; the sessions resolve their MCP group
    /// through the manager, which only has a group for a `Loaded` slot).
    pub fn slot(&self, key: &str) -> Option<Slot> {
        self.slots.read_unpoisoned().get(key).copied()
    }

    /// Loads (or reloads) the layer of `workspace`. Fail-closed: a project layer that cannot be
    /// read or parsed stops the workspace's group and marks the slot `Invalid`, so its sessions
    /// keep the process set until the next successful load.
    pub async fn load(&self, workspace: &WorkspaceRef) {
        let key = project_key(workspace.root.as_str());
        let Some(loader) = self.loader.get().cloned() else {
            return;
        };
        // One load of a workspace at a time; a concurrent session's call waits and then finds the
        // fresh slot. The guard is taken for the whole discovery so a reload cannot interleave.
        let _guard = self.loads.lock().await;
        let slot = match loader.load(workspace).await {
            Some(config) => {
                let loaded = crate::plugins::load_all(
                    self.files.as_ref(),
                    workspace,
                    &self.plugin_dirs,
                    &config.plugins,
                )
                .await
                .plugins;
                let mut servers = self.servers.clone();
                servers.extend(loaded.mcp_servers());
                servers.extend(config.servers);
                self.mcp.start(&key, workspace.clone(), servers);
                Slot::Loaded
            }
            None => {
                tracing::warn!(
                    workspace = workspace.root.as_str(),
                    "the workspace plugin/MCP layer could not be loaded; the process set stays"
                );
                self.mcp.stop(&key);
                Slot::Invalid
            }
        };
        self.slots
            .write_unpoisoned()
            .insert(key, slot);
    }
}

#[cfg(test)]
#[path = "workspace_layer_tests.rs"]
mod tests;
