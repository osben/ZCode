//! Fork: what the client tells a server and answers it (specs/fork-rust-lsp.md "Pool"): Node adapters
//! `lsp/client-capabilities.ts`, `lsp/server-requests.ts`, `lsp/paths.ts`, and the file-to-server registry of core
//! `lsp/registry.ts`.

use std::sync::{Arc, Mutex};

use rust_cli_base::sync::LockUnpoisoned;
use rust_cli_ext::plugins::lsp::ResolvedLspServer;
use rust_cli_kernel_api::env_files::PathStyle;
use serde_json::{Map, Value, json};

use super::LspError;
use super::rpc::ServerRequests;
use super::uri::folder_uri;

pub(crate) const PULL_DIAGNOSTICS: &str = "textDocument/diagnostic";
const METHOD_NOT_FOUND: i64 = -32_601;

/// Node `LSP_CLIENT_CAPABILITIES`.
pub(crate) fn client_capabilities() -> Value {
    json!({
        "general": {"positionEncodings": ["utf-16"]},
        "textDocument": {
            "synchronization": {"dynamicRegistration": false, "didSave": false},
            "publishDiagnostics": {"versionSupport": true},
            "diagnostic": {"dynamicRegistration": true},
            "definition": {},
            "references": {},
            "implementation": {},
            "hover": {"contentFormat": ["markdown", "plaintext"]},
            "documentSymbol": {"hierarchicalDocumentSymbolSupport": true},
        },
        "workspace": {
            "configuration": true,
            "workspaceFolders": true,
            "didChangeWatchedFiles": {"dynamicRegistration": false},
            "symbol": {},
        },
    })
}

fn style(windows: bool) -> PathStyle {
    if windows {
        PathStyle::Windows
    } else {
        PathStyle::Posix
    }
}

/// Node `resolveWorkspaceFolder`.
fn resolve_workspace_folder(
    workspace: &str,
    folder: &str,
    windows: bool,
) -> Result<String, LspError> {
    let style = style(windows);
    let resolved = style.resolve(workspace, folder, None);
    if !style.is_within(&resolved, workspace) {
        return Err(LspError::new(
            "lsp_server_start_failed",
            format!(
                "workspaceFolder {} resolves outside the workspace",
                Value::String(folder.to_owned())
            ),
        ));
    }
    Ok(resolved)
}

/// Node `toWorkspaceFolder`: the root has no base name, so its name is the separator.
fn workspace_folder(path: &str, windows: bool) -> Value {
    let style = style(windows);
    let name = match style.file_name(path) {
        name if name.is_empty() => style.separator().to_string(),
        name => name,
    };
    json!({"uri": folder_uri(path, windows), "name": name})
}

/// The workspace folders the server is told about: the workspace, plus the server's `workspaceFolder` when it differs.
pub(crate) fn workspace_folders(
    server: &ResolvedLspServer,
    workspace: &str,
    windows: bool,
) -> Result<Vec<Value>, LspError> {
    let mut folders = vec![workspace.to_owned()];
    if let Some(folder) = &server.workspace_folder {
        let resolved = resolve_workspace_folder(workspace, folder, windows)?;
        if resolved != workspace {
            folders.push(resolved);
        }
    }
    Ok(folders
        .iter()
        .map(|folder| workspace_folder(folder, windows))
        .collect())
}

/// Node `buildInitializeParams`.
pub(crate) fn initialize_params(
    server: &ResolvedLspServer,
    workspace: &str,
    folders: &[Value],
    process_id: u32,
    windows: bool,
) -> Value {
    let mut params = json!({
        "processId": process_id,
        "clientInfo": {"name": "zcode"},
        "rootUri": folder_uri(workspace, windows),
        "rootPath": workspace,
        "workspaceFolders": folders,
        "capabilities": client_capabilities(),
    });
    if let Some(options) = &server.initialization_options {
        params["initializationOptions"] = options.clone();
    }
    params
}

/// Node `LspDynamicRegistry`: registrations by id, in insertion order.
#[derive(Debug, Default)]
pub(crate) struct Registrations(Vec<(String, String, Option<Value>)>);

impl Registrations {
    fn register(&mut self, items: Option<&Value>) {
        for item in items.and_then(Value::as_array).into_iter().flatten() {
            let (Some(id), Some(method)) = (
                item.get("id").and_then(Value::as_str),
                item.get("method").and_then(Value::as_str),
            ) else {
                continue;
            };
            let options = item.get("registerOptions").cloned();
            match self.0.iter_mut().find(|(known, _, _)| known == id) {
                // A `Map.set` of a known key keeps its place.
                Some(slot) => *slot = (id.to_owned(), method.to_owned(), options),
                None => self.0.push((id.to_owned(), method.to_owned(), options)),
            }
        }
    }

