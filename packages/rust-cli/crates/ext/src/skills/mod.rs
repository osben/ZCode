//! skill（docs/specs/rust-cli/ext.md §2）：发现、frontmatter、清单、Skill 工具。
//!
//! 文件经执行环境端口读；解析结果按 SKILL.md 的路径与 `FileVersion` 缓存，每一步重新列目录、
//! `stat` 每个 SKILL.md，版本变了才重读（相当于文件监视 + memoize）。

mod args;
mod body;
mod builtin;
mod bundled;
mod closest;
mod grants;
mod inline;
mod invoked;
mod listing;
mod load;
mod mentions;
mod names;
mod paths;
mod tool;
mod unknown;
mod user;

use rust_cli_base::sync::LockUnpoisoned;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rust_cli_kernel_api::env::{EnvFacts, FileVersion, WorkspaceRef};
use rust_cli_kernel_api::listing::ListingEntry;
use rust_cli_kernel_api::machine::{EnvInfo, Files};
use rust_cli_kernel_api::message::Message;

pub use bundled::{DYNAMIC_WORKFLOW_SKILL, helper_entry_dir, pack_skills_dir};
pub use invoked::INVOKED_SKILLS_SOURCE;
pub use tool::{SKILL_MESSAGE_SOURCE, SkillTool};
pub use user::SkillCommands;

/// `!` 命令的执行者：注册表里的 Bash 工具、判决链与 ID（ext.md §2.5）。
pub(crate) fn runner(
    bash: Arc<dyn rust_cli_kernel_api::tool::Tool>,
    gate: Arc<dyn rust_cli_kernel_api::orchestration::ScopedGate>,
    ids: Arc<dyn rust_cli_kernel_api::clock::Ids>,
) -> inline::Runner {
    inline::Runner { bash, gate, ids }
}

/// skill 从哪里来（`source`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillSource {
    Managed,
    User,
    Project,
    Plugin {
        plugin: String,
    },
    /// 内置（bundled）：只有 `/loop`（tools-more.md §17.1）。
    Builtin,
    /// Fork (W9b-3, 9.58): the bundled skill pack (Node `resolveBundledSkillRoots`, source `bundled`).
    Bundled,
}

/// `!` 命令用的 shell（frontmatter `shell`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SkillShell {
    #[default]
    Bash,
    PowerShell,
}

/// 一个 skill（解析结果里本工程用到的部分）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    /// 调用名：目录名；插件 skill 为 `<插件名>:<目录名>`。
    pub name: String,
    /// frontmatter 的 `name`（面向用户的名字）。
    pub display: Option<String>,
    pub description: String,
    pub when_to_use: Option<String>,
    pub argument_hint: Option<String>,
    pub arg_names: Vec<String>,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub disable_model_invocation: bool,
    pub user_invocable: bool,
    pub paths: Option<Vec<String>>,
    pub shell: SkillShell,
    pub has_hooks: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fork: bool,
    pub agent: Option<String>,
    /// skill 目录（执行环境里的路径）。
    pub dir: String,
    /// frontmatter 之后的正文，原样。
    pub body: String,
    pub source: SkillSource,
}

impl Skill {
    /// 只有安全字段：没有 `allowed-tools`、`disallowed-tools`、`hooks`。这样的 skill
    /// 不经询问即可调用（ext.md §2.4）。
    pub fn is_safe(&self) -> bool {
        // 内置的 `/loop` 不算安全：bundled skill 带 `argsMayContainSlashCommands` 等不在安全名单里的
        // 字段，所以要询问，dontAsk 下拒绝。
        self.source != SkillSource::Builtin
            && self.allowed_tools.is_empty()
            && self.disallowed_tools.is_empty()
            && !self.has_hooks
    }
}

/// 插件提供的 skill 根目录（ext.md §4）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginSkillRoot {
    pub plugin: String,
    /// `<插件>/skills` 一类的目录。
    pub dir: String,
    /// Fork: the root belongs to the official Computer Use plugin (id `computer-use@zcode-plugins-official`). Its skills
    /// never reach a subagent child (Node `OfficialCuaPolicy.isOfficialSkill`).
    pub official_cua: bool,
}

