//! Fork: language servers declared by plugins (specs/fork-rust-lsp.md "Declarations"), Node adapters `plugins/lsp.ts`:
//! the optional `.lsp.json` at the plugin root plus the manifest `lspServers` field (a path, an array or an inline
//! map), validated by the strict `LspServerConfigSchema`, expanded with [`super::template`], namespaced as
//! `<pluginId>/<serverName>`, and conflict-resolved across plugins. Nothing here starts a process.

use serde_json::{Map, Value};

use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::env_files::PathStyle;
use rust_cli_kernel_api::machine::Files;

use super::template::VariableContext;
use super::{Plugin, Reader};

const CONFIG_FILE: &str = ".lsp.json";
const MANIFEST_FIELD: &str = "lspServers";
const WRAPPER_KEY: &str = "lspServers";
/// Node `LSP_DEFAULT_*_MS`, `LSP_DEFAULT_MAX_RESTARTS` and the resolver defaults.
pub const DEFAULT_STARTUP_TIMEOUT_MS: u64 = 30_000;
pub const DEFAULT_SHUTDOWN_TIMEOUT_MS: u64 = 5_000;
pub const DEFAULT_REQUEST_TIMEOUT_MS: u64 = 60_000;
pub const DEFAULT_MAX_RESTARTS: u64 = 3;

/// One validated manifest entry (Node `LspServerConfig`). Absent optional fields are `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct LspServerConfig {
    pub command: String,
    /// Extension (with the dot) → languageId, in declaration order.
    pub extension_to_language: Vec<(String, String)>,
    pub args: Option<Vec<String>>,
    pub transport: Option<String>,
    pub env: Option<Vec<(String, String)>>,
    /// Present key, any JSON value (zod `unknown().optional()`).
    pub initialization_options: Option<Value>,
    pub settings: Option<Value>,
    pub workspace_folder: Option<String>,
    pub startup_timeout: Option<u64>,
    pub shutdown_timeout: Option<u64>,
    pub request_timeout: Option<u64>,
    pub restart_on_crash: Option<bool>,
    pub max_restarts: Option<u64>,
    pub diagnostics: Option<bool>,
}

/// A runnable server (Node `ResolvedLspServer`) without the priority: the order of a list is the load order.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedLspServer {
    /// `<pluginId>/<serverName>`, the key of preferences and status.
    pub id: String,
    pub plugin_id: String,
    pub server_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub extension_to_language: Vec<(String, String)>,
    pub initialization_options: Option<Value>,
    pub settings: Option<Value>,
    /// Workspace-relative; `None` is the workspace root.
    pub workspace_folder: Option<String>,
    pub startup_timeout_ms: u64,
    pub shutdown_timeout_ms: u64,
    pub request_timeout_ms: u64,
    pub restart_on_crash: bool,
    pub max_restarts: u64,
    /// The manifest default of diagnostics after edit; preferences may override it.
    pub diagnostics_after_edit: bool,
}

fn warn(plugin: &Plugin, message: &str) {
    tracing::warn!(
        event = "plugins.lsp.config_invalid",
        plugin = %plugin.id,
        message,
        "plugin language server declaration"
    );
}

/// Node `loadPluginLspServerDefinitions` for one loaded plugin, read through the files port. Read on demand: the
/// session catalogs do not carry language servers.
pub async fn declared(
    files: &dyn Files,
    workspace: &WorkspaceRef,
    plugin: &Plugin,
) -> Vec<(String, LspServerConfig)> {
    Reader { files, workspace }.lsp_definitions(plugin).await
}

