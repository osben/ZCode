//! 插件的来源与启用判定（docs/specs/rust-cli/ext.md §4.1、§4.3、§4.4）。
//!
//! 入口层给出候选目录（配置 `plugins.dirs`、官方内置插件的缓存、已安装插件，按 Node `resolveCandidates`
//! 的顺序）与合并后的 `enabledPlugins`、`suppressedBuiltins`。这里读 manifest 得到插件 id，逐条判定，加载
//! 启用的插件。`--plugin-dir` 的插件（会话插件）排在最前，总是启用，并盖过同名的插件。

use std::collections::{BTreeMap, HashSet};

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::env_files::FileKind;
use rust_cli_kernel_api::ids::MachineName;
use rust_cli_kernel_api::machine::Files;
use rust_cli_kernel_api::mcp::McpTransportConfig;
use serde_json::Value;

use super::{Manifest, Plugin, Plugins, Reader};

/// Node `ZCODE_OFFICIAL_PLUGIN_MARKETPLACE`（定义在 base，F55）。
const OFFICIAL: &str = rust_cli_base::names::OFFICIAL_MARKETPLACE;
/// Node `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`（`official-plugin-definitions.ts` 里标了 `defaultEnabled`
/// 的插件，与 `packages/shared/src/plugin-marketplaces.ts` 一致），都在官方市场。
const DEFAULT_ENABLED: [&str; 12] = [
    "browser-use",
    "image-search",
    "documents",
    "pdf",
    "presentations",
    "spreadsheets",
    "node-repl-host",
    "skill-creator",
    "plugin-creator",
    // Fork: declares only a language server (specs/fork-rust-lsp.md).
    "typescript-lsp",
    "zcode-guide",
    "visualize",
];
/// 能力来自 Node 宿主注入的 `node_repl` MCP 的官方插件（Node `hostMcpServerNames` 与宿主本身）。
const NODE_REPL: [&str; 3] = ["node-repl-host", "browser-use", "computer-use"];
/// Node `ZCODE_PLUGIN_HOST_COMMAND`：播种缓存时改写进 MCP 的启动参数。
const PLUGIN_HOST_ARG: &str = "__zcode-plugin-host";
/// 需要 App 内联视图宿主的官方插件（Node `filterVisualizeSkillRoots`）。
const VIEW_HOST: &str = "visualize";

/// 候选目录的来源（Node `PluginSource`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginOrigin {
    /// 配置 `plugins.dirs`（Node 的 `inline`），缺省启用。
    ConfigDir,
    /// 官方内置插件的缓存（Node 的 `official`），`suppressedBuiltins` 只对它生效。
    Official,
    /// `installed_plugins.json` 里的插件（Node 的 `cache`）。
    Installed,
}

/// 入口层给出的一个候选目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginCandidate {
    pub dir: EnvPath,
    /// 插件 id 的后半（`inline`、`zcode-plugins-official` 或记录里的 marketplace）。
    pub marketplace: String,
    pub origin: PluginOrigin,
}

/// 入口层组装的插件来源（配置快照的一部分，config.md §2.1）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PluginSources {
    /// 按 Node 的顺序：配置目录、官方内置缓存、已安装插件。`plugins.enabled` 为 false 时为空。
    pub candidates: Vec<PluginCandidate>,
    /// 合并后的 `plugins.enabledPlugins`（插件 id → 是否启用）。
    pub enabled_plugins: BTreeMap<String, bool>,
    /// 合并后的 `plugins.suppressedBuiltins`。
    pub suppressed_builtins: Vec<String>,
    /// Fork: the App's inline view host is there (the app-server started with `--surface desktop`), so `visualize`
    /// loads, like Node's protocol entry (`filterVisualizeSkillRoots(roots, true)`). False everywhere else.
    pub view_host: bool,
    /// Fork: the Host configured a Node helper (specs/fork-rust-node-helper.md F3). The PluginHost official plugins then
    /// load, and the MCP servers of helper-hosted plugins are served by the helper ([`McpTransportConfig::NodeHelper`]).
    pub node_helper: bool,
}