#[derive(Default)]
struct Cache {
    /// SKILL.md 路径 → 解析时的版本与结果。
    parsed: HashMap<String, (FileVersion, Arc<Skill>)>,
}

/// skill 目录的发现与缓存。
pub struct SkillCatalog {
    /// 环境事实（skill 目录的层级、路径风格）与 skill 文件；都是本机的。
    info: Arc<dyn EnvInfo>,
    files: Arc<dyn Files>,
    plugins: Mutex<Vec<PluginSkillRoot>>,
    /// Fork (specs/fork-rust-workspace-plugins-mcp.md): the per-workspace layer; a workspace
    /// with a loaded slot replaces the process plugin roots.
    layer: std::sync::OnceLock<Arc<crate::workspace_layer::WorkspaceLayer>>,
    cache: Mutex<Cache>,
    /// 单次的 `-p`（`singleShotPrintSession`）：内置 `/loop` 的 Monitor 超时随它（tools-more.md §17.1）。
    print: AtomicBool,
    /// Fork: whether the builtin `/loop` is offered (not under the desktop Host's automations).
    looping: bool,
    /// Fork: the sessions' incognito profiles; a session without plugins discovers no plugin skills.
    incognito: std::sync::OnceLock<rust_cli_kernel_api::incognito::IncognitoProfiles>,
    /// Fork (rule 17): each running subagent child, by child session. The value is its grant (frozen identities); `None`
    /// is a child that declares no `skills` list. Every child hides the official Computer Use skills.
    grants: Mutex<HashMap<rust_cli_kernel_api::ids::SessionId, Option<HashSet<String>>>>,
    /// Fork (W9b-3, 9.58): the directory of the Node bundle entry the bundled pack is searched from (`bundled.rs`).
    bundled_entry: Mutex<Option<String>>,
    /// Fork (W9b-3, 9.58): the resolved pack directory, memoized once resolved: outer None = not resolved yet, inner None =
    /// no pack (found or not, the search runs once per entry; the warning is logged with it).
    bundled_resolved: Mutex<Option<Option<String>>>,
    /// Fork (W9b-3, 9.58): the rollout gate per session (Node `runtimeConfig.dynamicWorkflowEnabled`).
    gates: Mutex<Option<Arc<dyn rust_cli_kernel_api::dynamic_workflow::DynamicWorkflowGates>>>,
}

impl SkillCatalog {
    pub fn new(info: Arc<dyn EnvInfo>, files: Arc<dyn Files>) -> Self {
        Self {
            info,
            files,
            plugins: Mutex::default(),
            layer: std::sync::OnceLock::new(),
            cache: Mutex::default(),
            print: AtomicBool::new(false),
            looping: true,
            incognito: std::sync::OnceLock::new(),
            grants: Mutex::default(),
            bundled_entry: Mutex::default(),
            bundled_resolved: Mutex::default(),
            gates: Mutex::default(),
        }
    }

    /// Fork (W9b-3, 9.58): the directory of the Node bundle entry (`bundled::helper_entry_dir`); None leaves the pack out.
    pub fn set_bundled_entry_dir(&self, entry_dir: Option<String>) {
        *self.bundled_entry.lock_unpoisoned() = entry_dir;
        *self.bundled_resolved.lock_unpoisoned() = None;
    }

    /// Fork (W9b-3, 9.58): the rollout gate source the session gates are read from (Node `runtimeConfig`).
    pub fn set_dynamic_workflow_gates(
        &self,
        gates: Arc<dyn rust_cli_kernel_api::dynamic_workflow::DynamicWorkflowGates>,
    ) {
        *self.gates.lock_unpoisoned() = Some(gates);
    }

