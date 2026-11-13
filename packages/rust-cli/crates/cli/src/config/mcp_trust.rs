//! Workspace MCP trust (specs/fork-rust-agent-parity.md, "Workspace MCP trust"): which project-declared MCP
//! servers a workspace has, their declaration digests, and whether the shared trust store grants them. Ports
//! Node `createWorkspaceMcpTrust` (`apps/zcode-cli/packages/bootstrap/src/workspace-mcp-trust/index.ts`); the
//! digest, source paths and display match Node byte for byte (`tests/fixtures/mcp-trust-golden.json`), so a grant
//! made by either runtime holds in the other.
//!
//! Discovery reproduces Node's project config merge, including its quirk: the merge assigns each file's `mcp`
//! object before merging servers, so only the last project file that has an `mcp` key declares servers.

use std::cmp::Ordering;
use std::collections::BTreeSet;

use rust_cli_base::js::json::{properties, stringify};
use rust_cli_ext::mcp::normalize_node_server;
use rust_cli_kernel_api::env::{EnvError, EnvPath, ReadFile, WorkspaceRef};
use rust_cli_kernel_api::env_files::{PathStyle, StatFile};
use rust_cli_kernel_api::machine::Files;
use rust_cli_paths::StoragePaths;
use rust_cli_platform::local::{ConfigFile, McpTrustLoad, McpTrustStore};
use serde_json::{Map, Value, json};

use super::files::ProjectFile;
use super::mcp_trust_display::display;

/// The fallback declaration file, relative to the working directory.
pub(crate) const FALLBACK_DIR: &str = ".agents";
pub(crate) const FALLBACK_FILE: &str = "mcp.json";

/// The workspace a trust decision is about (Node `workingDirectory` and `workspaceIdentity`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Target {
    pub(crate) working_directory: String,
    pub(crate) identity: String,
}

impl Target {
    /// Node `workspaceIdentity?.trim() || resolve(workingDirectory)`.
    pub(crate) fn new(working_directory: &str, identity: Option<&str>) -> Self {
        let working_directory = PathStyle::infer(working_directory).normalize(working_directory);
        let identity = identity
            .map(str::trim)
            .filter(|identity| !identity.is_empty())
            .map_or_else(|| working_directory.clone(), str::to_owned);
        Self {
            working_directory,
            identity,
        }
    }

    pub(crate) fn fallback_path(&self) -> String {
        PathStyle::infer(&self.working_directory)
            .join(&self.working_directory, &[FALLBACK_DIR, FALLBACK_FILE])
    }

    /// Node `digest(name, config, sourcePaths)`.
    fn digest(&self, name: &str, config: &Map<String, Value>, source_paths: &[String]) -> String {
        hash(&json!({
            "version": 1,
            "workspaceIdentity": self.identity,
            "workingDirectory": self.working_directory,
            "serverName": name,
            "sourcePaths": source_paths,
            "config": execution_config(config, &self.working_directory),
        }))
    }
}

/// One project-declared server.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Declaration {
    pub(crate) config: Map<String, Value>,
    pub(crate) source_paths: Vec<String>,
    pub(crate) digest: String,
}

impl Declaration {
    pub(crate) fn enabled(&self) -> bool {
        self.config.get("enabled") != Some(&Value::Bool(false))
    }
}

/// The declarations of a workspace, in Node's order, and every name the workspace claims (Node `requiredNames`:
/// a workspace name that failed validation must not be mistaken for a trusted user server).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Discovery {
    pub(crate) declarations: Vec<(String, Declaration)>,
    pub(crate) required: BTreeSet<String>,
}

impl Discovery {
    pub(crate) fn get(&self, name: &str) -> Option<&Declaration> {
        self.declarations
            .iter()
            .find_map(|(known, declaration)| (known == name).then_some(declaration))
    }
}

/// `<working directory>/.agents/mcp.json` as read.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Fallback {
    Missing,
    /// Unreadable or not JSON: Node's discovery throws.
    Invalid,
    Loaded(Value),
}

impl Fallback {
    pub(crate) fn parse(bytes: &[u8]) -> Self {
        serde_json::from_slice(bytes).map_or(Self::Invalid, Self::Loaded)
    }