/// 官方插件依赖的 Node 运行时或宿主（ext.md §4.4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeDependency {
    /// 能力来自 Node 宿主注入的 `node_repl` MCP。
    NodeRepl,
    /// MCP 经 Node CLI 自身的插件宿主模式启动。
    PluginHost,
    /// MCP 要 Node 注入的官方鉴权。
    OfficialAuth,
    /// 要 App 的内联视图宿主（终端没有）。
    ViewHost,
}

impl NodeDependency {
    fn describe(self) -> &'static str {
        match self {
            Self::NodeRepl => "it relies on the node_repl MCP server injected by the Node host",
            Self::PluginHost => "its MCP server runs in the Node CLI plugin host",
            Self::OfficialAuth => {
                "its MCP server needs the official auth injected by the Node host"
            }
            Self::ViewHost => "there is no inline view host (only the desktop surface has one)",
        }
    }
}

/// 候选目录没有加载的原因（ext.md §4.3）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    RootMissing,
    ManifestMissing,
    ManifestInvalid(String),
    /// 在 `suppressedBuiltins` 里的内置插件。
    Suppressed,
    /// 同一个 id 已经出现过（先到先得）。
    DuplicateId,
    Disabled,
    /// 与 `--plugin-dir` 的插件同名。
    ShadowedBySession,
    /// 与已经加载的插件同名（marketplace 不同，ext.md D22）。
    DuplicateName,
    NodeRuntime(NodeDependency),
}

impl SkipReason {
    fn describe(&self) -> String {
        match self {
            Self::RootMissing => "the plugin root does not exist".to_owned(),
            Self::ManifestMissing => "the plugin manifest was not found".to_owned(),
            Self::ManifestInvalid(error) => format!("the plugin manifest is invalid: {error}"),
            Self::Suppressed => "the built-in plugin is suppressed".to_owned(),
            Self::DuplicateId => "duplicate plugin ignored".to_owned(),
            Self::Disabled => "the plugin is not enabled".to_owned(),
            Self::ShadowedBySession => "a --plugin-dir plugin has the same name".to_owned(),
            Self::DuplicateName => "a loaded plugin has the same name".to_owned(),
            Self::NodeRuntime(dependency) => dependency.describe().to_owned(),
        }
    }
}

/// 一个没有加载的候选目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skipped {
    pub dir: String,
    /// manifest 读出之后才有。
    pub id: Option<String>,
    pub reason: SkipReason,
}

/// 加载结果：加载好的插件与跳过的候选目录。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Loaded {
    pub plugins: Plugins,
    pub skipped: Vec<Skipped>,
}

/// 插件名最多这么多个字节。
const MAX_NAME_LEN: usize = 128;

/// Node `PLUGIN_NAME_PATTERN`：`^[a-z0-9][a-z0-9._-]{0,127}$`。
fn valid_name(name: &str) -> bool {
    let lower_or_digit = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let mut chars = name.chars();
    chars.next().is_some_and(lower_or_digit)
        && name.len() <= MAX_NAME_LEN
        && chars.all(|c| lower_or_digit(c) || matches!(c, '.' | '_' | '-'))
}

/// Node `readManifest` 的名字规则与报错文字。
fn manifest_name(manifest: &Value) -> Result<String, String> {
    let Some(object) = manifest.as_object() else {
        return Err("Manifest must be a JSON object".to_owned());
    };
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if valid_name(name) {
        Ok(name.to_owned())
    } else {
        Err(format!("Invalid plugin name: {name}"))
    }
}

/// 官方插件依赖 Node 运行时或宿主的判定（ext.md §4.4）；`tables` 是 MCP 服务器声明。
fn node_dependency(
    name: &str,
    marketplace: &str,
    tables: &[Value],
    view_host: bool,
) -> Option<NodeDependency> {
    if marketplace != OFFICIAL {
        return None;
    }
    if NODE_REPL.contains(&name) {
        return Some(NodeDependency::NodeRepl);
    }
    let servers = tables
        .iter()
        .filter_map(Value::as_object)
        .flat_map(|table| table.values());
    for server in servers {
        let args = server.get("args").and_then(Value::as_array);
        if args
            .into_iter()
            .flatten()
            .any(|arg| arg.as_str() == Some(PLUGIN_HOST_ARG))
        {
            return Some(NodeDependency::PluginHost);
        }
        if server.get("auth").is_some() {
            return Some(NodeDependency::OfficialAuth);
        }
    }
    (name == VIEW_HOST && !view_host).then_some(NodeDependency::ViewHost)
}

