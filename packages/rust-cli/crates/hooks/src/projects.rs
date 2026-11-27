//! Fork: the project hooks of each workspace (specs/fork-rust-agent-parity.md, "Per-workspace hook snapshots and
//! strict project hook discovery"). The process snapshot holds the user, `--settings` and plugin hooks; each workspace
//! key holds the admitted project sources of that workspace — and, when its layer loaded its own plugin set
//! (specs/fork-rust-workspace-plugins-mcp.md, "As built"), that set's plugin hooks instead of the process ones — or
//! `Invalid` after a failed toggle rebuild. An event combines the process sources with the entry of its own workspace.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::sync::RwLockUnpoisoned;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::hooks::{HookEvent, HookEventName};

use crate::config::{HookSource, HooksSettings};
use crate::plugin::PluginHooks;
use crate::{HookEngine, Loaded, load};

/// The project hooks of one workspace.
#[derive(Debug, Clone, PartialEq)]
pub enum ProjectEntry {
    /// The trusted and enabled project declarations of the loaded project files.
    Admitted(Vec<(HookSource, HooksSettings)>),
    /// No project hook runs (Node `admission.invalidate`).
    Invalid,
}

/// An engine epoch, reserved by a write before it reads ([`ProjectHookSlots::reserve_project`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ProjectEpoch(pub u64);

/// The writes of workspace entries, in the order of the epochs they reserved: one owner for every writer (the
/// session's loads and the App's rebuilds alike).
pub trait ProjectHookSlots: Send + Sync {
    /// The next epoch; a write takes it before it reads the files and trust records it installs.
    fn reserve_project(&self) -> ProjectEpoch;
    /// Sets the entry of `key` unless a write that reserved after `epoch` already set it; false when refused.
    fn put_project_at(&self, key: &str, epoch: ProjectEpoch, entry: ProjectEntry) -> bool;
}

/// Assembles a workspace's entry from its config files and trust records (the cli owns the IO).
#[async_trait]
pub trait ProjectHookLoader: Send + Sync {
    async fn load(&self, workspace: &WorkspaceRef) -> ProjectEntry;
}

/// The entry key of a workspace root (`workspaceIdentity?.trim() || workspacePath` for a local workspace). A trailing
/// separator of the path's own style does not make another workspace (on POSIX a backslash is a name character);
/// whitespace does, because only an explicit identity is trimmed.
pub fn project_key(root: &str) -> String {
    // Moved to kernel-api (workspace_key) so plugins and MCP derive the same key; kept as the hooks entry point.
    rust_cli_kernel_api::workspace_key::project_key(root)
}

/// One workspace's entry and the snapshot its events read.
struct Slot {
    entry: ProjectEntry,
    loaded: Arc<Loaded>,
    /// The engine epoch of the write that set this slot.
    epoch: u64,
}

/// Everything the engine reads, behind one lock.
pub(crate) struct State {
    pub(crate) process: Arc<Loaded>,
    projects: BTreeMap<String, Slot>,
    /// Fork (specs/fork-rust-workspace-plugins-mcp.md, "As built"): the plugin hooks of the workspaces whose layer
    /// loaded their own plugin set; a workspace keyed here runs them instead of the process plugin hooks. An empty
    /// vec is a set without hooks (a workspace may disable the plugins that carry them), so it differs from no entry.
    workspace_plugins: BTreeMap<String, Vec<PluginHooks>>,
    /// Counts slot writes, taken when a write starts (a put when it is made, a load before it reads): a slot is
    /// replaced only by a write that started later.
    epoch: u64,
    loader: Option<Arc<dyn ProjectHookLoader>>,
    /// Fork (specs/fork-rust-hook-script-entry.md): reads a project hook's entry script before it runs; without one
    /// such a hook is refused.
    pub(crate) scripts: Option<Arc<dyn crate::script_entry::ScriptVerifier>>,
}

impl State {
    pub(crate) fn new(process: Loaded) -> Self {
        Self {
            process: Arc::new(process),
            projects: BTreeMap::new(),
            workspace_plugins: BTreeMap::new(),
            epoch: 0,
            loader: None,
            scripts: None,
        }
    }