    /// Fork (W9b-3, 9.58): the bundled pack's `skills` directory as Node finds it from the entry, or None. Resolved once
    /// per entry and memoized (found or not). With no entry (no Node helper command, divergence 903) or no pack, one
    /// warning is logged, when the memo is filled.
    async fn bundled_skills_dir(&self, workspace: &WorkspaceRef) -> Option<String> {
        if let Some(resolved) = self.bundled_resolved.lock_unpoisoned().clone() {
            return resolved;
        }
        let entry = self.bundled_entry.lock_unpoisoned().clone();
        let dir = match &entry {
            Some(entry) => bundled::pack_skills_dir(self.files.as_ref(), workspace, entry).await,
            None => None,
        };
        match (&entry, &dir) {
            (_, Some(dir)) => tracing::debug!(dir = %dir, "bundled skill pack found"),
            (None, None) => tracing::warn!("bundled skill pack unavailable: no Node bundle entry"),
            (Some(entry), None) => {
                tracing::warn!(entry = %entry, "bundled skill pack unavailable");
            }
        }
        *self.bundled_resolved.lock_unpoisoned() = Some(dir.clone());
        dir
    }

    /// Fork (W9b-3, 9.58): Node's `dynamicWorkflowEnabled === false` for this session withholds the dynamic-workflows
    /// skill. A session with no recorded gate, or no session (the draft catalog), is not withheld.
    fn dynamic_workflows_gated(
        &self,
        session: Option<&rust_cli_kernel_api::ids::SessionId>,
    ) -> bool {
        let (Some(session), Some(gates)) = (session, self.gates.lock_unpoisoned().clone()) else {
            return false;
        };
        gates.gate(session).is_some_and(|gate| !gate.enabled)
    }

    /// Fork: set once by [`crate::Ext::new`].
    pub(crate) fn set_incognito(
        &self,
        profiles: rust_cli_kernel_api::incognito::IncognitoProfiles,
    ) {
        let _ = self.incognito.set(profiles);
    }

    /// Fork: whether `session` keeps the plugin skills (no session: every skill).
    fn keeps_plugins(&self, session: Option<&rust_cli_kernel_api::ids::SessionId>) -> bool {
        let excluded = session
            .zip(self.incognito.get())
            .is_some_and(|(session, profiles)| {
                profiles.excludes(
                    session,
                    rust_cli_kernel_api::incognito::IncognitoKey::Plugins,
                )
            });
        !excluded
    }

    /// Fork: offer the builtin `/loop` or not ([`crate::ExtConfig::host_automations`]).
    pub fn with_loop(mut self, looping: bool) -> Self {
        self.looping = looping;
        self
    }

    /// 内核按形态设置：`-p` 是单次的打印会话。
    pub fn set_print_session(&self, print: bool) {
        self.print.store(print, Ordering::Relaxed);
    }

    pub(crate) fn print_session(&self) -> bool {
        self.print.load(Ordering::Relaxed)
    }

    /// 换上插件的 skill 根目录（插件加载完成后，ext.md §4）。
    pub fn set_plugin_roots(&self, roots: Vec<PluginSkillRoot>) {
        *self.plugins.lock_unpoisoned() = roots;
    }

    fn plugin_roots(&self) -> Vec<PluginSkillRoot> {
        self.plugins.lock_unpoisoned().clone()
    }

    /// Fork: the roots of the session's workspace when its layer is loaded (its own plugin set,
    /// re-selected with the workspace's enablement overlay).
    pub fn set_workspace_layer(&self, layer: Arc<crate::workspace_layer::WorkspaceLayer>) {
        let _ = self.layer.set(layer);
    }

    fn workspace_roots(&self, workspace: &WorkspaceRef) -> Option<Vec<PluginSkillRoot>> {
        let layer = self.layer.get()?;
        layer
            .plugins_of(workspace)
            .map(|plugins| plugins.skill_roots())
    }

    pub(crate) fn cached(&self, path: &str, version: &FileVersion) -> Option<Arc<Skill>> {
        let cache = self.cache.lock_unpoisoned();
        cache
            .parsed
            .get(path)
            .filter(|(known, _)| known == version)
            .map(|(_, skill)| skill.clone())
    }

    pub(crate) fn remember(&self, path: String, version: FileVersion, skill: Arc<Skill>) {
        let mut cache = self.cache.lock_unpoisoned();
        cache.parsed.insert(path, (version, skill));
    }

    /// 这一步发现的全部 skill，按优先级排好、同名只留第一个（ext.md §2.1）。
    pub async fn skills(&self, workspace: &WorkspaceRef) -> Vec<Arc<Skill>> {
        self.skills_in(workspace, None).await
    }

