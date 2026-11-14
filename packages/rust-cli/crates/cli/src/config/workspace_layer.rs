//! Fork: the cli side of the per-workspace plugin/MCP layer
//! (specs/fork-rust-workspace-plugins-mcp.md). Discovers a workspace's project config with the same
//! readers the process config uses (`read_files` + `layers`), reuses the LSP path's plugin view
//! (`plugin_view`: the same candidates and the project `enabledPlugins`/`suppressedBuiltins`
//! overlay under that workspace) and extracts the project `mcp.servers` with Node's name shadowing
//! and per-file cwd resolution (`merge::mcp_layers` + `resolve_project_cwds`). A project file that
//! cannot be read or parsed is skipped like the process config skips it (Node `loadFileConfig`
//! marks it not loaded); the loader itself cannot fail.

use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_ext::PluginSources;
use rust_cli_ext::mcp::McpServer;
use rust_cli_ext::{WorkspaceConfig, WorkspaceConfigLoader};
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::machine::Files as FilesPort;
use rust_cli_paths::StoragePaths;
use serde_json::Map;

use super::mcp_trust;
use super::merge;
use super::{ConfigInputs, McpScope};

/// The process inputs the workspace layer re-uses: the file port, the storage paths, the
/// `--settings` layer and the process plugin flags (`view_host`, `node_helper`) a workspace's
/// re-selection inherits.
pub(crate) struct Loader {
    pub(crate) files: Arc<dyn FilesPort>,
    pub(crate) paths: StoragePaths,
    pub(crate) process_env: rust_cli_base::secret::EnvSnapshot,
    /// The `--settings` flag layer is the process's own CLI input; other workspaces' layers do not
    /// re-apply it (the process's own workspace never loads a separate layer).
    pub(crate) flag: Option<Map<String, serde_json::Value>>,
    pub(crate) project_is_local: bool,
    /// The process plugin sources: the workspace overlay keeps their `view_host`/`node_helper`.
    pub(crate) process: PluginSources,
}

#[async_trait]
impl WorkspaceConfigLoader for Loader {
    async fn load(&self, workspace: &WorkspaceRef) -> Option<WorkspaceConfig> {
        let inputs = ConfigInputs {
            files: self.files.as_ref(),
            workspace,
            paths: &self.paths,
            process_env: &self.process_env,
            flag: self.flag.as_ref(),
            project_is_local: self.project_is_local,
        };
        let mut sources = super::plugin_view(&inputs).await.sources;
        sources.view_host = self.process.view_host;
        sources.node_helper = self.process.node_helper;

        let mut warnings = Vec::new();
        let files = super::read_files(&inputs).await;
        let empty = Map::new();
        let layers = super::layers(&files, inputs.flag, &empty, &mut warnings);
        let merged = merge::mcp_layers(&layers, &mut warnings);
        // Only the project-origin servers: the layer's group runs the user servers itself (with the
        // workspace as their cwd base, Node `resolve(workingDirectory, cwd)`); a user server that
        // shadows a same-named project server stays out, as in Node's merge.
        let mut servers: Vec<McpServer> = merged
            .servers
            .into_iter()
            .filter(|server| {
                merged
                    .origins
                    .get(&server.name)
                    .is_some_and(|origin| !origin.user)
            })
            .collect();
        // Fork: project MCP servers connect only with a workspace trust grant for their current
        // declaration, exactly like the process assembly (`config::assemble`).
        let user_object = super::object(&files.user_path, &files.user, &mut warnings);
        let trust = mcp_trust::Inspection::read(
            inputs.files,
            inputs.workspace,
            mcp_trust::Target::new(inputs.workspace.root.as_str(), None),
            (user_object, &files.projects),
            inputs.paths,
        )
        .await;
        let admitted = trust.admitted();
        let skipped: Vec<&str> = servers
            .iter()
            .filter(|server| !admitted.contains(&server.name))
            .map(|server| server.name.as_str())
            .collect();
        if !skipped.is_empty() {
            tracing::info!(servers = ?skipped, "workspace MCP servers wait for a trust grant");
        }
        servers.retain(|server| admitted.contains(&server.name));
        // Fork: a workspace that turns `features.mcp` off connects none of its servers (the
        // effective workspace config, `merge::mcp_enabled` like the process assembly).
        if !merge::mcp_enabled(&layers) {
            servers.clear();
        }
        // Fork: the controller's machine-binding sidecar applies before the cwd resolution (a
        // server bound to another machine keeps its raw cwd; `resolve_project_cwds` localizes only
        // primary ones).
        let bindings_path = self.paths.mcp_machines().as_path().display().to_string();
        let bindings = crate::assemble::mcp_machines::McpBindings::load(
            self.files.as_ref(),
            workspace,
            &bindings_path,
        )
        .await;
        bindings.bind(&mut servers);
        merge::resolve_project_cwds(&mut servers, &merged.origins);
        debug_assert!(
            servers
                .iter()
                .all(|server| server.scope == McpScope::Project)
        );
        for warning in &warnings {
            tracing::debug!(warning, "configuration (workspace layer)");
        }
        Some(WorkspaceConfig {
            plugins: sources,
            servers,
        })
    }
}

#[cfg(test)]
#[path = "workspace_layer_tests.rs"]
mod tests;