    /// Swaps the process snapshot and recombines every entry with it.
    pub(crate) fn set_process(&mut self, process: Loaded) {
        self.process = Arc::new(process);
        for (key, slot) in self.projects.iter_mut() {
            slot.loaded = combine(
                &self.process,
                self.workspace_plugins.get(key).map(Vec::as_slice),
                &slot.entry,
            );
        }
    }

    /// Swaps the process plugin hooks; an entry with its own plugin sources does not read them, so it keeps its
    /// snapshot.
    pub(crate) fn set_process_plugins(&mut self, process: Loaded) {
        self.process = Arc::new(process);
        for (key, slot) in self.projects.iter_mut() {
            if !self.workspace_plugins.contains_key(key) {
                slot.loaded = combine(&self.process, None, &slot.entry);
            }
        }
    }

    /// Sets the plugin sources of `key`, replacing the set that was there; an event already running keeps the
    /// snapshot it started with.
    pub(crate) fn put_workspace_plugins(&mut self, key: String, plugins: Vec<PluginHooks>) {
        self.workspace_plugins.insert(key.clone(), plugins);
        self.recombine(&key);
    }

    /// Recombines `key`'s slot with the state as it is now; a slot without an entry yet picks the sources up at
    /// its own write.
    fn recombine(&mut self, key: &str) {
        let Some(slot) = self.projects.get_mut(key) else {
            return;
        };
        slot.loaded = combine(
            &self.process,
            self.workspace_plugins.get(key).map(Vec::as_slice),
            &slot.entry,
        );
    }

    fn reserve(&mut self) -> u64 {
        self.epoch += 1;
        self.epoch
    }

    fn put(&mut self, key: String, entry: ProjectEntry) {
        let epoch = self.reserve();
        self.put_at(key, entry, epoch);
    }

    /// Sets the slot of `key` unless a write that started after `epoch` already set it.
    fn put_at(&mut self, key: String, entry: ProjectEntry, epoch: u64) -> bool {
        if self
            .projects
            .get(&key)
            .is_some_and(|slot| slot.epoch > epoch)
        {
            return false;
        }
        let loaded = combine(
            &self.process,
            self.workspace_plugins.get(&key).map(Vec::as_slice),
            &entry,
        );
        self.projects.insert(
            key,
            Slot {
                entry,
                loaded,
                epoch,
            },
        );
        true
    }

    /// The snapshot of a workspace: its entry's, or the process sources with the workspace's own plugin hooks when
    /// only those have registered (the project sources load at the entry's own write).
    pub(crate) fn snapshot(&self, workspace: &WorkspaceRef) -> Arc<Loaded> {
        let key = project_key(workspace.root.as_str());
        self.projects.get(&key).map_or_else(
            || {
                combine(
                    &self.process,
                    self.workspace_plugins.get(&key).map(Vec::as_slice),
                    &ProjectEntry::Admitted(Vec::new()),
                )
            },
            |slot| slot.loaded.clone(),
        )
    }

    /// `/hooks`: the process sources and every admitted project source, by workspace key.
    pub(crate) fn listed_sources(&self) -> Vec<(HookSource, HooksSettings)> {
        let admitted = self.projects.values().flat_map(|slot| match &slot.entry {
            ProjectEntry::Admitted(admitted) => admitted.as_slice(),
            ProjectEntry::Invalid => &[],
        });
        with_projects(&self.process.config.sources, admitted)
    }

    /// Whether `has_hooks` must count the event as hooked: with a loader, a workspace without an entry has not been
    /// assembled yet, and a session start reassembles it, so only the run can tell.
    pub(crate) fn unknown(&self, event: HookEventName, workspace: &WorkspaceRef) -> bool {
        self.loader.is_some()
            && (event == HookEventName::SessionStart
                || !self
                    .projects
                    .contains_key(&project_key(workspace.root.as_str())))
    }
}

/// The process sources with project sources after the user config's own source, the order startup assembly gave
/// before per-workspace entries (the user file, the project files, the `--settings` hooks, also `User`). It is only
/// the `/hooks` listing order: the run and fold order comes from `HooksConfig::effective_with`, which stable-sorts
/// the sources by kind.
fn with_projects<'a>(
    process: &[(HookSource, HooksSettings)],
    projects: impl IntoIterator<Item = &'a (HookSource, HooksSettings)>,
) -> Vec<(HookSource, HooksSettings)> {
    let at = usize::from(
        process
            .first()
            .is_some_and(|(source, _)| *source == HookSource::User),
    );
    let mut sources = process[..at].to_vec();
    sources.extend(projects.into_iter().cloned());
    sources.extend(process[at..].iter().cloned());
    sources
}