    /// Fork: [`Self::skills`] as `session` sees them (incognito without plugins: no plugin skills).
    pub async fn skills_in(
        &self,
        workspace: &WorkspaceRef,
        session: Option<&rust_cli_kernel_api::ids::SessionId>,
    ) -> Vec<Arc<Skill>> {
        let skills = self.discovered(workspace, session).await;
        self.granted(workspace, session, skills)
    }

    /// Fork (rule 17): the skills discovered for `session` before its grant filter. A grant resolves against this set,
    /// so a re-grant can discover without the child's old grant applying, or the new one.
    async fn discovered(
        &self,
        workspace: &WorkspaceRef,
        session: Option<&rust_cli_kernel_api::ids::SessionId>,
    ) -> Vec<Arc<Skill>> {
        let facts = match self.info.facts(workspace).await {
            Ok(facts) => facts,
            Err(error) => {
                tracing::debug!(%error, "skills are not available without environment facts");
                return Vec::new();
            }
        };
        self.skills_with(workspace, &facts, self.keeps_plugins(session), session)
            .await
    }

    /// Fork (rule 17): `skills` as the child run of `session` sees them. A child never sees the official Computer Use
    /// skills (Node `FilteredSkillPort`: the CUA filter runs first, the grant filters what is left); with a grant it sees
    /// only the granted identities.
    fn granted(
        &self,
        workspace: &WorkspaceRef,
        session: Option<&rust_cli_kernel_api::ids::SessionId>,
        skills: Vec<Arc<Skill>>,
    ) -> Vec<Arc<Skill>> {
        let Some(session) = session else {
            return skills;
        };
        let Some(grant) = self.grants.lock_unpoisoned().get(session).cloned() else {
            return skills;
        };
        let official = self.official_dirs(workspace);
        let skills: Vec<Arc<Skill>> = skills
            .into_iter()
            .filter(|skill| !is_official(skill, &official))
            .collect();
        match grant {
            Some(identities) => grants::filter_granted(&skills, &identities),
            None => skills,
        }
    }

    /// Fork: the official Computer Use plugin's skill roots, as `(plugin name, root directory)` (the roots of the
    /// workspace's own plugin set when its layer is loaded, like discovery).
    fn official_dirs(&self, workspace: &WorkspaceRef) -> Vec<(String, String)> {
        self.workspace_roots(workspace)
            .unwrap_or_else(|| self.plugin_roots())
            .into_iter()
            .filter(|root| root.official_cua)
            .map(|root| (root.plugin, root.dir))
            .collect()
    }

    async fn skills_with(
        &self,
        workspace: &WorkspaceRef,
        facts: &EnvFacts,
        plugins: bool,
        session: Option<&rust_cli_kernel_api::ids::SessionId>,
    ) -> Vec<Arc<Skill>> {
        let roots = if plugins {
            self.workspace_roots(workspace)
                .unwrap_or_else(|| self.plugin_roots())
        } else {
            Vec::new()
        };
        let mut found = load::discover(self, workspace, facts, &roots).await;
        // Fork (W9b-3, 9.58): the bundled pack comes after the plugin roots (Node's priority after every plugin root), and
        // the plugins switch does not reach it (Node adds it as a system root).
        if let Some(dir) = self.bundled_skills_dir(workspace).await {
            found.extend(load::bundled(self, workspace, facts, &dir).await);
        }
        if self.dynamic_workflows_gated(session) {
            found.retain(|skill| {
                !(skill.source == SkillSource::Bundled && skill.name == DYNAMIC_WORKFLOW_SKILL)
            });
        }
        let built_ins: Vec<Arc<Skill>> = builtin::skills()
            .into_iter()
            .filter(|skill| self.looping || skill.name != builtin::LOOP)
            .collect();
        // W9b-2 (9.57, ocr delta): a built-in whose name is reserved (`init`) is not shadowed by a file, plugin or managed skill
        // of the same name, so `/init` keeps running the built-in. Other names keep the first-wins order below.
        found.retain(|skill| {
            !built_ins.iter().any(|built_in| {
                built_in.name == skill.name
                    && rust_cli_kernel_api::slash_names::is_reserved_slash_name(&built_in.name)
            })
        });
        // 内置 skill 排在文件与插件 skill 之后，同名时前面的生效。
        found.extend(built_ins);
        let mut seen = HashSet::new();
        found
            .into_iter()
            .filter(|skill| seen.insert(skill.name.clone()))
            .collect()
    }

