//! 子代理的上下文：attachment 由主线程的 [`ContextBuilder`] 按 `QuerySource::Subagent` 产生
//! （context 的子代理分支），system 段换成子代理自己的（docs/specs/rust-cli/agents.md §4.3）。
//! 以及 agent 清单（`ListingSource`，交给主线程的 `agent_listing_delta`）。

use rust_cli_base::sync::{LockUnpoisoned, RwLockUnpoisoned};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use async_trait::async_trait;
use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use rust_cli_kernel_api::env::WorkspaceRef;
use rust_cli_kernel_api::ids::{RunId, SessionId};
use rust_cli_kernel_api::incognito::IncognitoKey;
use rust_cli_kernel_api::listing::{ListingEntry, ListingSource, Listings};
use rust_cli_kernel_api::machine::{EnvInfo, Files};
use rust_cli_kernel_api::message::{AttachmentMessage, Message};
use rust_cli_kernel_api::model::SystemBlock;
use rust_cli_kernel_api::orchestration::{
    BuiltContext, ContextBuilder, ContextRequest, OrchestrationError,
};

use rust_cli_kernel_api::subagent_config::{
    ProfileSource, SubagentConfigSource, SubagentProfile, SubagentSnapshot,
};

use crate::custom;
use crate::definitions::{AgentDefinition, AgentSource, EXPLORE, GENERAL_PURPOSE, builtins, merge};
use crate::plugin::{self, PluginAgentFile};

pub(crate) struct SubagentContext {
    pub(crate) inner: Arc<dyn ContextBuilder>,
    pub(crate) system: Vec<SystemBlock>,
}

#[async_trait]
impl ContextBuilder for SubagentContext {
    async fn build(
        &self,
        request: ContextRequest,
        history: &[Message],
    ) -> Result<BuiltContext, OrchestrationError> {
        let mut built = self.inner.build(request, history).await?;
        built.system = self.system.clone();
        Ok(built)
    }

    /// 当步的 attachment 交给主线程的实现（子代理来源由它决定给什么，docs/specs/rust-cli/query.md §1.1）。
    async fn turn_attachments(
        &self,
        request: ContextRequest,
        history: &[Message],
    ) -> Result<Vec<AttachmentMessage>, OrchestrationError> {
        self.inner.turn_attachments(request, history).await
    }

    /// 运行开始的一组同样交给主线程的实现（子代理开头的那几项，agents.md §4.3，修复线 F16）。
    /// 不转发时会落到缺省实现（`turn_attachments`），子代理第一个请求变成工具轮那一组的顺序。
    async fn start_attachments(
        &self,
        request: ContextRequest,
        history: &[Message],
    ) -> Result<Vec<AttachmentMessage>, OrchestrationError> {
        self.inner.start_attachments(request, history).await
    }
}

/// Fork: maps a session to its root session (a subagent's child session to the session that spawned the tree).
pub type RootOf = Arc<dyn Fn(&SessionId) -> SessionId + Send + Sync>;

/// Fork: a Host read in progress, shared by the lookups it serves.
type Flight = Shared<BoxFuture<'static, Result<Option<SubagentSnapshot>, String>>>;

/// Fork: one root session's snapshot and the read in progress, with the parent run each is for.
#[derive(Default)]
struct Slot {
    cached: Option<Cached>,
    flight: Option<(Option<RunId>, Flight)>,
}

/// Fork: the Host snapshot of one root session and the parent run that read it (`None`: a lookup outside a run).
/// `snapshot` None: the Host does not offer one, so the agent files apply.
#[derive(Clone)]
struct Cached {
    run: Option<RunId>,
    snapshot: Option<SubagentSnapshot>,
}

/// 当前可用的 agent 类型：内置、插件、用户级、项目级（同名时后者覆盖）。agent 文件每次都从执行环境
/// 读，文件是唯一事实源，不缓存；插件 agent 的文件位置是插件加载时交进来的快照。
///
/// Fork: with a Host source (desktop app-server) a session's agents come from the Host's snapshot instead of the
/// agent files, read at most once per parent run and shared by the root session's subagents
/// (specs/fork-rust-subagent-runtime-config.md).
///
/// 主线程的 agent 清单（context）与 Agent 工具共用同一个实例（runtime 组装），两处看到的插件 agent
/// 总是同一组。
pub struct AgentCatalog {
    /// agent 定义是本机的文件（用户级与项目级目录、插件），经本机的端口读。
    info: Arc<dyn EnvInfo>,
    files: Arc<dyn Files>,
    /// 插件 agent 文件；只由 runtime 在插件加载后设置（agents.md §3）。
    plugins: RwLock<Vec<PluginAgentFile>>,
    /// Fork: the sessions' incognito profiles (specs/fork-rust-agent-parity.md, "Incognito sessions").
    incognito: OnceLock<rust_cli_kernel_api::incognito::IncognitoProfiles>,
    /// Fork: the Host's subagent snapshot; only the desktop app-server sets it.
    host: OnceLock<Arc<dyn SubagentConfigSource>>,
    /// Fork: the subagent tree's root of a session; set by `Agents::new`.
    roots: OnceLock<RootOf>,
    /// Fork: per root session, the latest snapshot and the read in progress.
    snapshots: Mutex<HashMap<SessionId, Slot>>,
}

