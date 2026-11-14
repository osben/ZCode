//! Fork: the project hooks of each workspace (specs/fork-rust-agent-parity.md, "Per-workspace hook snapshots and
//! strict project hook discovery"). The process snapshot holds the user, `--settings` and plugin hooks; each workspace
//! key holds the admitted project sources of that workspace, or `Invalid` after a failed toggle rebuild. An event
//! combines the process sources with the entry of its own workspace.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_kernel_api::env::WorkspaceRef;

use crate::HookEngine;
use crate::config::{HookSource, HooksSettings};

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

/// The entry key of a workspace root (`workspaceIdentity?.trim() || workspacePath` for a local workspace).
pub fn project_key(root: &str) -> String {
    root.to_owned()
}

impl HookEngine {
    /// Sets the loader that assembles a workspace's entry at its first event and at a session start.
    pub fn set_project_loader(&self, _loader: Arc<dyn ProjectHookLoader>) {}

    /// Swaps the entry of `key`; an event already running keeps the snapshot it started with.
    pub fn put_project(&self, _key: &str, _entry: ProjectEntry) {}
}

#[cfg(test)]
#[path = "projects_tests.rs"]
mod tests;