    /// Fork (desktop App): the Composer reference catalog (Node `skill-reference-catalog.ts`
    /// `toResult`): every discovered skill except the bundled ones, in priority order.
    pub async fn references(
        &self,
        workspace: &WorkspaceRef,
    ) -> Vec<rust_cli_kernel_api::user_command::SkillReference> {
        self.skills(workspace)
            .await
            .iter()
            .filter_map(|skill| reference(skill))
            .collect()
    }

    /// 这次会话调用过的 skill（compact.md §3.4）：`history` 是全部历史，最近的在前。
    pub async fn invoked(
        &self,
        workspace: &WorkspaceRef,
        history: &[Message],
    ) -> Vec<rust_cli_kernel_api::listing::InvokedSkill> {
        invoked::invoked(self, workspace, history).await
    }

    /// Fork: whether `session`, a subagent child, asks for an official Computer Use skill by `name`. The Skill tool answers
    /// with the Computer Use refusal instead of "Unknown skill" (Node `FilteredSkillPort.loadSkill`).
    pub async fn refuses_official(
        &self,
        workspace: &WorkspaceRef,
        session: &rust_cli_kernel_api::ids::SessionId,
        name: &str,
    ) -> bool {
        if !self.grants.lock_unpoisoned().contains_key(session) {
            return false;
        }
        let official = self.official_dirs(workspace);
        if official.is_empty() {
            return false;
        }
        let skills = self.discovered(workspace, None).await;
        names_official(&skills, &official, name)
    }

    /// 按名字找（Skill 工具用）。
    pub async fn find(&self, workspace: &WorkspaceRef, name: &str) -> Option<Arc<Skill>> {
        self.find_in(workspace, None, name).await
    }

    /// Fork: [`Self::find`] as `session` sees the skills.
    pub async fn find_in(
        &self,
        workspace: &WorkspaceRef,
        session: Option<&rust_cli_kernel_api::ids::SessionId>,
        name: &str,
    ) -> Option<Arc<Skill>> {
        self.skills_in(workspace, session)
            .await
            .into_iter()
            .find(|skill| skill.name == name)
    }

    /// 这一步给模型的 skill 清单（ext.md §2.3）：去掉禁止模型调用的与未激活的条件 skill。预算按 `model` 的上下文
    /// 窗口（模型卡片，没有时 200000）与每 token 字符数（没有模型时 4）。
    pub async fn listing(
        &self,
        workspace: &WorkspaceRef,
        session: Option<&rust_cli_kernel_api::ids::SessionId>,
        history: &[Message],
        model: &str,
    ) -> Vec<ListingEntry> {
        let Ok(facts) = self.info.facts(workspace).await else {
            return Vec::new();
        };
        let skills = self
            .skills_with(workspace, &facts, self.keeps_plugins(session), session)
            .await;
        let skills = self.granted(workspace, session, skills);
        let touched = paths::touched(history, facts.cwd.as_str());
        let visible: Vec<Arc<Skill>> = skills
            .iter()
            .filter(|skill| !skill.disable_model_invocation)
            .filter(|skill| paths::active(skill, &touched))
            .cloned()
            .collect();
        let window = rust_cli_prompts::models::card(model).map(|card| card.context_window);
        let chars = rust_cli_prompts::models::chars_per_token(model);
        listing::entries(&visible, &skills, listing::budget(window, chars))
    }
}