    /// Node `readJson`: a file gone between the stat and the read (the App edits config while the agent runs) is
    /// missing; any other read error makes discovery throw.
    fn read(read: Result<&[u8], EnvError>) -> Self {
        match read {
            Ok(bytes) => Self::parse(bytes),
            Err(EnvError::NotFound { .. }) => Self::Missing,
            Err(_) => Self::Invalid,
        }
    }
}

/// What discovery reads.
pub(crate) struct Inputs<'a> {
    /// The user config (`~/.zcode/cli/config.json`); its servers shadow project servers by name.
    pub(crate) user: Option<&'a Map<String, Value>>,
    pub(crate) projects: &'a [ProjectFile],
    pub(crate) fallback: &'a Fallback,
}

/// The workspace config could not be read (Node `workspace_mcp_config_unreadable`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Unreadable;

/// Node `discover()`.
///
/// Node treats any project file that fails the whole-file schema as unreadable; Rust only knows files that are
/// not JSON objects and a non-object `mcp` (the rest of the schema is not ported).
pub(crate) fn discover(target: &Target, inputs: &Inputs<'_>) -> Result<Discovery, Unreadable> {
    let mut source_paths = Vec::new();
    let mut objects = Vec::new();
    for project in inputs.projects {
        match &project.file {
            ConfigFile::Loaded(object) => {
                source_paths.push(project.path.clone());
                objects.push((project, object));
            }
            ConfigFile::Invalid { .. } => return Err(Unreadable),
            ConfigFile::Missing => {}
        }
    }
    let user_names = user_server_names(inputs.user);
    let mut invalid_seen = false;
    let mut all_names = BTreeSet::new();
    let mut last: Option<Vec<(String, Map<String, Value>)>> = None;
    for (project, object) in &objects {
        let Some(mcp) = object.get("mcp") else {
            continue;
        };
        let mcp = mcp.as_object().ok_or(Unreadable)?;
        let servers = match mcp.get("servers") {
            None => Vec::new(),
            Some(Value::Object(entries)) => {
                let base = base_dir(&project.path);
                let mut valid = Vec::new();
                for (name, value) in properties(entries) {
                    match validate(value) {
                        Some(config) => {
                            all_names.insert(name.clone());
                            valid.push((name.clone(), project_cwd(config, &base)));
                        }
                        None => invalid_seen = true,
                    }
                }
                valid
            }
            Some(_) => {
                invalid_seen = true;
                Vec::new()
            }
        };
        last = Some(servers);
    }
    let mut discovery = Discovery::default();
    for (name, config) in last.unwrap_or_default() {
        if user_names.contains(&name) {
            continue;
        }
        let digest = target.digest(&name, &config, &source_paths);
        discovery.declarations.push((
            name,
            Declaration {
                config,
                source_paths: source_paths.clone(),
                digest,
            },
        ));
    }
    // The fallback applies when the project files name no valid server and none failed validation.
    if all_names.is_empty() && !invalid_seen {
        fallback(target, inputs.fallback, &user_names, &mut discovery)?;
    }
    let names: Vec<String> = discovery
        .declarations
        .iter()
        .map(|(name, _)| name.clone())
        .collect();
    discovery.required.extend(names);
    Ok(discovery)
}

fn fallback(
    target: &Target,
    file: &Fallback,
    user_names: &BTreeSet<String>,
    discovery: &mut Discovery,
) -> Result<(), Unreadable> {
    let raw = match file {
        Fallback::Missing => return Ok(()),
        Fallback::Invalid => return Err(Unreadable),
        Fallback::Loaded(raw) => raw.as_object().ok_or(Unreadable)?,
    };
    let entries = match raw.get("mcpServers") {
        None => return Ok(()),
        Some(entries) => entries.as_object().ok_or(Unreadable)?,
    };
    let source_paths = vec![target.fallback_path()];
    for (name, value) in properties(entries) {
        if user_names.contains(name) {
            continue;
        }
        discovery.required.insert(name.clone());
        let Some(config) = validate(value) else {
            continue;
        };
        let digest = target.digest(name, &config, &source_paths);
        discovery.declarations.push((
            name.clone(),
            Declaration {
                config,
                source_paths: source_paths.clone(),
                digest,
            },
        ));
    }
    Ok(())
}