    fn unregister(&mut self, items: Option<&Value>) {
        for item in items.and_then(Value::as_array).into_iter().flatten() {
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                self.0.retain(|(known, _, _)| known != id);
            }
        }
    }

    /// Node `optionsFor`: the first registration of `method`, its options or `{}`.
    pub(crate) fn options_for(&self, method: &str) -> Option<Value> {
        self.0
            .iter()
            .find(|(_, known, _)| known == method)
            .map(|(_, _, options)| {
                options
                    .clone()
                    .filter(|options| !options.is_null())
                    .unwrap_or_else(|| Value::Object(Map::new()))
            })
    }
}

/// Node `lookupSettingsSection`.
pub(crate) fn settings_section(settings: Option<&Value>, section: Option<&Value>) -> Value {
    let section = match section {
        None | Some(Value::Null) => return settings.cloned().unwrap_or(Value::Null),
        Some(Value::String(section)) if section.is_empty() => {
            return settings.cloned().unwrap_or(Value::Null);
        }
        Some(Value::String(section)) => section,
        Some(_) => return Value::Null,
    };
    let mut current = settings;
    for segment in section.split('.') {
        current = current
            .and_then(Value::as_object)
            .and_then(|record| record.get(segment));
        if current.is_none() {
            return Value::Null;
        }
    }
    current.cloned().unwrap_or(Value::Null)
}

/// Node `handleServerRequest` over one process's settings, folders and registrations.
pub(crate) fn server_requests(
    settings: Option<Value>,
    folders: Vec<Value>,
    registrations: Arc<Mutex<Registrations>>,
) -> ServerRequests {
    Arc::new(move |method, params| {
        let record = params.as_object();
        let field = |name: &str| record.and_then(|record| record.get(name));
        match method {
            "workspace/configuration" => Ok(Value::Array(
                field("items")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|item| {
                        let section = item.as_object().and_then(|item| item.get("section"));
                        settings_section(settings.as_ref(), section)
                    })
                    .collect(),
            )),
            "client/registerCapability" => {
                registrations
                    .lock_unpoisoned()
                    .register(field("registrations"));
                Ok(Value::Null)
            }
            "client/unregisterCapability" => {
                // The LSP spec's own misspelling first, as Node.
                let items = field("unregisterations")
                    .filter(|items| !items.is_null())
                    .or_else(|| field("unregistrations"));
                registrations.lock_unpoisoned().unregister(items);
                Ok(Value::Null)
            }
            "window/workDoneProgress/create" => Ok(Value::Null),
            "workspace/workspaceFolders" => Ok(Value::Array(folders.clone())),
            _ => Err((
                METHOD_NOT_FOUND,
                format!("client does not implement {method}"),
            )),
        }
    })
}

/// Node `extname`: the last segment's last dot that is not its first character, case kept.
pub(crate) fn extname(path: &str) -> &str {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    match name.rfind('.') {
        Some(0) | None => "",
        Some(at) => &name[at..],
    }
}

/// Node `LspServerRegistry`: a file's server by its extension, exact first, then lowercase.
pub(crate) struct Registry {
    servers: Vec<Arc<ResolvedLspServer>>,
}

/// A file's server and its language id (Node `LspServerMatch`).
#[derive(Clone)]
pub(crate) struct Match {
    pub(crate) server: Arc<ResolvedLspServer>,
    pub(crate) language_id: String,
}

impl Registry {
    pub(crate) fn new(servers: Vec<ResolvedLspServer>) -> Self {
        Self {
            servers: servers.into_iter().map(Arc::new).collect(),
        }
    }

    pub(crate) fn servers(&self) -> &[Arc<ResolvedLspServer>] {
        &self.servers
    }

    pub(crate) fn for_file(&self, path: &str) -> Option<Match> {
        let extension = extname(path);
        if extension.is_empty() {
            return None;
        }
        let matching = |server: &Arc<ResolvedLspServer>, same: &dyn Fn(&str) -> bool| {
            server
                .extension_to_language
                .iter()
                .find(|(known, _)| same(known))
                .map(|(_, language)| Match {
                    server: Arc::clone(server),
                    language_id: language.clone(),
                })
        };
        // After conflict resolution an exact extension has one owner. The lowercase fallback takes the last loaded
        // server, as Node's registry orders servers by descending load priority.
        let lower = extension.to_lowercase();
        self.servers
            .iter()
            .find_map(|server| matching(server, &|known| known == extension))
            .or_else(|| {
                self.servers
                    .iter()
                    .rev()
                    .find_map(|server| matching(server, &|known| known.to_lowercase() == lower))
            })
    }
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