impl Reader<'_> {
    /// The default file first, then the manifest field; a later declaration of a name replaces an earlier one
    /// (keeping its position) before validation.
    async fn lsp_definitions(&self, plugin: &Plugin) -> Vec<(String, LspServerConfig)> {
        let default_file = super::join(&plugin.dir, CONFIG_FILE);
        let mut raw = self.lsp_file(plugin, &default_file, true).await;
        let declared = Box::pin(self.lsp_spec(plugin, plugin.manifest.get(MANIFEST_FIELD))).await;
        for (name, value) in declared {
            raw.insert(name, value);
        }
        raw.into_iter()
            .filter_map(|(name, value)| match validate(&value) {
                Ok(config) => Some((name, config)),
                Err(issues) => {
                    warn(
                        plugin,
                        &format!(
                            "LSP server \"{name}\" in plugin {} is invalid and was skipped: {issues}",
                            plugin.id
                        ),
                    );
                    None
                }
            })
            .collect()
    }

    async fn lsp_spec(&self, plugin: &Plugin, spec: Option<&Value>) -> Map<String, Value> {
        match spec {
            None => Map::new(),
            Some(Value::String(path)) => match resolve_inside(&plugin.dir, path) {
                Some(path) => self.lsp_file(plugin, &path, false).await,
                None => {
                    warn(
                        plugin,
                        &format!("Plugin lspServers path escapes plugin root: {path}"),
                    );
                    Map::new()
                }
            },
            Some(Value::Array(items)) => {
                let mut merged = Map::new();
                for item in items {
                    for (name, value) in Box::pin(self.lsp_spec(plugin, Some(item))).await {
                        merged.insert(name, value);
                    }
                }
                merged
            }
            Some(value @ Value::Object(_)) => normalize(plugin, value),
            Some(_) => {
                warn(plugin, "lspServers must be a path, an array, or an object");
                Map::new()
            }
        }
    }

    /// The default file is optional; a declared file that is missing is a configuration error.
    async fn lsp_file(&self, plugin: &Plugin, path: &str, optional: bool) -> Map<String, Value> {
        if optional && self.kind(path).await.is_none() {
            return Map::new();
        }
        match self.parse(path).await {
            Ok(value) => normalize(plugin, &value),
            Err(error) => {
                warn(
                    plugin,
                    &format!("Failed to read LSP config {path}: {error}"),
                );
                Map::new()
            }
        }
    }
}

/// Node `normalizeLspServersShape`: a bare server map or the `{"lspServers": {…}}` wrapper.
fn normalize(plugin: &Plugin, value: &Value) -> Map<String, Value> {
    let Some(object) = value.as_object() else {
        warn(plugin, "LSP config must be an object");
        return Map::new();
    };
    match object.get(WRAPPER_KEY) {
        Some(Value::Object(servers)) => servers.clone(),
        _ => object.clone(),
    }
}

/// Node `resolveInside`: a relative path that stays under the root (Node's `..` prefix check included).
fn resolve_inside(root: &str, raw: &str) -> Option<String> {
    let style = PathStyle::infer(root);
    if style.is_absolute(raw) {
        return None;
    }
    let resolved = style.resolve(root, raw, None);
    let relative = style.relative(root, &resolved)?;
    (relative.is_empty() || !relative.starts_with("..")).then_some(resolved)
}

/// JS `\s` (the `u` flag): Unicode white space plus the BOM.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `^\.[^\s/\\]+$`.
fn extension_key(key: &str) -> bool {
    key.strip_prefix('.').is_some_and(|rest| {
        !rest.is_empty() && !rest.chars().any(|c| js_space(c) || c == '/' || c == '\\')
    })
}

const KNOWN: [&str; 14] = [
    "command",
    "extensionToLanguage",
    "args",
    "transport",
    "env",
    "initializationOptions",
    "settings",
    "workspaceFolder",
    "startupTimeout",
    "shutdownTimeout",
    "requestTimeout",
    "restartOnCrash",
    "maxRestarts",
    "diagnostics",
];

