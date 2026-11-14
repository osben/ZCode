//! Fork: the app-server's language-server host (specs/fork-rust-lsp.md), Node bootstrap `app/lsp-runtime-hub.ts`:
//! the process-wide pool and documents, one [`runtime::session::SessionLsp`] per session, the status overlay and the
//! preferences sidecar shared with Node.

mod installed;
mod preferences;
mod runtime;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use rust_cli_base::secret::EnvSnapshot;
use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_ext::plugins::lsp::{declared, resolve, resolve_conflicts};
use rust_cli_ext::plugins::template::{VariableContext, sanitize_plugin_id};
use rust_cli_ext::plugins::{Plugin, load_all};
use rust_cli_kernel_api::env::{EnvPath, ReadFile, WorkspaceRef};
use rust_cli_kernel_api::env_files::{PathStyle, StatFile};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::lsp::{
    CodeIntelligence, FileMutation, LanguageServers, LspOutput, LspPreferences,
    LspPreferencesPatch, LspQuery, LspQueryError, LspServerStatus, LspStatus, LspWorkspace,
};
use rust_cli_kernel_api::machine::Files;
use rust_cli_kernel_api::remote_identity::is_remote_workspace_identity;
use rust_cli_kernel_api::store::StoreQueries;
use rust_cli_paths::StoragePaths;
use serde_json::{Map, Value};
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use self::preferences::PreferencesStore;
use self::runtime::documents::{Disk, Documents, Snapshot};
use self::runtime::pool::{Limits, Pool, ServerKey, Status, merge_env};
use self::runtime::process::Launcher;
pub(crate) use self::runtime::process::LedgerLauncher;
use self::runtime::server::Registry;
use self::runtime::session::{InstallProbe, SessionLsp, Shared, SharedPreferences};
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
    /// Starts the server processes (the process ledger in production).
    pub(crate) launcher: Arc<dyn Launcher>,
    /// The session's workspace key (the pool identity); without it the workspace root is the identity.
    pub(crate) store: Option<Arc<dyn StoreQueries>>,
}

/// A session's runtime, created on its first prewarm or mutation; `None` inside: no server is declared there.
type SessionSlot = (String, Arc<OnceCell<Option<Arc<SessionLsp>>>>);

/// Node `isLspCommandInstalled` over the stdio-server env plus the server's own (the same probe as `lsp/status`).
struct CommandProbe {
    base_env: Vec<(String, String)>,
}

#[async_trait]
impl InstallProbe for CommandProbe {
    async fn installed(&self, server: &rust_cli_ext::plugins::lsp::ResolvedLspServer) -> bool {
        let env = merge_env(&self.base_env, &server.env, cfg!(windows));
        installed::installed(&server.command, &env).await
    }
}

pub(crate) struct Host {
    inputs: HostInputs,
    preferences: PreferencesStore,
    /// The stdio-server projection of the process env: the base of every server's env and of the install probe.
    base_env: Vec<(String, String)>,
    shared: Shared,
    loaded: OnceCell<()>,
    sessions: Mutex<HashMap<SessionId, SessionSlot>>,
    /// Whether each session is offered the `LSP` tool, and the workspace it was computed for (specs/fork-rust-lsp.md
    /// "When the tool is offered"): computed by the first `settle_tool` for the session's workspace and by every preference write, read by `tool_offered`.
    tool_facts: Mutex<HashMap<SessionId, (WorkspaceRef, bool)>>,
    /// Bumped by every preference write. A settle or refresh stores its answer only while no write landed during its
    /// computation (Node serializes them in `lspPreferenceQueues` "so an older availability result cannot win"): a
    /// settle that probed before a write would otherwise store its older answer after the write's refresh skipped it.
    tool_generation: std::sync::atomic::AtomicU64,
}