/// Node `toReferenceCatalogEntry`: plugin skills are `plugin`, project skills `workspace`, the rest
/// `user`; the name is the frontmatter `name` and the path the `SKILL.md` file.
fn reference(skill: &Skill) -> Option<rust_cli_kernel_api::user_command::SkillReference> {
    use rust_cli_kernel_api::user_command::{SkillReference, SkillScope};
    let (scope, plugin) = match &skill.source {
        SkillSource::Builtin | SkillSource::Bundled => return None,
        SkillSource::Plugin { plugin } => (SkillScope::Plugin, Some(plugin.clone())),
        SkillSource::Project => (SkillScope::Workspace, None),
        SkillSource::User | SkillSource::Managed => (SkillScope::User, None),
    };
    let fallback = skill.name.rsplit(':').next().unwrap_or(&skill.name);
    let name = skill
        .display
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(fallback)
        .to_owned();
    let separator = if skill.dir.contains('\\') && !skill.dir.contains('/') {
        '\\'
    } else {
        '/'
    };
    let path = format!(
        "{}{separator}SKILL.md",
        skill.dir.trim_end_matches(['/', '\\'])
    );
    Some(SkillReference {
        name,
        description: skill.description.clone(),
        path,
        scope,
        plugin,
    })
}

#[cfg(test)]
#[path = "mod_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "bundled_tests.rs"]
mod bundled_tests;

#[cfg(test)]
#[path = "cua_tests.rs"]
mod cua_tests;

#[async_trait::async_trait]
impl rust_cli_kernel_api::subagent_config::SubagentSkillGrants for SkillCatalog {
    async fn grant(
        &self,
        child: &rust_cli_kernel_api::ids::SessionId,
        workspace: &WorkspaceRef,
        entries: &[String],
    ) -> Vec<String> {
        // Discover unfiltered while the child's old grant is still in force; the new grant replaces it with one insert,
        // so no concurrent lookup sees the full catalog in between.
        let skills = self.discovered(workspace, Some(child)).await;
        let resolved = grants::resolve(entries, &skills);
        self.grants
            .lock_unpoisoned()
            .insert(child.clone(), Some(resolved.identities));
        resolved.unresolved
    }

    fn forget(&self, child: &rust_cli_kernel_api::ids::SessionId) {
        self.grants.lock_unpoisoned().remove(child);
    }

    fn enroll(&self, child: &rust_cli_kernel_api::ids::SessionId) {
        self.grants
            .lock_unpoisoned()
            .entry(child.clone())
            .or_insert(None);
    }

    async fn computer_use_refusal(
        &self,
        workspace: &WorkspaceRef,
        entries: &[String],
    ) -> Option<String> {
        let official = self.official_dirs(workspace);
        if official.is_empty() || entries.is_empty() {
            return None;
        }
        let skills = self.discovered(workspace, None).await;
        entries
            .iter()
            .any(|entry| names_official(&skills, &official, entry))
            .then(|| rust_cli_kernel_api::subagent_config::COMPUTER_USE_UNAVAILABLE.to_owned())
    }
}

/// Whether `skill` is a skill of the official Computer Use plugin: a plugin skill of that plugin whose directory is under
/// one of its flagged roots (Node `OfficialCuaPolicy.isOfficialSkill`: plugin source, plugin name, root containment).
fn is_official(skill: &Skill, official: &[(String, String)]) -> bool {
    let SkillSource::Plugin { plugin } = &skill.source else {
        return false;
    };
    official
        .iter()
        .any(|(name, root)| name == plugin && within(root, &skill.dir))
}

/// `path` is `root` or lies under it, by the path style of `root`.
fn within(root: &str, path: &str) -> bool {
    let style = rust_cli_kernel_api::env_files::PathStyle::infer(root);
    let root = root.trim_end_matches(|c| style.is_separator(c));
    path.strip_prefix(root)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(|c| style.is_separator(c)))
}

/// Whether a skill request names an official Computer Use skill (Node `isOfficialSkillRequest` or
/// `isUniqueOfficialSkillRequest`): the request is the call name of an official skill, or a name without `:` that
/// matches exactly one skill, which is official.
fn names_official(skills: &[Arc<Skill>], official: &[(String, String)], request: &str) -> bool {
    let request = request.trim();
    if skills
        .iter()
        .any(|skill| skill.name == request && is_official(skill, official))
    {
        return true;
    }
    if request.contains(':') {
        return false;
    }
    let mut matches = skills
        .iter()
        .filter(|skill| skill.name == request || grants::bare(skill) == request);
    match (matches.next(), matches.next()) {
        (Some(only), None) => is_official(only, official),
        _ => false,
    }
}