/// zod `.int()` (Number.isInteger) as a `u64`; `positive` also refuses zero.
fn integer(value: &Value, positive: bool) -> Option<u64> {
    let number = value.as_f64()?;
    let ok = number.is_finite()
        && number.fract() == 0.0
        && if positive {
            number > 0.0
        } else {
            number >= 0.0
        };
    // A finite integral double in range: the cast is exact.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    ok.then(|| value.as_u64().unwrap_or(number as u64))
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value
        .as_array()?
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn string_record(value: &Value) -> Option<Vec<(String, String)>> {
    value
        .as_object()?
        .iter()
        .map(|(key, item)| item.as_str().map(|text| (key.clone(), text.to_owned())))
        .collect()
}

/// Node `LspServerConfigSchema` (strict). The error lists the failing paths like zod's issue summary.
pub fn validate(value: &Value) -> Result<LspServerConfig, String> {
    let Some(object) = value.as_object() else {
        return Err("(root): Expected object".to_owned());
    };
    let mut issues: Vec<String> = Vec::new();
    let mut issue = |path: &str, message: &str| issues.push(format!("{path}: {message}"));
    let unknown: Vec<&String> = object
        .keys()
        .filter(|key| !KNOWN.contains(&key.as_str()))
        .collect();
    if !unknown.is_empty() {
        let keys: Vec<String> = unknown.iter().map(|key| format!("'{key}'")).collect();
        issue(
            "(root)",
            &format!("Unrecognized key(s) in object: {}", keys.join(", ")),
        );
    }
    let command = match object.get("command") {
        Some(Value::String(command)) if !command.is_empty() => command.clone(),
        _ => {
            issue("command", "Expected a non-empty string");
            String::new()
        }
    };
    let mut extension_to_language = Vec::new();
    match object.get("extensionToLanguage").and_then(Value::as_object) {
        Some(map) => {
            for (key, language) in map {
                if !extension_key(key) {
                    issue(&format!("extensionToLanguage.{key}"), "Invalid extension");
                }
                match language.as_str().filter(|language| !language.is_empty()) {
                    Some(language) => {
                        extension_to_language.push((key.clone(), language.to_owned()))
                    }
                    None => issue(
                        &format!("extensionToLanguage.{key}"),
                        "Expected a non-empty string",
                    ),
                }
            }
            if map.is_empty() {
                issue(
                    "extensionToLanguage",
                    "extensionToLanguage needs at least one entry",
                );
            }
        }
        None => issue("extensionToLanguage", "Expected object"),
    }
    let mut optional = |key: &str, check: &dyn Fn(&Value) -> bool| match object.get(key) {
        Some(value) if !check(value) => {
            issue(key, "Invalid value");
            None
        }
        other => other.cloned(),
    };
    let args = optional("args", &|value| strings(value).is_some());
    let transport = optional("transport", &|value| {
        matches!(value.as_str(), Some("stdio" | "socket"))
    });
    let env = optional("env", &|value| string_record(value).is_some());
    let workspace_folder = optional("workspaceFolder", &|value| {
        value.as_str().is_some_and(|text| !text.is_empty())
    });
    let startup = optional("startupTimeout", &|value| integer(value, true).is_some());
    let shutdown = optional("shutdownTimeout", &|value| integer(value, true).is_some());
    let request = optional("requestTimeout", &|value| integer(value, true).is_some());
    let restart = optional("restartOnCrash", &|value| value.is_boolean());
    let max_restarts = optional("maxRestarts", &|value| integer(value, false).is_some());
    let diagnostics = optional("diagnostics", &|value| value.is_boolean());
    if !issues.is_empty() {
        return Err(issues.join("; "));
    }
    Ok(LspServerConfig {
        command,
        extension_to_language,
        args: args.as_ref().and_then(strings),
        transport: transport
            .as_ref()
            .and_then(Value::as_str)
            .map(str::to_owned),
        env: env.as_ref().and_then(string_record),
        initialization_options: object.get("initializationOptions").cloned(),
        settings: object.get("settings").cloned(),
        workspace_folder: workspace_folder
            .as_ref()
            .and_then(Value::as_str)
            .map(str::to_owned),
        startup_timeout: startup.as_ref().and_then(|value| integer(value, true)),
        shutdown_timeout: shutdown.as_ref().and_then(|value| integer(value, true)),
        request_timeout: request.as_ref().and_then(|value| integer(value, true)),
        restart_on_crash: restart.as_ref().and_then(Value::as_bool),
        max_restarts: max_restarts
            .as_ref()
            .and_then(|value| integer(value, false)),
        diagnostics: diagnostics.as_ref().and_then(Value::as_bool),
    })
}

/// Node `resolvePluginLspServers` for one enabled plugin: a server whose templates fail is skipped.
pub fn resolve(
    definitions: &[(String, LspServerConfig)],
    context: &VariableContext<'_>,
) -> Vec<ResolvedLspServer> {
    definitions
        .iter()
        .filter_map(|(name, config)| match resolve_one(name, config, context) {
            Ok(server) => Some(server),
            Err(error) => {
                warn(
                    context.plugin,
                    &format!(
                        "LSP server \"{name}\" in plugin {} could not be resolved and was skipped: {error}",
                        context.plugin.id
                    ),
                );
                None
            }
        })
        .collect()
}

fn resolve_one(
    name: &str,
    config: &LspServerConfig,
    context: &VariableContext<'_>,
) -> Result<ResolvedLspServer, String> {
    // `{...buildPluginEnvBase(context), ...config.env}`: a redeclared identity variable keeps its position.
    let mut merged: Vec<(String, String)> = context.env_base();
    for (key, value) in config.env.iter().flatten() {
        match merged.iter_mut().find(|(known, _)| known == key) {
            Some(slot) => slot.1.clone_from(value),
            None => merged.push((key.clone(), value.clone())),
        }
    }
    let env = merged
        .into_iter()
        .map(|(key, value)| Ok((key, context.resolve(&value, true)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let workspace_folder = match &config.workspace_folder {
        Some(folder) => {
            workspace_folder(&context.resolve(folder, false)?, &context.working_directory)?
        }
        None => None,
    };
    let plugin_id = context.plugin.id.clone();
    Ok(ResolvedLspServer {
        id: format!("{plugin_id}/{name}"),
        plugin_id,
        server_name: name.to_owned(),
        command: context.resolve(&config.command, false)?,
        args: config
            .args
            .iter()
            .flatten()
            .map(|arg| context.resolve(arg, false))
            .collect::<Result<_, _>>()?,
        env,
        extension_to_language: config.extension_to_language.clone(),
        initialization_options: config.initialization_options.clone(),
        settings: config.settings.clone(),
        workspace_folder,
        startup_timeout_ms: config.startup_timeout.unwrap_or(DEFAULT_STARTUP_TIMEOUT_MS),
        shutdown_timeout_ms: config
            .shutdown_timeout
            .unwrap_or(DEFAULT_SHUTDOWN_TIMEOUT_MS),
        request_timeout_ms: config.request_timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT_MS),
        restart_on_crash: config.restart_on_crash.unwrap_or(true),
        max_restarts: config.max_restarts.unwrap_or(DEFAULT_MAX_RESTARTS),
        diagnostics_after_edit: config.diagnostics.unwrap_or(true),
    })
}

/// Node `resolveWorkspaceFolder`: inside the workspace, stored relative to it; the root itself is `None`.
fn workspace_folder(value: &str, working_directory: &str) -> Result<Option<String>, String> {
    let style = PathStyle::infer(working_directory);
    let resolved = style.resolve(working_directory, value, None);
    match style.relative(working_directory, &resolved) {
        Some(relative) if relative.is_empty() => Ok(None),
        Some(relative) => Ok(Some(relative)),
        None => Err(format!(
            "workspaceFolder must be inside the workspace: {value}"
        )),
    }
}

/// Node `resolveLspExtensionConflicts`: in load order the first server keeps an extension; a later server keeps its
/// other extensions and is dropped when none remain. The output keeps the input order.
pub fn resolve_conflicts(servers: Vec<ResolvedLspServer>) -> Vec<ResolvedLspServer> {
    let mut owners: Vec<(String, String)> = Vec::new();
    let mut kept = Vec::with_capacity(servers.len());
    for mut server in servers {
        let mut shadowed = Vec::new();
        let mut winner: Option<String> = None;
        server.extension_to_language.retain(|(extension, _)| {
            match owners.iter().find(|(owned, _)| owned == extension) {
                Some((_, owner)) => {
                    winner.get_or_insert_with(|| owner.clone());
                    shadowed.push(extension.clone());
                    false
                }
                None => {
                    owners.push((extension.clone(), server.id.clone()));
                    true
                }
            }
        });
        if let Some(winner) = winner {
            tracing::warn!(
                event = "plugins.lsp.extension_shadowed",
                plugin = %server.plugin_id,
                server = %server.server_name,
                extensions = %shadowed.join(", "),
                winner = %winner,
                "a language server lost extensions to an earlier plugin"
            );
        }
        if !server.extension_to_language.is_empty() {
            kept.push(server);
        }
    }
    kept
}

#[cfg(test)]
#[path = "lsp_tests.rs"]
mod tests;