/// Valid server names in the user config (Node `serverSources[name] === "user"`).
fn user_server_names(user: Option<&Map<String, Value>>) -> BTreeSet<String> {
    user.and_then(|user| user.get("mcp")?.get("servers")?.as_object())
        .map(|servers| {
            servers
                .iter()
                .filter(|(_, value)| validate(value).is_some())
                .map(|(name, _)| name.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Node `getProjectConfigBaseDir`: the file's directory, or its parent when that directory is `.zcode`.
pub(super) fn base_dir(path: &str) -> String {
    let style = PathStyle::infer(path);
    let dir = style.dirname(path);
    if style.file_name(&dir) == rust_cli_base::names::DOT_DIR {
        style.dirname(&dir)
    } else {
        dir
    }
}

/// Node `isAbsolute(cwd) ? cwd : resolve(base, cwd)`: an absolute path is kept byte for byte (the digest covers
/// it), a relative one is resolved and normalized.
pub(super) fn absolute_or_resolved(base: &str, cwd: &str) -> String {
    let style = PathStyle::infer(base);
    if style.is_absolute(cwd) {
        cwd.to_owned()
    } else {
        style.resolve(base, cwd, None)
    }
}

/// Node `normalizeProjectMcpServer`: a stdio server's `cwd` is resolved against the file's base directory
/// (default `.`).
fn project_cwd(mut config: Map<String, Value>, base: &str) -> Map<String, Value> {
    if config.get("type").and_then(Value::as_str) != Some("stdio") {
        return config;
    }
    let cwd = config.get("cwd").and_then(Value::as_str).unwrap_or(".");
    let resolved = absolute_or_resolved(base, cwd);
    config.insert("cwd".into(), Value::String(resolved));
    config
}

const BASE_KEYS: [&str; 6] = [
    "type",
    "alwaysLoad",
    "isolation",
    "protocolVersion",
    "enabled",
    "timeoutMs",
];
const STDIO_KEYS: [&str; 4] = ["command", "args", "cwd", "env"];
const REMOTE_KEYS: [&str; 3] = ["url", "headers", "oauth"];

fn non_empty(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.is_empty())
}

fn strings(value: &Value) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
}

fn string_record(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|fields| fields.values().all(Value::is_string))
}

/// Node `mcpOAuthSchema` (two strict variants).
fn oauth(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let optional_text = |key: &str| object.get(key).is_none_or(non_empty);
    let scope = object.get("scope").is_none_or(Value::is_string);
    match object.get("type").and_then(Value::as_str) {
        Some("client_credentials") => {
            let known = ["type", "clientId", "clientSecret", "clientName", "scope"];
            object.keys().all(|key| known.contains(&key.as_str()))
                && object.get("clientId").is_some_and(non_empty)
                && object.get("clientSecret").is_some_and(non_empty)
                && optional_text("clientName")
                && scope
        }
        Some("authorization_code") => {
            let known = [
                "type",
                "clientId",
                "clientSecret",
                "clientName",
                "redirectPath",
                "scope",
            ];
            object.keys().all(|key| known.contains(&key.as_str()))
                && ["clientId", "clientSecret", "clientName", "redirectPath"]
                    .iter()
                    .all(|key| optional_text(key))
                && scope
        }
        _ => false,
    }
}

/// Node `mcpServerSchema`: legacy names normalized, then one of three strict shapes. No defaults are added.
pub(crate) fn validate(value: &Value) -> Option<Map<String, Value>> {
    let server = normalize_node_server(value.as_object()?);
    let stdio = match server.get("type").and_then(Value::as_str)? {
        "stdio" => true,
        "http" | "sse" => false,
        _ => return None,
    };
    let own: &[&str] = if stdio { &STDIO_KEYS } else { &REMOTE_KEYS };
    for (key, value) in &server {
        let key = key.as_str();
        if !BASE_KEYS.contains(&key) && !own.contains(&key) {
            return None;
        }
        let valid = match key {
            "type" => true,
            "alwaysLoad" | "enabled" => value.is_boolean(),
            "isolation" => matches!(value.as_str(), Some("session" | "workspace")),
            "protocolVersion" => matches!(value.as_str(), Some("auto" | "legacy" | "2026-07-28")),
            "timeoutMs" => value
                .as_f64()
                .is_some_and(|millis| millis.is_finite() && millis > 0.0),
            "command" | "cwd" | "url" => non_empty(value),
            "args" => strings(value),
            "env" | "headers" => string_record(value),
            "oauth" => oauth(value),
            _ => false,
        };
        if !valid {
            return None;
        }
    }
    let required = if stdio { "command" } else { "url" };
    server.contains_key(required).then_some(server)
}

/// Node `normalizeMcpStdioCommand`: `cmd /c <command> …` is unwrapped on Windows only.
fn stdio_command(command: &str, args: &[Value]) -> (String, Vec<Value>) {
    let lower = command.to_lowercase();
    if cfg!(windows)
        && (lower == "cmd" || lower == "cmd.exe")
        && args.first().and_then(Value::as_str) == Some("/c")
        && let Some(inner) = args
            .get(1)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    {
        return (inner.to_owned(), args[2..].to_vec());
    }
    (command.to_owned(), args.to_vec())
}

/// Node `executionConfig`: what the digest covers.
fn execution_config(config: &Map<String, Value>, working_directory: &str) -> Value {
    let mut execution = config.clone();
    execution.remove("enabled");
    execution.remove("source");
    if config.get("type").and_then(Value::as_str) == Some("stdio") {
        let args = config
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let command = config.get("command").and_then(Value::as_str).unwrap_or("");
        let (command, args) = stdio_command(command, &args);
        execution.insert("command".into(), Value::String(command));
        execution.insert("args".into(), Value::Array(args));
        let env = config.get("env").cloned().unwrap_or_else(|| json!({}));
        execution.insert("env".into(), env);
        let cwd = match config.get("cwd").and_then(Value::as_str) {
            Some(cwd) if !cwd.is_empty() => absolute_or_resolved(working_directory, cwd),
            _ => working_directory.to_owned(),
        };
        execution.insert("cwd".into(), Value::String(cwd));
    } else {
        let headers = config.get("headers").cloned().unwrap_or_else(|| json!({}));
        execution.insert("headers".into(), headers);
    }
    Value::Object(execution)
}

/// JS `Array.prototype.sort()` on strings: UTF-16 code unit order.
fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// Objects rebuilt with sorted keys, as Node's `JSON.stringify` replacer does. Array-index keys still print
/// first (JS property order), which `stringify` reproduces.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort_by(|a, b| utf16_cmp(a, b));
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), sorted(&object[key])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// Node `hash`.
pub(crate) fn hash(value: &Value) -> String {
    rust_cli_base::hash::sha256_hex(stringify(&sorted(value)).as_bytes())
}

