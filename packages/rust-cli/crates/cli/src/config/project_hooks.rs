//! Fork: a workspace's project hook entry (specs/fork-rust-agent-parity.md, "Per-workspace hook snapshots and strict
//! project hook discovery"): the trusted and enabled declarations of the project files Node can load, read against
//! the shared trust store. The hooks engine holds one entry per workspace key; this module is its only assembler.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_hooks::{ProjectEntry, ProjectHookLoader};
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::machine::Files;
use rust_cli_paths::StoragePaths;

#[cfg_attr(not(test), expect(dead_code, reason = "red tests: wired in the fix"))]
/// The entry of `workspace`; trust records are read under `identity` when given (a remote workspace's identity).
pub(crate) async fn entry(
    _files: &dyn Files,
    _paths: &StoragePaths,
    _workspace: &WorkspaceRef,
    _identity: Option<String>,
) -> ProjectEntry {
    ProjectEntry::Admitted(Vec::new())
}

#[expect(dead_code, reason = "red tests: wired in the fix")]
/// The engine's loader: assembles a workspace's entry at its first event and at each session start.
pub(crate) struct Loader {
    pub(crate) files: Arc<dyn Files>,
    pub(crate) paths: StoragePaths,
}

#[async_trait]
impl ProjectHookLoader for Loader {
    async fn load(&self, workspace: &WorkspaceRef) -> ProjectEntry {
        entry(self.files.as_ref(), &self.paths, workspace, None).await
    }
}

#[cfg(test)]
#[path = "project_hooks_tests.rs"]
mod tests;
