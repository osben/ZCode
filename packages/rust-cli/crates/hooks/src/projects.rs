//! Fork: the project hooks of each workspace (specs/fork-rust-agent-parity.md, "Per-workspace hook snapshots and
//! strict project hook discovery"). The process snapshot holds the user, `--settings` and plugin hooks; each workspace
//! key holds the admitted project sources of that workspace, or `Invalid` after a failed toggle rebuild. An event
//! combines the process sources with the entry of its own workspace.

use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::sync::RwLockUnpoisoned;
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::env_files::PathStyle;
use rust_cli_kernel_api::hooks::{HookEvent, HookEventName};

use crate::config::{HookSource, HooksSettings};
use crate::{HookEngine, Loaded, load};

/// The project hooks of one workspace.
#[derive(Debug, Clone, PartialEq)]
pub enum ProjectEntry {
    /// The trusted and enabled project declarations of the loaded project files.
    Admitted(Vec<(HookSource, HooksSettings)>),
    /// No project hook runs (Node `admission.invalidate`).
    Invalid,
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
    let style = PathStyle::infer(root);
    let trimmed = root.trim_end_matches(|c| style.is_separator(c));
    if trimmed.is_empty() || (style == PathStyle::Windows && trimmed.ends_with(':')) {
        // `/` and `C:\` keep their separator: without it they name another path.
        return root.to_owned();
    }
    trimmed.to_owned()
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
    /// Counts slot writes, taken when a write starts (a put when it is made, a load before it reads): a slot is
    /// replaced only by a write that started later.
    epoch: u64,
    loader: Option<Arc<dyn ProjectHookLoader>>,
}

impl State {
    pub(crate) fn new(process: Loaded) -> Self {
        Self {
            process: Arc::new(process),
            projects: BTreeMap::new(),
            epoch: 0,
            loader: None,
        }
    }

    /// Swaps the process snapshot and recombines every entry with it.
    pub(crate) fn set_process(&mut self, process: Loaded) {
        self.process = Arc::new(process);
        for slot in self.projects.values_mut() {
            slot.loaded = combine(&self.process, &slot.entry);
        }
    }

    fn put(&mut self, key: String, entry: ProjectEntry) {
        self.epoch += 1;
        let epoch = self.epoch;
        self.put_at(key, entry, epoch);
    }

    /// Sets the slot of `key` unless a write that started after `epoch` already set it.
    fn put_at(&mut self, key: String, entry: ProjectEntry, epoch: u64) {
        if self
            .projects
            .get(&key)
            .is_some_and(|slot| slot.epoch > epoch)
        {
            return;
        }
        let loaded = combine(&self.process, &entry);
        self.projects.insert(
            key,
            Slot {
                entry,
                loaded,
                epoch,
            },
        );
    }

    /// The snapshot of a workspace: its entry's, or the process sources alone.
    pub(crate) fn snapshot(&self, workspace: &WorkspaceRef) -> Arc<Loaded> {
        self.projects
            .get(&project_key(workspace.root.as_str()))
            .map_or_else(|| self.process.clone(), |slot| slot.loaded.clone())
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

fn combine(process: &Arc<Loaded>, entry: &ProjectEntry) -> Arc<Loaded> {
    let ProjectEntry::Admitted(admitted) = entry else {
        return process.clone();
    };
    if admitted.is_empty() {
        return process.clone();
    }
    let mut config = process.config.clone();
    config.sources = with_projects(&process.config.sources, admitted);
    Arc::new(load(config, process.plugins.clone()))
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

    /// Swaps the entry of `key`; an event already running keeps the snapshot it started with.
    pub fn put_project(&self, key: &str, entry: ProjectEntry) {
        self.state.write_unpoisoned().put(project_key(key), entry);
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
            loader.map(|loader| {
                state.epoch += 1;
                (loader, state.epoch)
            })
        };
        if let Some((loader, started)) = pending {
            let entry = loader.load(&event.workspace).await;
            self.state.write_unpoisoned().put_at(key, entry, started);
        }
        self.state.read_unpoisoned().snapshot(&event.workspace)
    }
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
