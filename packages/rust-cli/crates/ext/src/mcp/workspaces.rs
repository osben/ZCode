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
use rust_cli_kernel_api::ids::SessionId;
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
    /// The group each open session resolved first, by session id (specs/fork-rust-workspace-plugins-mcp.md,
    /// "As built: a session keeps its group"): a replaced group keeps serving the sessions that hold it, like
    /// Node's pool per session app.
    pins: RwLock<HashMap<SessionId, Arc<McpManager>>>,
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
            pins: RwLock::default(),
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

    /// Fork (`process/childProcesses`): whether `server` is declared by an official-marketplace plugin. The process
    /// group and every workspace group are asked, since the connection table is process-wide and keyed by name;
    /// a name that two groups attribute to different marketplaces is not official (fail to the plain `plugin`).
    pub(crate) fn official_plugin_server(&self, server: &str) -> bool {
        let suffix = format!("@{}", rust_cli_base::names::OFFICIAL_MARKETPLACE);
        // Lock order as `for_session`: pins, then groups. A retired group that an open session pinned keeps
        // running its processes, so it still decides their provenance.
        let pins = self.pins.read_unpoisoned();
        let groups = self.groups.read_unpoisoned();
        let mut ids = std::iter::once(&self.process)
            .chain(groups.values())
            .chain(pins.values())
            .filter_map(|group| group.0.plugin_id_of(server))
            .peekable();
        ids.peek().is_some() && ids.all(|id| id.ends_with(&suffix))
    }

    /// The group of `key`, if a loaded layer started one.
    pub(crate) fn group(&self, key: &str) -> Option<Arc<McpManager>> {
        if key == PROCESS {
            return Some(self.process.clone());
        }
        self.groups.read_unpoisoned().get(key).cloned()
    }

    /// Fork: the group a session reads: the group it pinned, else its workspace's group when a loaded layer started
    /// one (pinned from then on), else the process group (no workspace, an `Invalid` slot, or the TUI/`-p`), which
    /// is not pinned.
    pub(crate) fn for_session(
        &self,
        sessions: &rust_cli_kernel_api::workspace_key::SessionWorkspaces,
        session: &SessionId,
    ) -> Arc<McpManager> {
        if let Some(pinned) = self.pins.read_unpoisoned().get(session) {
            return pinned.clone();
        }
        let Some(key) = sessions.get(session).map(|workspace| {
            rust_cli_kernel_api::workspace_key::project_key(workspace.root.as_str())
        }) else {
            return self.process.clone();
        };
        // The group is read under the pins lock, so a replace cannot retire it between the read and the pin.
        let mut pins = self.pins.write_unpoisoned();
        if let Some(pinned) = pins.get(session) {
            return pinned.clone();
        }
        match self.group(&key) {
            Some(group) if !Arc::ptr_eq(&group, &self.process) => {
                pins.insert(session.clone(), group.clone());
                group
            }
            _ => self.process.clone(),
        }
    }

    /// A session closed: its pin goes, and a retired group it was the last to hold shuts down. The current group of
    /// a key never shuts down here.
    pub(crate) fn release(&self, session: &SessionId) {
        let mut pins = self.pins.write_unpoisoned();
        let Some(group) = pins.remove(session) else {
            return;
        };
        let current = self
            .groups
            .read_unpoisoned()
            .values()
            .any(|current| Arc::ptr_eq(current, &group));
        let held = pins.values().any(|other| Arc::ptr_eq(other, &group));
        drop(pins);
        if !current && !held {
            group.shutdown();
        }
    }

    /// A group that is no longer current for its key: it shuts down unless an open session holds it (that
    /// session's close shuts it down, [`Self::release`]).
    fn retire(&self, group: Arc<McpManager>) {
        let held = self
            .pins
            .read_unpoisoned()
            .values()
            .any(|pinned| Arc::ptr_eq(pinned, &group));
        if !held {
            group.shutdown();
        }
    }

    /// Starts (or replaces) the group of `key` with the workspace's server list. Sessions that open
    /// later read the new group; a replaced group keeps serving the open sessions that pinned it and
    /// stops after the last of them closes ([`Self::retire`]), like Node's pool per session app. The print startup wait of a resumed workspace runs in the print entry's prewarm
    /// (`frontends/print.rs`), where it stays cancellable against the stop token.
    #[cfg(test)]
    pub(crate) fn start(&self, key: &str, workspace: WorkspaceRef, servers: Vec<McpServer>) {
        self.start_with_plugins(key, workspace, servers, Vec::new());
    }

    /// Fork: [`Self::start`] with the plugin id of each plugin-declared server (`McpManager::note_plugin_ids`).
    pub(crate) fn start_with_plugins(
        &self,
        key: &str,
        workspace: WorkspaceRef,
        servers: Vec<McpServer>,
        plugin_ids: Vec<(String, String)>,
    ) {
        if key == PROCESS {
            self.process.note_plugin_ids(plugin_ids);
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
        manager.note_plugin_ids(plugin_ids);
        manager.start(workspace, servers);
        // Lock order: pins, then groups (as `for_session`), so a session cannot pin the group being retired.
        let pins = self.pins.write_unpoisoned();
        let previous = self
            .groups
            .write_unpoisoned()
            .insert(key.to_owned(), Arc::new(manager));
        drop(pins);
        if let Some(previous) = previous {
            self.retire(previous);
        }
    }

    /// Stops the group of `key` (a slot that turned `Invalid`): its connections end and the
    /// sessions of that workspace fall back to the process group.
    pub(crate) fn stop(&self, key: &str) {
        if key == PROCESS {
            return;
        }
        let pins = self.pins.write_unpoisoned();
        let removed = self.groups.write_unpoisoned().remove(key);
        drop(pins);
        if let Some(manager) = removed {
            self.retire(manager);
        }
    }
}

#[cfg(test)]
#[path = "workspaces_tests.rs"]
mod tests;