/// Node `WorkspaceMcpTrustReview`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Review {
    pub(crate) name: String,
    pub(crate) digest: String,
    pub(crate) configured_enabled: bool,
    pub(crate) transport: String,
    pub(crate) source_paths: Vec<String>,
    pub(crate) display: String,
    pub(crate) trusted: bool,
}

impl Review {
    pub(crate) fn to_value(&self) -> Value {
        json!({
            "declarationDigest": self.digest,
            "configuredEnabled": self.configured_enabled,
            "transport": self.transport,
            "sourcePaths": self.source_paths,
            "display": self.display,
            "trusted": self.trusted,
        })
    }
}

/// A declaration whose display cannot be built (a URL that does not parse): Node's `inspect()` throws from
/// `displayConfig`, so its callers fail instead of showing nothing to review.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Undisplayable;

/// Node `inspect()`: unreadable config means no reviews; a corrupt store shows every declaration untrusted.
pub(crate) fn reviews(
    target: &Target,
    discovery: Result<&Discovery, Unreadable>,
    store: &McpTrustLoad,
) -> Result<Vec<Review>, Undisplayable> {
    let Ok(discovery) = discovery else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for (name, declaration) in &discovery.declarations {
        let shown = display(&declaration.config, &target.working_directory).ok_or(Undisplayable)?;
        out.push(Review {
            name: name.clone(),
            digest: declaration.digest.clone(),
            configured_enabled: declaration.enabled(),
            transport: declaration
                .config
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            source_paths: declaration.source_paths.clone(),
            display: shown,
            trusted: store.trusts(&target.identity, name, &declaration.digest),
        });
    }
    Ok(out)
}

