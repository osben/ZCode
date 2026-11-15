//! Fork: the per-workspace plugin and MCP layer of the shared task runtime
//! (specs/fork-rust-workspace-plugins-mcp.md). One slot per workspace key, loaded lazily at the
//! session's start like the hooks crate's project entries: the cli-side loader discovers the
//! workspace's project config (plugin enablement overlay and project MCP servers with resolved
//! cwds), the layer re-selects the plugin set for that view and starts the workspace's MCP group.
//! A project layer that cannot be read or parsed is fail-closed: no group starts and the
//! workspace's sessions keep the process set.

use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock, RwLock};

use crate::mcp::McpServer;
use async_trait::async_trait;
use rust_cli_base::sync::RwLockUnpoisoned;
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::machine::Files;
use rust_cli_kernel_api::workspace_key::project_key;

use crate::mcp::workspaces::WorkspaceMcp;
use crate::plugins::PluginSources;

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

/// Fork (specs/fork-rust-workspace-plugins-mcp.md, "As built"): receives a workspace's own plugin set when its
/// layer installs a `Loaded` slot; the runtime converts the set's hooks and registers them with the hooks engine
/// for that key. `ext` keeps no hooks types of its own, so the sink hands the set over.
pub type PluginHooksSink = Box<dyn Fn(&str, &Arc<crate::plugins::Plugins>) + Send + Sync>;

/// The per-workspace slots and the MCP groups they start. One load of a workspace runs at a
/// time: a concurrent session of the same workspace waits for the first load's slot, so a group
/// is never replaced mid-flight by a racing second load.
pub struct WorkspaceLayer {
    files: Arc<dyn Files>,
    mcp: Arc<WorkspaceMcp>,
    plugin_dirs: Vec<EnvPath>,
    /// The process-level MCP servers (user scope): every workspace's group runs them with its own
    /// working directory, like Node's per-app config read.
    servers: Vec<McpServer>,
    loader: OnceLock<Arc<dyn WorkspaceConfigLoader>>,
    /// The sink that receives an installed set's hooks (the runtime wires the engine behind it).
    hooks: OnceLock<PluginHooksSink>,
    slots: RwLock<BTreeMap<String, Slot>>,
    /// The keys with a load in flight; the Notify wakes the waiters when it finishes.
    loading: RwLock<std::collections::HashMap<String, Arc<tokio::sync::Notify>>>,
    /// The process workspace (its sessions read the process group, which already serves it).
    process: Option<WorkspaceRef>,
}

#[derive(Clone)]
pub enum Slot {
    /// The workspace's re-selected plugin set (its skill roots, agent files, hooks and MCP
    /// servers), kept for the session views that replace the process set for this workspace.
    Loaded(Arc<crate::plugins::Plugins>),
    Invalid,
}

impl WorkspaceLayer {
    pub(crate) fn new(
        files: Arc<dyn Files>,
        mcp: Arc<WorkspaceMcp>,
        plugin_dirs: Vec<EnvPath>,
        servers: Vec<McpServer>,
        process: Option<WorkspaceRef>,
    ) -> Self {
        Self {
            files,
            mcp,
            plugin_dirs,
            servers,
            loader: OnceLock::new(),
            hooks: OnceLock::new(),
            slots: RwLock::new(BTreeMap::new()),
            loading: RwLock::new(std::collections::HashMap::new()),
            process,
        }
    }

    pub fn set_loader(&self, loader: Arc<dyn WorkspaceConfigLoader>) {
        let _ = self.loader.set(loader);
    }

    /// Registers the sink that receives a workspace's plugin set at its layer's install (set once by the
    /// runtime, which owns the hooks engine).
    pub fn set_plugin_hooks_sink(&self, sink: PluginHooksSink) {
        let _ = self.hooks.set(sink);
    }

    /// The slot of `key`: the load guard reuses a `Loaded` slot, and the sessions resolve their
    /// MCP group through the manager, which only has a group for a `Loaded` slot.
    pub(crate) fn slot(&self, key: &str) -> Option<Slot> {
        self.slots.read_unpoisoned().get(key).cloned()
    }