impl Host {
    pub(crate) fn new(inputs: HostInputs) -> Self {
        let preferences = PreferencesStore::new(inputs.preferences.clone());
        let windows = cfg!(windows);
        let base_env: Vec<(String, String)> =
            rust_cli_env_local::stdio_server_env(inputs.process_env.vars())
                .into_iter()
                .collect();
        let shared = Shared {
            pool: Pool::new(
                Arc::clone(&inputs.launcher),
                base_env.clone(),
                windows,
                Limits::default(),
            ),
            documents: Documents::new(windows),
            preferences: SharedPreferences::default(),
            probe: Arc::new(CommandProbe {
                base_env: base_env.clone(),
            }),
        };
        Self {
            inputs,
            preferences,
            base_env,
            shared,
            loaded: OnceCell::new(),
            sessions: Mutex::default(),
            tool_facts: Mutex::default(),
            tool_generation: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Node `isAvailable` for the session's runtime: enabled, and a declared server of the workspace is installed.
    async fn tool_available(&self, session: &SessionId, workspace: &WorkspaceRef) -> bool {
        if !self.current().await.enabled {
            return false;
        }
        match self.session(session, workspace).await {
            Some(runtime) => runtime.any_installed().await,
            None => false,
        }
    }

    /// Node `applyLspPreferences` for every runtime: each session's fact is recomputed before the write answers.
    async fn refresh_tool_facts(&self) {
        let known: Vec<(SessionId, WorkspaceRef)> = self
            .tool_facts
            .lock_unpoisoned()
            .iter()
            .map(|(session, (workspace, _))| (session.clone(), workspace.clone()))
            .collect();
        for (session, workspace) in known {
            let generation = self.tool_generation();
            let available = self.tool_available(&session, &workspace).await;
            let mut facts = self.tool_facts.lock_unpoisoned();
            // A later write's refresh recomputes it; a settle for another workspace meanwhile owns the fact.
            if self.tool_generation() != generation {
                return;
            }
            if let Some(fact) = facts.get_mut(&session)
                && fact.0 == workspace
            {
                fact.1 = available;
            }
        }
    }

    fn tool_generation(&self) -> u64 {
        self.tool_generation
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Node `getPreferences`: the cached preferences, loaded from the sidecar on first use and refreshed by every
    /// protocol read and write.
    async fn current(&self) -> LspPreferences {
        self.loaded
            .get_or_init(|| async {
                self.preferences
                    .load_and(|loaded| self.remember(loaded))
                    .await;
            })
            .await;
        self.shared.preferences.lock_unpoisoned().clone()
    }

    fn remember(&self, prefs: &LspPreferences) {
        *self.shared.preferences.lock_unpoisoned() = prefs.clone();
    }

    /// The session's runtime for `workspace`; a session that moved to another root gets a new one.
    async fn session(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
    ) -> Option<Arc<SessionLsp>> {
        let root = workspace.root.as_str().to_owned();
        let cell = {
            let mut sessions = self.sessions.lock_unpoisoned();
            let slot = sessions
                .entry(session.clone())
                .or_insert_with(|| (root.clone(), Arc::default()));
            if slot.0 != root {
                *slot = (root.clone(), Arc::default());
            }
            Arc::clone(&slot.1)
        };
        cell.get_or_init(|| async {
            // The host serves its own machine only.
            if workspace.environment != self.inputs.environment {
                return None;
            }
            let servers = self.servers(&root).await;
            if servers.is_empty() {
                return None;
            }
            let identity = match &self.inputs.store {
                Some(store) => match store.session_workspace_key(session).await {
                    Ok(identity) => identity,
                    Err(error) => {
                        // The root becomes this session's key; status for an identity would not see its servers.
                        tracing::warn!(event = "core.lsp.warn", operation = "workspace_key", %error, "LSP operation failed");
                        None
                    }
                },
                None => None,
            };
            // Node `create-app.ts` declares no servers for a remote workspace identity (the raw value, untrimmed).
            if identity.as_deref().is_some_and(is_remote_workspace_identity) {
                return None;
            }
            let key = ServerKey {
                identity: identity
                    .map(|identity| identity.trim().to_owned())
                    .filter(|identity| !identity.is_empty())
                    .unwrap_or_else(|| root.clone()),
                workspace: root.clone(),
            };
            let disk = Arc::new(FilesDisk {
                files: Arc::clone(&self.inputs.files),
                workspace: workspace.clone(),
            });
            Some(SessionLsp::new(
                self.shared.clone(),
                Registry::new(servers),
                key,
                disk,
            ))
        })
        .await
        .clone()
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

/// Node `toStatusEntry`: the pool entry of the same server and key, when there is one.
fn entry(
    server: rust_cli_ext::plugins::lsp::ResolvedLspServer,
    prefs: &LspPreferences,
    installed: bool,
    running: Option<&Status>,
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
        state: match running {
            Some(running) => running.state.as_str(),
            None if installed => "stopped",
            None => "not_installed",
        },
        diagnostics_mode: if running.is_some_and(|running| running.pull) {
            "pull"
        } else {
            "unknown"
        },
        diagnostics_after_edit,
        restarts: running.map_or(0, |running| {
            u32::try_from(running.restarts).unwrap_or(u32::MAX)
        }),
        last_error_code: running
            .and_then(|running| running.last_error_code)
            .map(str::to_owned),
    }
}

/// The workspace's files through the Files port (Node `LspFileSystem`).
struct FilesDisk {
    files: Arc<dyn Files>,
    workspace: WorkspaceRef,
}

#[async_trait]
impl Disk for FilesDisk {
    async fn stat(&self, path: &str) -> Result<Snapshot, String> {
        let request = StatFile {
            path: EnvPath::new(path),
        };
        match self.files.stat(&self.workspace, request).await {
            Ok(Some(stat)) => Ok(Snapshot {
                size: stat.size,
                mtime_ms: Some(stat.mtime_ms),
            }),
            Ok(None) => Err("ENOENT".to_owned()),
            Err(error) => Err(error.to_string()),
        }
    }

    async fn read(&self, path: &str) -> Result<String, String> {
        let request = ReadFile {
            path: EnvPath::new(path),
        };
        let content = self
            .files
            .read_file(&self.workspace, request)
            .await
            .map_err(|error| error.to_string())?;
        Ok(String::from_utf8_lossy(&content.bytes).into_owned())
    }
}

#[async_trait]
impl LanguageServers for Host {
    async fn preferences(&self) -> Result<LspPreferences, String> {
        // Remembered inside the store's turn: a read that started before a write cannot overwrite what it published.
        Ok(self
            .preferences
            .load_and(|prefs| self.remember(prefs))
            .await)
    }

    /// Node `applyPreferences`: turning code intelligence off stops every server.
    async fn set_preferences(&self, patch: LspPreferencesPatch) -> Result<LspPreferences, String> {
        // Remembered before `stop_all`: the pool reads the switch under the lock `stop_all` takes.
        let prefs = self
            .preferences
            .update_and(&patch, |prefs| self.remember(prefs))
            .await?;
        self.tool_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if !prefs.enabled {
            self.shared.pool.stop_all().await;
        }
        self.refresh_tool_facts().await;
        Ok(prefs)
    }

    async fn status(&self, workspace: &LspWorkspace) -> Result<LspStatus, String> {
        let prefs = self
            .preferences
            .load_and(|prefs| self.remember(prefs))
            .await;
        // The pool key (identity and root), never the path alone.
        let key = ServerKey {
            identity: workspace
                .identity
                .as_deref()
                .map(str::trim)
                .filter(|identity| !identity.is_empty())
                .unwrap_or(&workspace.path)
                .to_owned(),
            workspace: workspace.path.clone(),
        };
        let live: Vec<Status> = self
            .shared
            .pool
            .status()
            .into_iter()
            .filter(|status| status.key == key)
            .collect();
        let mut servers = Vec::new();
        for server in self.servers(&workspace.path).await {
            let env = merge_env(&self.base_env, &server.env, cfg!(windows));
            let found = installed::installed(&server.command, &env).await;
            let running = live.iter().find(|status| status.server_id == server.id);
            servers.push(entry(server, &prefs, found, running));
        }
        Ok(LspStatus {
            enabled: prefs.enabled,
            servers,
        })
    }
}

#[async_trait]
impl CodeIntelligence for Host {
    async fn prewarm(&self, session: &SessionId, workspace: &WorkspaceRef, path: &str) {
        if !self.current().await.enabled {
            return;
        }
        if let Some(runtime) = self.session(session, workspace).await {
            runtime.prewarm(path);
        }
    }

    async fn file_mutated(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        mutation: FileMutation,
    ) {
        if !self.current().await.enabled {
            return;
        }
        if let Some(runtime) = self.session(session, workspace).await {
            runtime.file_mutated(mutation);
        }
    }

    /// Nothing pending: no plugin is resolved and nothing waits.
    async fn edit_diagnostics(&self, session: &SessionId) -> Option<String> {
        let runtime = {
            let sessions = self.sessions.lock_unpoisoned();
            sessions.get(session)?.1.get()?.clone()?
        };
        if !runtime.has_pending() {
            return None;
        }
        runtime.edit_diagnostics().await
    }

    fn session_closed(&self, session: &SessionId) {
        self.sessions.lock_unpoisoned().remove(session);
        self.tool_facts.lock_unpoisoned().remove(session);
    }

    async fn settle_tool(&self, session: &SessionId, workspace: &WorkspaceRef) {
        let settled = self
            .tool_facts
            .lock_unpoisoned()
            .get(session)
            .is_some_and(|(known, _)| known == workspace);
        // Node computes availability when the runtime is built and on preference writes, never per turn.
        if settled {
            return;
        }
        loop {
            let generation = self.tool_generation();
            let available = self.tool_available(session, workspace).await;
            let mut facts = self.tool_facts.lock_unpoisoned();
            // A write landed while probing: its refresh skipped this session, so the answer may predate it.
            if self.tool_generation() == generation {
                facts.insert(session.clone(), (workspace.clone(), available));
                return;
            }
        }
    }

    fn tool_offered(&self, session: &SessionId) -> bool {
        self.shared.preferences.lock_unpoisoned().enabled
            && self
                .tool_facts
                .lock_unpoisoned()
                .get(session)
                .is_some_and(|(_, available)| *available)
    }

    async fn query(
        &self,
        session: &SessionId,
        workspace: &WorkspaceRef,
        query: LspQuery,
        cancel: &CancellationToken,
    ) -> Result<LspOutput, LspQueryError> {
        let failure = |error: runtime::LspError| LspQueryError {
            code: error.code.to_owned(),
            message: error.message,
        };
        if !self.current().await.enabled {
            return Err(failure(runtime::LspError::new(
                "lsp_disabled",
                "Code intelligence is turned off",
            )));
        }
        // No declared server: Node's runtime has an empty registry, so no file has a server.
        let Some(runtime) = self.session(session, workspace).await else {
            return Err(failure(runtime::LspError::new(
                "lsp_no_server_for_file",
                format!(
                    "No language server is configured for {} on this file type",
                    query.operation.as_str()
                ),
            )));
        };
        runtime.query(&query, cancel).await.map_err(failure)
    }
}

#[cfg(test)]
#[path = "lsp_tests.rs"]
mod tests;