/// The snapshot of one workspace: the process sources with the entry's admitted project sources, run by the plugin
/// hooks of the workspace's own set when it has one (`workspace`), else the process plugin hooks.
fn combine(
    process: &Arc<Loaded>,
    workspace: Option<&[PluginHooks]>,
    entry: &ProjectEntry,
) -> Arc<Loaded> {
    let admitted: &[(HookSource, HooksSettings)] = match entry {
        ProjectEntry::Admitted(admitted) => admitted,
        // Plugin hooks are not project hooks: an invalid entry drops the project sources only.
        ProjectEntry::Invalid => &[],
    };
    if admitted.is_empty() && workspace.is_none() {
        return process.clone();
    }
    let mut config = process.config.clone();
    if !admitted.is_empty() {
        config.sources = with_projects(&process.config.sources, admitted);
    }
    let plugins = match workspace {
        Some(plugins) => plugins.to_vec(),
        None => process.plugins.clone(),
    };
    Arc::new(load(config, plugins))
}

/// A session start other than the one after a compaction reassembles the entry (Node builds the snapshot when a
/// session opens or resumes, not when it compacts).
fn reloads(event: &HookEvent) -> bool {
    event.name == HookEventName::SessionStart
        && event
            .payload
            .get("source")
            .and_then(|source| source.as_str())
            != Some("compact")
}

impl HookEngine {
    /// Sets the loader that assembles a workspace's entry at its first event and at a session start.
    pub fn set_project_loader(&self, loader: Arc<dyn ProjectHookLoader>) {
        self.state.write_unpoisoned().loader = Some(loader);
    }

    /// Fork (specs/fork-rust-hook-script-entry.md): sets the reader of the entry scripts admitted project hooks
    /// re-check before each run.
    pub fn set_script_verifier(&self, verifier: Arc<dyn crate::script_entry::ScriptVerifier>) {
        self.state.write_unpoisoned().scripts = Some(verifier);
    }

    /// Swaps the entry of `key`; an event already running keeps the snapshot it started with.
    pub fn put_project(&self, key: &str, entry: ProjectEntry) {
        self.state.write_unpoisoned().put(project_key(key), entry);
    }

    /// Fork (specs/fork-rust-workspace-plugins-mcp.md, "As built"): registers the hooks of `key`'s own plugin set
    /// (its loaded workspace layer), replacing the set that was there; the workspace's events run them instead of
    /// the process plugin hooks. One synchronous write under the engine's lock, like the process registration.
    pub fn register_workspace_plugins(&self, key: &str, plugins: Vec<PluginHooks>) {
        self.state
            .write_unpoisoned()
            .put_workspace_plugins(project_key(key), plugins);
    }

    /// The snapshot `event` runs with, assembling its workspace's entry first when it has none yet or the event
    /// opens a session. The load takes its epoch before it reads: a put made while it ran, or a load that started
    /// (and read) after it, wins over it, whichever finishes first.
    pub(crate) async fn snapshot_for(&self, event: &HookEvent) -> Arc<Loaded> {
        let key = project_key(event.workspace.root.as_str());
        let pending = {
            let mut state = self.state.write_unpoisoned();
            let loader = state
                .loader
                .clone()
                .filter(|_| reloads(event) || !state.projects.contains_key(&key));
            loader.map(|loader| (loader, state.reserve()))
        };
        if let Some((loader, started)) = pending {
            let entry = loader.load(&event.workspace).await;
            self.state.write_unpoisoned().put_at(key, entry, started);
        }
        self.state.read_unpoisoned().snapshot(&event.workspace)
    }
}

impl ProjectHookSlots for HookEngine {
    fn reserve_project(&self) -> ProjectEpoch {
        ProjectEpoch(self.state.write_unpoisoned().reserve())
    }

    fn put_project_at(&self, key: &str, epoch: ProjectEpoch, entry: ProjectEntry) -> bool {
        self.state
            .write_unpoisoned()
            .put_at(project_key(key), entry, epoch.0)
    }
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