    /// The workspace's plugin set when a layer is loaded for it (the process set otherwise, by
    /// the caller's `None`).
    pub fn plugins_of(&self, workspace: &WorkspaceRef) -> Option<Arc<crate::plugins::Plugins>> {
        let key = project_key(workspace.root.as_str());
        match self.slot(&key) {
            Some(Slot::Loaded(plugins)) => Some(plugins),
            _ => None,
        }
    }

    /// Fork: print mode reaches every group of the composite.
    pub(crate) fn set_print_session(&self, print: bool) {
        self.mcp.set_print_session(print);
    }

    /// Fork: the print startup wait covers the process group and every workspace group.
    pub(crate) async fn wait_for_print(&self) {
        self.mcp.wait_for_print_all().await;
    }

    /// Registers `key` for loading; `Err` carries the in-flight load's Notify to wait on.
    fn begin(&self, key: &str) -> Result<(), Arc<tokio::sync::Notify>> {
        let mut loading = self.loading.write_unpoisoned();
        if let Some(notify) = loading.get(key) {
            return Err(notify.clone());
        }
        loading.insert(key.to_owned(), Arc::new(tokio::sync::Notify::new()));
        Ok(())
    }

    /// The load of `key` finished: its waiters wake and read the slot it put.
    fn finish(&self, key: &str) {
        if let Some(notify) = self.loading.write_unpoisoned().remove(key) {
            notify.notify_waiters();
        }
    }

    /// Loads (or reloads) the layer of `workspace`. Fail-closed: a project layer that cannot be
    /// read or parsed stops the workspace's group and marks the slot `Invalid`, so its sessions
    /// keep the process set until the next successful load.
    pub(crate) async fn load(&self, workspace: &WorkspaceRef) {
        let key = project_key(workspace.root.as_str());
        if self
            .process
            .as_ref()
            .is_some_and(|process| project_key(process.root.as_str()) == key)
        {
            // The process group already serves exactly this workspace (the TUI and `-p`); a second
            // group would duplicate every connection.
            return;
        }
        // A loaded slot is reused: a second session of the same workspace must not replace the
        // group (that would cancel the first session's connections mid-flight). A slot stays until
        // the process ends; a later PR adds the config-change reload with epoch writes.
        if matches!(self.slot(&key), Some(Slot::Loaded(_))) {
            return;
        }
        let Some(loader) = self.loader.get().cloned() else {
            return;
        };
        // One load at a time: the caller that registers the key loads; every other caller waits for
        // the slot it puts (the notified future is created before the slot check, so a finish in
        // between cannot be missed).
        loop {
            let waiter = match self.begin(&key) {
                Ok(()) => break,
                Err(waiter) => waiter,
            };
            let notified = waiter.notified();
            if self.slot(&key).is_some() {
                return;
            }
            notified.await;
            if self.slot(&key).is_some() {
                return;
            }
        }
        // A cancelled open must not leave the claim behind: the guard releases it on drop unless
        // the normal path disarms it after `finish` (built before the first `.await`).
        let mut claim = Claim {
            layer: self,
            key: key.clone(),
            armed: true,
        };
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
                Slot::Loaded(Arc::new(loaded))
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
        let installed = match &slot {
            Slot::Loaded(plugins) => Some(plugins.clone()),
            Slot::Invalid => None,
        };
        self.slots.write_unpoisoned().insert(key.clone(), slot);
        // The sink runs after the slot is visible but before the waiters wake: a session that
        // proceeds on the new slot finds its plugin hooks already registered.
        if let (Some(sink), Some(plugins)) = (self.hooks.get(), installed) {
            sink(&key, &plugins);
        }
        self.finish(&key);
        claim.armed = false;
    }
}

/// Releases an abandoned load's claim: a session open cancelled mid-load must not leave the
/// workspace's waiters waiting until the process ends.
struct Claim<'a> {
    layer: &'a WorkspaceLayer,
    key: String,
    armed: bool,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.layer.finish(&self.key);
        }
    }
}

#[async_trait]
impl rust_cli_kernel_api::workspace_key::WorkspaceLayerHost for WorkspaceLayer {
    async fn load(&self, workspace: &WorkspaceRef) {
        WorkspaceLayer::load(self, workspace).await;
    }
}

#[cfg(test)]
#[path = "workspace_layer_tests.rs"]
mod tests;