impl AgentCatalog {
    pub fn new(info: Arc<dyn EnvInfo>, files: Arc<dyn Files>) -> Self {
        Self {
            info,
            files,
            plugins: RwLock::default(),
            incognito: OnceLock::new(),
            host: OnceLock::new(),
            roots: OnceLock::new(),
            snapshots: Mutex::default(),
        }
    }

    /// Fork: set once by the runtime. Without custom agents a session sees only the built-in agents (Node resolves
    /// every agent source as the built-in fallback, plugin agents included); without plugins it sees no plugin agents.
    pub fn set_incognito(&self, profiles: rust_cli_kernel_api::incognito::IncognitoProfiles) {
        let _ = self.incognito.set(profiles);
    }

    /// Fork: set once by the runtime when the frontend has a Host that owns the subagent config.
    pub fn set_host(&self, host: Arc<dyn SubagentConfigSource>) {
        let _ = self.host.set(host);
    }

    /// Fork: set once by `Agents::new`, which owns the live subagent tree.
    pub fn set_roots(&self, roots: RootOf) {
        let _ = self.roots.set(roots);
    }

    /// Fork: `session` closed: drop its cached snapshot and the source's gate (rule 11). A subagent's session holds no
    /// entry of its own, so releasing one drops nothing.
    pub fn forget(&self, session: &SessionId) {
        self.snapshots.lock_unpoisoned().remove(session);
        if let Some(host) = self.host.get() {
            host.forget(session);
        }
    }

    /// 换上插件加载得到的 agent 文件（`LocalKernel::start_extensions`）。
    pub fn set_plugins(&self, files: Vec<PluginAgentFile>) {
        *self.plugins.write_unpoisoned() = files;
    }

    /// 当前可用的 agent 类型（`/context` 的自定义 agent 也用它，context-usage.md §3）。Fork: no session to key a
    /// Host snapshot on, so the agent files apply (rule 12).
    pub async fn definitions(&self, workspace: &WorkspaceRef) -> Vec<AgentDefinition> {
        self.definitions_in(workspace, None).await
    }

    /// Fork: [`Self::definitions`] as `session`'s incognito profile allows. A lookup that cannot fail (`/context`
    /// usage, the runtime catalog) logs a failed Host read and uses the agent files.
    pub async fn definitions_in(
        &self,
        workspace: &WorkspaceRef,
        session: Option<&SessionId>,
    ) -> Vec<AgentDefinition> {
        let Some(session) = session else {
            return self
                .file_definitions(workspace, self.plugin_files(None))
                .await;
        };
        match self.prepared_definitions(workspace, session, None).await {
            Ok(found) => found,
            Err(error) => {
                tracing::warn!(%error, "the subagent runtime config is not available; using the agent files");
                self.file_definitions(workspace, self.plugin_files(Some(session)))
                    .await
            }
        }
    }

    /// Fork: the agents `session` may launch in `run` (rules 3–6, 10). `Err` is a failed Host read: the listing
    /// fails the turn, the Agent tool returns it.
    pub async fn prepared_definitions(
        &self,
        workspace: &WorkspaceRef,
        session: &SessionId,
        run: Option<&RunId>,
    ) -> Result<Vec<AgentDefinition>, String> {
        if self.excludes(Some(session), IncognitoKey::CustomAgents) {
            return Ok(merge(vec![builtins()]));
        }
        let plugin_files = self.plugin_files(Some(session));
        let Some(host) = self.host.get() else {
            return Ok(self.file_definitions(workspace, plugin_files).await);
        };
        match self.snapshot(host, session, run).await? {
            None => Ok(self.file_definitions(workspace, plugin_files).await),
            Some(SubagentSnapshot::BuiltInFallback) => Ok(merge(vec![builtins()])),
            Some(SubagentSnapshot::Ready {
                profiles,
                explore,
                general_purpose,
                plugins,
            }) => {
                let mut built_in = builtins();
                for definition in &mut built_in {
                    let wanted = match definition.agent_type.as_str() {
                        EXPLORE => &explore,
                        GENERAL_PURPOSE => &general_purpose,
                        _ => &None,
                    };
                    if wanted.is_some() {
                        definition.selection.clone_from(wanted);
                    }
                }
                Ok(merge(vec![
                    built_in,
                    plugin::load(self.files.as_ref(), workspace, &plugin_files, &plugins).await,
                    profiles.into_iter().map(from_profile).collect(),
                ]))
            }
        }
    }