/// The reviews as Node's record (`Record<name, review>`).
#[cfg(test)]
pub(crate) fn reviews_value(reviews: &[Review]) -> Value {
    Value::Object(
        reviews
            .iter()
            .map(|review| (review.name.clone(), review.to_value()))
            .collect(),
    )
}

/// The session banner `workspaceMcpAdmission` (Node `refreshWorkspaceTrustAdmission`): enabled declarations
/// without a grant. Node orders names with `localeCompare`; Rust orders them case-insensitively first, which
/// agrees for ordinary server names. The digest only identifies the pending set.
pub(crate) fn admission(target: &Target, reviews: &[Review]) -> Value {
    let mut pending: Vec<(&str, &str)> = reviews
        .iter()
        .filter(|review| review.configured_enabled && !review.trusted)
        .map(|review| (review.name.as_str(), review.digest.as_str()))
        .collect();
    pending.sort_by(|(left, _), (right, _)| {
        left.to_lowercase()
            .cmp(&right.to_lowercase())
            .then_with(|| right.cmp(left))
    });
    let pairs: Vec<Value> = pending
        .iter()
        .map(|(name, digest)| json!([name, digest]))
        .collect();
    json!({
        "pendingCount": pending.len(),
        "bundleDigest": hash(&Value::Array(pairs)),
        "workspaceIdentity": target.identity,
    })
}

/// The project servers a session may connect (Node `allows` for workspace-sourced servers): enabled
/// declarations with a grant for their current digest. Every other project-scope server stays disconnected.
pub(crate) fn admitted(
    target: &Target,
    discovery: Result<&Discovery, Unreadable>,
    store: &McpTrustLoad,
) -> BTreeSet<String> {
    let Ok(discovery) = discovery else {
        return BTreeSet::new();
    };
    discovery
        .declarations
        .iter()
        .filter(|(name, declaration)| {
            declaration.enabled() && store.trusts(&target.identity, name, &declaration.digest)
        })
        .map(|(name, _)| name.clone())
        .collect()
}

/// Node `protocolMcpServersToRuntimeMcpConfig` for one `ZCodeProtocolMcpServer` (already schema-checked by the
/// inbound params): `scope` becomes `source.kind`, `env` / `headers` name-value lists become records.
pub(crate) fn dto_config(dto: &Value) -> Option<(String, Map<String, Value>)> {
    let object = dto.as_object()?;
    let name = object.get("name")?.as_str()?.to_owned();
    let pairs = |key: &str| -> Value {
        let mut record = Map::new();
        for pair in object
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let (Some(name), Some(value)) = (pair.get("name"), pair.get("value"))
                && let Some(name) = name.as_str()
            {
                record.insert(name.to_owned(), value.clone());
            }
        }
        Value::Object(record)
    };
    let mut config = Map::new();
    let copy = |config: &mut Map<String, Value>, key: &str| {
        if let Some(value) = object.get(key) {
            config.insert(key.to_owned(), value.clone());
        }
    };
    let stdio = object.contains_key("command");
    if stdio {
        config.insert("type".into(), json!("stdio"));
    } else {
        copy(&mut config, "type");
    }
    if let Some(scope) = object
        .get("scope")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        config.insert("source".into(), json!({"kind": scope}));
    }
    if stdio {
        if object
            .get("cwd")
            .and_then(Value::as_str)
            .is_some_and(|cwd| !cwd.is_empty())
        {
            copy(&mut config, "cwd");
        }
        copy(&mut config, "command");
        copy(&mut config, "args");
        config.insert("env".into(), pairs("env"));
    } else {
        copy(&mut config, "url");
        config.insert("headers".into(), pairs("headers"));
        copy(&mut config, "oauth");
    }
    for key in ["alwaysLoad", "timeoutMs", "isolation", "protocolVersion"] {
        copy(&mut config, key);
    }
    Some((name, config))
}

