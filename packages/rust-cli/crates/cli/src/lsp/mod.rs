//! Fork: the app-server's language-server host (specs/fork-rust-lsp.md), Node bootstrap `app/lsp-runtime-hub.ts`
//! `protocolHost`. Stage 1 starts no server: status lists the declared servers of the requested workspace as
//! `stopped` or `not_installed`; preferences live in the sidecar shared with Node.

mod installed;
mod preferences;
#[allow(dead_code)]
mod runtime;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use rust_cli_base::secret::EnvSnapshot;
use rust_cli_ext::plugins::lsp::{declared, resolve, resolve_conflicts};
use rust_cli_ext::plugins::template::{VariableContext, sanitize_plugin_id};
use rust_cli_ext::plugins::{Plugin, load_all};
use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::env_files::PathStyle;
use rust_cli_kernel_api::ids::EnvironmentId;
use rust_cli_kernel_api::lsp::{
    LanguageServers, LspPreferences, LspPreferencesPatch, LspServerStatus, LspStatus, LspWorkspace,
};
use rust_cli_kernel_api::machine::Files;
use rust_cli_paths::StoragePaths;
use serde_json::{Map, Value};

use self::preferences::PreferencesStore;
use crate::config::{ConfigInputs, plugin_view};

/// What the host needs from the app-server assembly.
pub(crate) struct HostInputs {
    /// The local machine's files (plugins and project config are local in the app-server).
    pub(crate) files: Arc<dyn Files>,
    pub(crate) environment: EnvironmentId,
    pub(crate) paths: StoragePaths,
    pub(crate) process_env: EnvSnapshot,
    /// The desktop surface has the App's view host (plugin admission, as for sessions).
    pub(crate) view_host: bool,
    /// `<cliStorageRoot>/fork_lsp_preferences.json`.
    pub(crate) preferences: PathBuf,
}

pub(crate) struct Host {
    inputs: HostInputs,
    preferences: PreferencesStore,
}

impl Host {
    pub(crate) fn new(inputs: HostInputs) -> Self {
        let preferences = PreferencesStore::new(inputs.preferences.clone());
        Self {
            inputs,
            preferences,
        }
    }

    /// The servers the enabled plugins declare for `workspace` (Node `resolveZCodePlugins({workingDirectory})
    /// .lspServers`), recomputed on every call.
    async fn servers(&self, workspace: &str) -> Vec<rust_cli_ext::plugins::lsp::ResolvedLspServer> {
        // Node `resolve(workingDirectory)`: the path config discovery and templates see.
        let workspace = PathStyle::infer(workspace).normalize(workspace);
        let workspace = workspace.as_str();
        let reference = WorkspaceRef {
            environment: self.inputs.environment.clone(),
            root: EnvPath::new(workspace),
        };
        let view = plugin_view(&ConfigInputs {
            files: self.inputs.files.as_ref(),
            workspace: &reference,
            paths: &self.inputs.paths,
            process_env: &self.inputs.process_env,
            flag: None,
            project_is_local: true,
        })
        .await;
        let mut sources = view.sources;
        sources.view_host = self.inputs.view_host;
        let plugins = load_all(self.inputs.files.as_ref(), &reference, &[], &sources)
            .await
            .plugins;
        let empty = Map::new();
        let mut servers = Vec::new();
        for plugin in &plugins.0 {
            let definitions = declared(self.inputs.files.as_ref(), &reference, plugin).await;
            if definitions.is_empty() {
                continue;
            }
            let context = VariableContext {
                plugin,
                data_path: data_path(&view.storage, plugin),
                env: &self.inputs.process_env,
                options: view.options.get(&plugin.id).unwrap_or(&empty),
                working_directory: workspace.to_owned(),
            };
            servers.extend(resolve(&definitions, &context));
        }
        resolve_conflicts(servers)
    }
}

/// Node `dataPath`: `<plugin storage>/data/<sanitized id>`.
fn data_path(storage: &rust_cli_paths::StoragePath, plugin: &Plugin) -> String {
    storage
        .as_path()
        .join("data")
        .join(sanitize_plugin_id(&plugin.id))
        .to_string_lossy()
        .into_owned()
}

/// The status entry of a declared server that is not running (Node `toStatusEntry` without a pool entry).
fn entry(
    server: rust_cli_ext::plugins::lsp::ResolvedLspServer,
    prefs: &LspPreferences,
    installed: bool,
) -> LspServerStatus {
    let diagnostics_after_edit = prefs
        .diagnostics_after_edit
        .get(&server.id)
        .and_then(Value::as_bool)
        .unwrap_or(server.diagnostics_after_edit);
    LspServerStatus {
        extensions: server
            .extension_to_language
            .into_iter()
            .map(|(extension, _)| extension)
            .collect(),
        server_id: server.id,
        plugin_id: server.plugin_id,
        server_name: server.server_name,
        command: server.command,
        installed,
        state: if installed {
            "stopped"
        } else {
            "not_installed"
        },
        diagnostics_mode: "unknown",
        diagnostics_after_edit,
        restarts: 0,
        last_error_code: None,
    }
}

#[async_trait]
impl LanguageServers for Host {
    async fn preferences(&self) -> Result<LspPreferences, String> {
        Ok(self.preferences.load().await)
    }

    async fn set_preferences(&self, patch: LspPreferencesPatch) -> Result<LspPreferences, String> {
        // Stage 1 has no running servers to apply the result to (Node `applyPreferences`).
        self.preferences.update(&patch).await
    }

    async fn status(&self, workspace: &LspWorkspace) -> Result<LspStatus, String> {
        let prefs = self.preferences.load().await;
        let mut servers = Vec::new();
        for server in self.servers(&workspace.path).await {
            let env = installed::process_env(&self.inputs.process_env, &server.env, cfg!(windows));
            let found = installed::installed(&server.command, &env).await;
            servers.push(entry(server, &prefs, found));
        }
        Ok(LspStatus {
            enabled: prefs.enabled,
            servers,
        })
    }
}

#[cfg(test)]
#[path = "lsp_tests.rs"]
mod tests;