    /// The root session's snapshot for this lookup (rule 3). A parent lookup (the root session in a run) reads
    /// unless its run already did; any other lookup uses the cached snapshot and reads only when there is none.
    /// Lookups that a read in flight would serve wait for it instead of sending another. A failed read leaves the
    /// cache as it was.
    async fn snapshot(
        &self,
        host: &Arc<dyn SubagentConfigSource>,
        session: &SessionId,
        run: Option<&RunId>,
    ) -> Result<Option<SubagentSnapshot>, String> {
        let root = self
            .roots
            .get()
            .map_or_else(|| session.clone(), |roots| roots(session));
        let parent_run = run.filter(|_| &root == session);
        let serves = |tag: &Option<RunId>| parent_run.is_none() || tag.as_ref() == parent_run;
        let (tag, flight) = {
            let mut slots = self.snapshots.lock_unpoisoned();
            let slot = slots.entry(root.clone()).or_default();
            if let Some(found) = &slot.cached
                && serves(&found.run)
            {
                return Ok(found.snapshot.clone());
            }
            match &slot.flight {
                Some((tag, flight)) if serves(tag) => (tag.clone(), flight.clone()),
                _ => {
                    let host = host.clone();
                    let reading = root.clone();
                    let flight = async move { host.read(&reading).await }.boxed().shared();
                    let tag = parent_run.cloned();
                    slot.flight = Some((tag.clone(), flight.clone()));
                    (tag, flight)
                }
            }
        };
        let result = flight.clone().await;
        let mut slots = self.snapshots.lock_unpoisoned();
        let slot = slots.entry(root).or_default();
        // The first lookup back from this read settles it; a newer read in flight is left alone.
        if slot
            .flight
            .as_ref()
            .is_some_and(|(_, current)| current.ptr_eq(&flight))
        {
            slot.flight = None;
            if let Ok(snapshot) = &result {
                slot.cached = Some(Cached {
                    run: tag,
                    snapshot: snapshot.clone(),
                });
            }
        }
        result
    }

    fn excludes(&self, session: Option<&SessionId>, key: IncognitoKey) -> bool {
        session
            .zip(self.incognito.get())
            .is_some_and(|(session, profiles)| profiles.excludes(session, key))
    }

    fn plugin_files(&self, session: Option<&SessionId>) -> Vec<PluginAgentFile> {
        if self.excludes(session, IncognitoKey::Plugins) {
            Vec::new()
        } else {
            self.plugins.read_unpoisoned().clone()
        }
    }

    /// The agents of the agent files: built-ins, plugins, user, project.
    async fn file_definitions(
        &self,
        workspace: &WorkspaceRef,
        plugin_files: Vec<PluginAgentFile>,
    ) -> Vec<AgentDefinition> {
        let mut layers = vec![
            builtins(),
            plugin::load(
                self.files.as_ref(),
                workspace,
                &plugin_files,
                &Default::default(),
            )
            .await,
        ];
        match self.info.facts(workspace).await {
            Ok(facts) => layers.extend(custom::load(self.files.as_ref(), workspace, &facts).await),
            Err(error) => tracing::debug!(%error, "custom agents are not available"),
        }
        merge(layers)
    }
}

/// The run of a parent lookup (rule 3). A subagent's lookups never start a read of their own, even when the root of
/// its session is not known.
fn parent_run(request: &ContextRequest) -> Option<&RunId> {
    match request.source {
        rust_cli_kernel_api::model::QuerySource::Subagent(_) => None,
        _ => request.run.as_ref(),
    }
}

/// A Host profile as an agent definition (rule 8).
fn from_profile(profile: SubagentProfile) -> AgentDefinition {
    AgentDefinition {
        agent_type: profile.name,
        when_to_use: profile.description,
        tools: profile.tools,
        disallowed_tools: profile.disallowed_tools,
        prompt: profile.system_prompt,
        source: match profile.source {
            ProfileSource::User => AgentSource::User,
            ProfileSource::Project => AgentSource::Project,
        },
        model: None,
        effort: None,
        max_turns: profile.max_turns,
        permission_mode: profile.permission_mode,
        background: profile.background,
        selection: profile.selection,
    }
}

#[async_trait]
impl ListingSource for AgentCatalog {
    async fn listings(&self, request: &ContextRequest) -> Result<Listings, OrchestrationError> {
        let agents = self
            .prepared_definitions(&request.workspace, &request.session, parent_run(request))
            .await
            .map_err(|message| OrchestrationError::Failed { message })?
            .iter()
            .map(|definition| ListingEntry {
                name: definition.agent_type.clone(),
                line: definition.listing_line(),
            })
            .collect();
        Ok(Listings {
            agents,
            ..Listings::default()
        })
    }
}

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "context_host_tests.rs"]
mod host_tests;