/// The source kind a configured server carries (`source.kind`).
pub(crate) fn source_kind(config: &Map<String, Value>) -> Option<&str> {
    config.get("source")?.get("kind")?.as_str()
}

/// Node `allows(name, config)`: user, plugin and builtin servers pass; a workspace or source-less server needs an
/// enabled declaration whose digest equals the digest of the config being connected, and a grant for it. A
/// source-less name the workspace does not claim passes.
pub(crate) fn allows(
    target: &Target,
    discovery: Result<&Discovery, Unreadable>,
    store: &McpTrustLoad,
    name: &str,
    config: &Map<String, Value>,
) -> bool {
    let kind = source_kind(config);
    if matches!(kind, Some("user" | "plugin" | "builtin")) {
        return true;
    }
    let Ok(discovery) = discovery else {
        return false;
    };
    let Some(declaration) = discovery.get(name) else {
        return kind != Some("workspace") && !discovery.required.contains(name);
    };
    declaration.enabled()
        && target.digest(name, config, &declaration.source_paths) == declaration.digest
        && store.trusts(&target.identity, name, &declaration.digest)
}

/// One read of a workspace's MCP trust state: its declarations and the shared store, read fresh on each call
/// (the App edits config and the store while the agent runs).
pub(crate) struct Inspection {
    pub(crate) target: Target,
    pub(crate) discovery: Result<Discovery, Unreadable>,
    pub(crate) store: McpTrustStore,
    pub(crate) load: McpTrustLoad,
}

impl Inspection {
    /// `workspace` is the ref the project files were read through; the fallback is read through it too.
    pub(crate) async fn read(
        files: &dyn Files,
        workspace: &WorkspaceRef,
        target: Target,
        (user, projects): (Option<&Map<String, Value>>, &[ProjectFile]),
        paths: &StoragePaths,
    ) -> Self {
        let fallback = read_fallback(files, workspace, &target.fallback_path()).await;
        let discovery = discover(
            &target,
            &Inputs {
                user,
                projects,
                fallback: &fallback,
            },
        );
        let store = McpTrustStore::beside(&paths.hook_trust_store(super::trust::storage_dir(user)));
        let load = store.load().await;
        Self {
            target,
            discovery,
            store,
            load,
        }
    }

    pub(crate) fn discovery(&self) -> Result<&Discovery, Unreadable> {
        self.discovery.as_ref().map_err(|unreadable| *unreadable)
    }

    pub(crate) fn reviews(&self) -> Result<Vec<Review>, Undisplayable> {
        reviews(&self.target, self.discovery(), &self.load)
    }

    pub(crate) fn admitted(&self) -> BTreeSet<String> {
        admitted(&self.target, self.discovery(), &self.load)
    }

    /// Declarations with a grant for their current digest, enabled or not (a disabled one may be enabled later
    /// from `/mcp`, which must not connect an unreviewed declaration).
    pub(crate) fn granted(&self) -> BTreeSet<String> {
        let Ok(discovery) = self.discovery() else {
            return BTreeSet::new();
        };
        discovery
            .declarations
            .iter()
            .filter(|(name, declaration)| {
                self.load
                    .trusts(&self.target.identity, name, &declaration.digest)
            })
            .map(|(name, _)| name.clone())
            .collect()
    }

    pub(crate) fn allows(&self, name: &str, config: &Map<String, Value>) -> bool {
        allows(&self.target, self.discovery(), &self.load, name, config)
    }
}

/// `<wd>/.agents/mcp.json`: missing, not JSON, or a JSON value.
async fn read_fallback(files: &dyn Files, workspace: &WorkspaceRef, path: &str) -> Fallback {
    let stat = StatFile {
        path: EnvPath::new(path),
    };
    if !matches!(files.stat(workspace, stat).await, Ok(Some(_))) {
        return Fallback::Missing;
    }
    let read = ReadFile {
        path: EnvPath::new(path),
    };
    match files.read_file(workspace, read).await {
        Ok(content) => Fallback::read(Ok(&content.bytes)),
        Err(error) => Fallback::read(Err(error)),
    }
}

#[cfg(test)]
#[path = "mcp_trust_tests.rs"]
mod tests;
