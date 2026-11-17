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

    /// The user-scope servers the config holds now. A load runs these, not the process-start snapshot the layer
    /// was built with: the user config can change after the process started (Node's per-app pool reads it at each
    /// connect). `None` keeps the snapshot.
    async fn user_servers(&self, _workspace: &WorkspaceRef) -> Option<Vec<McpServer>> {
        None
    }
}

/// Fork (specs/fork-rust-workspace-plugins-mcp.md, "As built"): receives a workspace's own plugin set when its
/// layer installs a `Loaded` slot; the runtime converts the set's hooks and registers them with the hooks engine
/// for that key. `ext` keeps no hooks types of its own, so the sink hands the set over. The sink runs INSIDE the
/// layer's slots write lock: it must not re-enter the layer (the runtime's registration only touches the hooks
/// engine, so it does not).
pub type PluginHooksSink = Box<dyn Fn(&str, &Arc<crate::plugins::Plugins>) + Send + Sync>;

/// The per-workspace slots and the MCP groups they start. One load of a workspace runs at a
/// time: a concurrent session of the same workspace waits for the first load's slot, so a group
/// is never replaced mid-flight by a racing second load. A reload (a config or trust write a caller
/// committed) does not queue behind that: epoch-ordered writes arbitrate the two.
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
    slots: RwLock<Slots>,
    /// The keys with a load in flight; the Notify wakes the waiters when it finishes.
    loading: RwLock<std::collections::HashMap<String, Arc<tokio::sync::Notify>>>,
    /// The process workspace (its sessions read the process group, which already serves it).
    process: Option<WorkspaceRef>,
}

/// The installed slots with the epoch of the write that put each. An epoch is taken (reserved)
/// before a write reads, and a put is refused when a later reservation already installed — the
/// hooks engine's `reserve_project`/`put_project_at` shape (specs/fork-rust-workspace-plugins-mcp.md,
/// "As built: layer reload").
struct Slots {
    /// Counts writes: a session's load reserves when it claims the key, a reload before it reads.
    epoch: u64,
    map: BTreeMap<String, (Slot, u64)>,
    /// The full server list each `Loaded` slot's group was started with: a session-open re-read
    /// compares against it (with the slot's plugin set) to install only a changed read.
    servers: BTreeMap<String, Vec<McpServer>>,
    /// The keys a prewarm read for a session open that is about to follow: that open reuses the
    /// read once instead of re-reading (the prewarm exists to take the read off the open's path).
    prewarmed: std::collections::BTreeSet<String>,
}

/// One assembled layer, ready to install: the slot plus what its group needs. The group itself
/// starts (or stops) at the install ([`WorkspaceLayer::put_at`]), under the epoch acceptance check.
enum Install {
    Loaded {
        workspace: WorkspaceRef,
        servers: Vec<McpServer>,
        plugins: Arc<crate::plugins::Plugins>,
    },
    Invalid,
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
            slots: RwLock::new(Slots {
                epoch: 0,
                map: BTreeMap::new(),
                servers: BTreeMap::new(),
                prewarmed: std::collections::BTreeSet::new(),
            }),
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
        self.slots
            .read_unpoisoned()
            .map
            .get(key)
            .map(|(slot, _)| slot.clone())
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