/// 判定过程中的状态：会话插件的名字、已出现的 id。
struct Admission<'a> {
    reader: Reader<'a>,
    sources: &'a PluginSources,
    session: HashSet<String>,
    seen: HashSet<String>,
}

impl Admission<'_> {
    /// 一个候选目录：加载好的插件，或跳过的原因（ext.md §4.3 的十步）。
    async fn admit(
        &mut self,
        candidate: &PluginCandidate,
        loaded: &[Plugin],
    ) -> Result<Plugin, Skipped> {
        let dir = candidate.dir.as_str();
        let skip = |id: Option<&str>, reason| Skipped {
            dir: dir.to_owned(),
            id: id.map(str::to_owned),
            reason,
        };
        if self.reader.kind(dir).await != Some(FileKind::Directory) {
            return Err(skip(None, SkipReason::RootMissing));
        }
        let manifest = match self.reader.manifest(dir).await {
            Manifest::Found(value) => value,
            Manifest::Missing => return Err(skip(None, SkipReason::ManifestMissing)),
            Manifest::Invalid(error) => return Err(skip(None, SkipReason::ManifestInvalid(error))),
        };
        let name = manifest_name(&manifest)
            .map_err(|error| skip(None, SkipReason::ManifestInvalid(error)))?;
        let id = format!("{name}@{}", candidate.marketplace);
        let reject = |reason| Err(skip(Some(&id), reason));
        if candidate.origin == PluginOrigin::Official
            && self.sources.suppressed_builtins.contains(&id)
        {
            return reject(SkipReason::Suppressed);
        }
        if !self.seen.insert(id.clone()) {
            return reject(SkipReason::DuplicateId);
        }
        let default = candidate.origin == PluginOrigin::ConfigDir
            || (candidate.marketplace == OFFICIAL && DEFAULT_ENABLED.contains(&name.as_str()));
        let enabled = self.sources.enabled_plugins.get(&id).copied();
        if !enabled.unwrap_or(default) {
            return reject(SkipReason::Disabled);
        }
        if self.session.contains(&name) {
            return reject(SkipReason::ShadowedBySession);
        }
        let clash = loaded
            .iter()
            .any(|plugin| plugin.name == name && takes_name(plugin));
        // An official candidate may turn out to claim no name (see `takes_name`); that needs its components.
        if clash && candidate.marketplace != OFFICIAL {
            return reject(SkipReason::DuplicateName);
        }
        let tables = self.reader.mcp_tables(dir, &manifest).await;
        let dependency = match node_dependency(
            &name,
            &candidate.marketplace,
            &tables,
            self.sources.view_host,
        ) {
            // With a helper the plugin host is served, so what keeps the plugin out is its auth server.
            Some(NodeDependency::PluginHost)
                if self.sources.node_helper && needs_official_auth(&tables) =>
            {
                Some(NodeDependency::OfficialAuth)
            }
            other => other,
        };
        // One of the two helper-hosting triggers (F3); the other, an MCP App entry point, is in `load_all`.
        let served = dependency == Some(NodeDependency::PluginHost) && self.sources.node_helper;
        if let Some(dependency) = dependency.filter(|_| !served) {
            return reject(SkipReason::NodeRuntime(dependency));
        }
        let plugin = self
            .reader
            .components(dir, id.clone(), name, manifest, &tables)
            .await;
        if clash && takes_name(&plugin) {
            return reject(SkipReason::DuplicateName);
        }
        Ok(if served {
            helper_hosted(plugin)
        } else {
            plugin
        })
    }
}

/// A server of the official auth kind keeps a PluginHost plugin skipped even with a helper (F3: OfficialAuth stays
/// skipped).
fn needs_official_auth(tables: &[Value]) -> bool {
    tables
        .iter()
        .filter_map(Value::as_object)
        .flat_map(|table| table.values())
        .any(|server| server.get("auth").is_some())
}

