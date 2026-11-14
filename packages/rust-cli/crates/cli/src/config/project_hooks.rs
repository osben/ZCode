//! Fork: a workspace's project hook entry (specs/fork-rust-agent-parity.md, "Per-workspace hook snapshots and strict
//! project hook discovery"): the trusted and enabled declarations of the project files Node can load, read against
//! the shared trust store. The hooks engine holds one entry per workspace key; this module is its only assembler.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_hooks::{ProjectEntry, ProjectHookLoader};
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::machine::Files;
use rust_cli_paths::StoragePaths;
use rust_cli_platform::local::read_cli_config;

use super::files;
use super::trust::WorkspaceHooks;

/// The entry of `workspace`; trust records are read under `identity` when given (a remote workspace's identity).
pub(crate) async fn entry(
    files: &dyn Files,
    paths: &StoragePaths,
    workspace: &WorkspaceRef,
    identity: Option<String>,
) -> ProjectEntry {
    let user = read_cli_config(paths).await;
    let projects = files::discover(files, workspace).await;
    let mut warnings = Vec::new();
    let mut hooks = WorkspaceHooks::inspect(
        workspace.root.as_str(),
        user.object(),
        &projects,
        paths,
        &mut warnings,
    )
    .await;
    for warning in &warnings {
        tracing::warn!(warning, "project hooks");
    }
    if let Some(identity) = identity {
        hooks.identity = identity;
    }
    ProjectEntry::Admitted(hooks.admitted())
}

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