    /// Fork: the plugin set a session's workspace carries — its loaded layer's set, when one is
    /// loaded for the recorded workspace (specs/fork-rust-node-helper.md F3, per-workspace
    /// admission). `None` for a session without a recorded workspace or whose workspace has no
    /// loaded layer: the same resolution and fallback as the session's MCP group
    /// ([`WorkspaceMcp::for_session`]).
    pub fn plugins_of_session(
        &self,
        sessions: &rust_cli_kernel_api::workspace_key::SessionWorkspaces,
        session: &rust_cli_kernel_api::ids::SessionId,
    ) -> Option<Arc<crate::plugins::Plugins>> {
        sessions
            .get(session)
            .and_then(|workspace| self.plugins_of(&workspace))
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

    /// Loads the layer of `workspace` at each session open (create, resume, the print `--continue`
    /// prewarm). Fail-closed: a project layer that cannot be read or parsed stops the workspace's
    /// group and marks the slot `Invalid`, so its sessions keep the process set until the next
    /// successful load.
    ///
    /// Fork (PLM-LC-010, specs/fork-rust-workspace-plugins-mcp.md "As built: session-open
    /// re-read"): a `Loaded` slot is re-read too, like Node's per-session config read — another
    /// process (the desktop Host's plugin-workspace agent) installs plugins without a write this
    /// process committed, so the explicit reload never fires. An equal read installs nothing (the
    /// group keeps its live connections); a changed one installs through the same epoch check.
    pub(crate) async fn load(&self, workspace: &WorkspaceRef) {
        self.load_for(workspace, false).await;
    }

    /// Loads ahead of the session open that follows (the print `--continue` prewarm): the read is
    /// the open's — the open joins it while in flight, or reuses its slot once afterwards.
    pub(crate) async fn prewarm(&self, workspace: &WorkspaceRef) {
        self.load_for(workspace, true).await;
    }

    /// Takes the prewarm mark of `key`: `true` when the slot was read for this open.
    fn take_prewarmed(&self, key: &str) -> bool {
        self.slots.write_unpoisoned().prewarmed.remove(key)
    }

    async fn load_for(&self, workspace: &WorkspaceRef, prewarm: bool) {
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
        let Some(loader) = self.loader.get().cloned() else {
            return;
        };
        if !prewarm && self.take_prewarmed(&key) && matches!(self.slot(&key), Some(Slot::Loaded(_)))
        {
            return;
        }
        // One load at a time: the caller that registers the key reads; every other caller waits
        // for that read and reuses what it put — a concurrent open never proceeds on a slot an
        // in-flight re-read is about to replace, and never replaces the group a second time. The
        // notified future is created before the in-flight check, so a finish in between cannot be
        // missed; a claim released without a slot (a cancelled open) makes the waiter retry.
        loop {
            let waiter = match self.begin(&key) {
                Ok(()) => break,
                Err(waiter) => waiter,
            };
            let notified = waiter.notified();
            let in_flight = self
                .loading
                .read_unpoisoned()
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &waiter));
            if in_flight {
                notified.await;
            }
            if self.slot(&key).is_some() {
                // The joined read was this open's: a prewarm mark it left is consumed with it.
                if !prewarm {
                    self.take_prewarmed(&key);
                }
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
        // The epoch is reserved when the key is claimed, before the read: a reload triggered while
        // this load runs reserved after it, so whichever finishes first the later read wins.
        let epoch = self.reserve();
        let install = self.assemble(&loader, workspace).await;
        if !self.installed_matches(&key, &install) {
            self.put_or_superseded(&key, workspace, epoch, install);
        }
        if prewarm {
            self.slots.write_unpoisoned().prewarmed.insert(key.clone());
        }
        self.finish(&key);
        claim.armed = false;
    }

    /// Whether `install` equals what `key`'s slot already holds — the same plugin set and the same
    /// group server list for a `Loaded` slot, or an `Invalid` slot again. A matching re-read is not
    /// installed: re-installing would restart the group and cancel its live connections.
    fn installed_matches(&self, key: &str, install: &Install) -> bool {
        let slots = self.slots.read_unpoisoned();
        match (slots.map.get(key), install) {
            (
                Some((Slot::Loaded(current), _)),
                Install::Loaded {
                    servers, plugins, ..
                },
            ) => {
                **current == **plugins
                    && slots
                        .servers
                        .get(key)
                        .is_some_and(|current| current == servers)
            }
            (Some((Slot::Invalid, _)), Install::Invalid) => true,
            _ => false,
        }
    }

    /// Fork (specs/fork-rust-workspace-plugins-mcp.md, "As built: layer reload"): re-reads
    /// `workspace`'s project layer past the loaded-slot reuse, for a config or trust write the
    /// caller committed (Node's per-session re-read has no file-watcher equivalent here). The
    /// epoch is reserved before the read, so a session load that started earlier never installs
    /// its older read over this slot — nor replaces the group, which swaps under the same
    /// acceptance check. The reload stays lazy: a workspace with neither a slot nor a load in
    /// flight does not load here (nothing in this process uses it yet; its next session open reads
    /// the post-write config directly). Fail-closed like the first load: a read that now fails
    /// installs `Invalid` and stops the group.
    pub(crate) async fn reload(&self, workspace: &WorkspaceRef) {
        let key = project_key(workspace.root.as_str());
        if self
            .process
            .as_ref()
            .is_some_and(|process| project_key(process.root.as_str()) == key)
        {
            // The process group serves exactly this workspace; it has no slot to replace.
            return;
        }
        if self.slot(&key).is_none() && !self.loading.read_unpoisoned().contains_key(&key) {
            return;
        }
        let Some(loader) = self.loader.get().cloned() else {
            return;
        };
        let epoch = self.reserve();
        let install = self.assemble(&loader, workspace).await;
        self.put_or_superseded(&key, workspace, epoch, install);
    }

    /// The next epoch, taken before the write reads (the hooks engine's `reserve_project`).
    fn reserve(&self) -> u64 {
        let mut slots = self.slots.write_unpoisoned();
        slots.epoch += 1;
        slots.epoch
    }

    /// Reads `workspace`'s project layer and builds the install: the re-selected plugin set and
    /// the group's full server list. The group itself starts (or stops) at the install, so a
    /// superseded read never touches it.
    async fn assemble(
        &self,
        loader: &Arc<dyn WorkspaceConfigLoader>,
        workspace: &WorkspaceRef,
    ) -> Install {
        match loader.load(workspace).await {
            Some(config) => {
                let loaded = crate::plugins::load_all(
                    self.files.as_ref(),
                    workspace,
                    &self.plugin_dirs,
                    &config.plugins,
                )
                .await
                .plugins;
                // The user servers the config holds at this load; the process-start snapshot only when the loader
                // cannot read them (the trait default).
                let mut servers = match loader.user_servers(workspace).await {
                    Some(user) => user,
                    None => self.servers.clone(),
                };
                servers.extend(loaded.mcp_servers());
                servers.extend(config.servers);
                Install::Loaded {
                    workspace: workspace.clone(),
                    servers,
                    plugins: Arc::new(loaded),
                }
            }
            None => {
                tracing::warn!(
                    workspace = workspace.root.as_str(),
                    "the workspace plugin/MCP layer could not be loaded; the process set stays"
                );
                Install::Invalid
            }
        }
    }

    /// Installs at `epoch`, or drops the read when a write that reserved after it already
    /// installed (the hooks engine's `put_project_at` shape).
    fn put_or_superseded(&self, key: &str, workspace: &WorkspaceRef, epoch: u64, install: Install) {
        if !self.put_at(key, epoch, install) {
            tracing::info!(
                workspace = workspace.root.as_str(),
                "a later write already put the workspace plugin/MCP layer; the older read is dropped"
            );
        }
    }

    /// Sets the slot of `key` at `epoch` unless a write that reserved after `epoch` already set
    /// it. The group swap and the plugin-hooks sink run INSIDE the slots write guard and under the
    /// same acceptance check: no `slot()` read (the waiters' fast path checks the slot before
    /// awaiting) can observe the new slot before its group and hooks are in place, and a
    /// superseded write replaces neither the slot nor the group.
    fn put_at(&self, key: &str, epoch: u64, install: Install) -> bool {
        let mut slots = self.slots.write_unpoisoned();
        if slots.map.get(key).is_some_and(|(_, at)| *at > epoch) {
            return false;
        }
        match install {
            Install::Loaded {
                workspace,
                servers,
                plugins,
            } => {
                // A replaced group's connections stop inside `start` (`McpManager::shutdown`).
                slots.servers.insert(key.to_owned(), servers.clone());
                self.mcp.start(key, workspace, servers);
                if let Some(sink) = self.hooks.get() {
                    sink(key, &plugins);
                }
                slots
                    .map
                    .insert(key.to_owned(), (Slot::Loaded(plugins), epoch));
            }
            Install::Invalid => {
                slots.servers.remove(key);
                self.mcp.stop(key);
                slots.map.insert(key.to_owned(), (Slot::Invalid, epoch));
            }
        }
        true
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

    async fn prewarm(&self, workspace: &WorkspaceRef) {
        WorkspaceLayer::prewarm(self, workspace).await;
    }

    async fn reload(&self, workspace: &WorkspaceRef) {
        WorkspaceLayer::reload(self, workspace).await;
    }
}

#[cfg(test)]
#[path = "workspace_layer_tests.rs"]
mod tests;