/// Whether the manifest declares an MCP App entry point (F3): a non-empty `ui.surfaces`, or a `composer.mention` slot
/// entry with a `target.tool`. The panel and the model must then reach the same server instance, which only the
/// helper's Node MCP pool provides.
fn declares_mcp_app(manifest: &Value) -> bool {
    let surfaces = manifest
        .pointer("/ui/surfaces")
        .and_then(Value::as_array)
        .is_some_and(|surfaces| !surfaces.is_empty());
    let mention = manifest
        .get("slots")
        .and_then(|slots| slots.get("composer.mention"))
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry
                    .pointer("/target/tool")
                    .and_then(Value::as_str)
                    .is_some()
            })
        });
    surfaces || mention
}

/// Every MCP server of the plugin is served by the helper, on the main env: Node resolves a mention tool over all
/// servers of the plugin, and a panel may call any of them.
fn helper_hosted(mut plugin: Plugin) -> Plugin {
    for server in &mut plugin.mcp_servers {
        server.transport = McpTransportConfig::NodeHelper;
        server.machine = MachineName::primary();
    }
    plugin
}

/// Whether a loaded plugin keeps a later plugin of the same name out. Fork (specs/fork-rust-lsp.md): an official plugin
/// with no skill, MCP server, agent or hook (the default-enabled `typescript-lsp` declares only a language server)
/// claims no name-keyed namespace, so it neither keeps out nor is kept out by a plugin of the same name; Node dedupes
/// by full id only, so both load there too.
fn takes_name(plugin: &Plugin) -> bool {
    let official = plugin
        .id
        .strip_suffix(OFFICIAL)
        .is_some_and(|rest| rest.ends_with('@'));
    let empty = plugin.skill_dirs.is_empty()
        && plugin.mcp_servers.is_empty()
        && plugin.agent_files.is_empty()
        && plugin.hooks.is_empty();
    !(official && empty)
}

fn log(skipped: &Skipped) {
    let (dir, id, reason) = (
        skipped.dir.as_str(),
        skipped.id.as_deref().unwrap_or(""),
        skipped.reason.describe(),
    );
    match skipped.reason {
        SkipReason::Disabled | SkipReason::Suppressed | SkipReason::ShadowedBySession => {
            tracing::debug!(dir, id, reason, "plugin skipped");
        }
        SkipReason::NodeRuntime(_) => tracing::info!(dir, id, reason, "plugin skipped"),
        _ => tracing::warn!(dir, id, reason, "plugin skipped"),
    }
}

/// 加载 `--plugin-dir` 的插件与入口层给出的候选目录（ext.md §4.3）；跳过的候选目录记日志并一起返回。
pub async fn load_all(
    files: &dyn Files,
    workspace: &WorkspaceRef,
    session_dirs: &[EnvPath],
    sources: &PluginSources,
) -> Loaded {
    let reader = Reader { files, workspace };
    let mut plugins = Vec::new();
    for dir in session_dirs {
        plugins.extend(reader.session_plugin(dir.as_str()).await);
    }
    let mut admission = Admission {
        reader,
        sources,
        session: plugins.iter().map(|plugin| plugin.name.clone()).collect(),
        seen: HashSet::new(),
    };
    let mut skipped = Vec::new();
    for candidate in &sources.candidates {
        match admission.admit(candidate, &plugins).await {
            Ok(plugin) => plugins.push(plugin),
            Err(skip) => {
                log(&skip);
                skipped.push(skip);
            }
        }
    }
    // The other helper-hosting trigger (F3): an MCP App entry point, for every loaded plugin, session ones included
    // (they bypass `admit`). A plugin `admit` skipped for a Node dependency (official auth among them) never gets here.
    if sources.node_helper {
        plugins = plugins
            .into_iter()
            .map(|plugin| {
                if declares_mcp_app(&plugin.manifest) {
                    helper_hosted(plugin)
                } else {
                    plugin
                }
            })
            .collect();
    }
    Loaded {
        plugins: Plugins(plugins),
        skipped,
    }
}

#[cfg(test)]
#[path = "select_tests.rs"]
mod tests;
