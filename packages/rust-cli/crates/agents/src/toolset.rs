//! 子代理的工具集（docs/specs/rust-cli/agents.md §4.2）。
//!
//! 每次取工具时按规则从主注册表过滤，不复制工具列表：主注册表是唯一来源（MCP 工具变化时子代理
//! 同样看到）。

use std::sync::Arc;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::manage::McpServerState;
use rust_cli_kernel_api::mcp_state::{McpConnections, McpView};
use rust_cli_kernel_api::orchestration::{ToolRegistry, ToolSnapshot};
use rust_cli_kernel_api::tool::Tool;
use rust_cli_kernel_api::tool_search::{SEARCH_TOOLS, search_fallback};

use crate::definitions::AgentDefinition;
use rust_cli_kernel_api::tool_names;

/// 所有子代理都不能用的工具（general-purpose 有 Agent、TaskStop、SendMessage，没有
/// Workflow、ScheduleWakeup）。
const ALL_AGENT_DISALLOWED: &[&str] = &[
    "Workflow",
    tool_names::SCHEDULE_WAKEUP,
    tool_names::TASK_OUTPUT,
    tool_names::EXIT_PLAN_MODE,
    tool_names::ENTER_PLAN_MODE,
    tool_names::ASK_USER_QUESTION,
    // Fork: Node builds subagent runtimes without the LSP service (specs/fork-rust-lsp.md "Tool (D2)").
    tool_names::LSP,
];

/// Fork: the desktop main-session-only tools, the Cron tools and the off-peak tools (Node registers them for the main
/// session only). Both are read from their canonical arrays in `tool_names`, so a new member is withheld from subagents
/// with no second list to update.
fn main_session_only(name: &str) -> bool {
    tool_names::CRON_TOOLS.contains(&name) || tool_names::OFF_PEAK_TOOLS.contains(&name)
}

/// Fork (node_desktop): the subagent tools. Node runs every child runtime with `subagents.enabled: false` (core
/// `runtime/methods/subagent.ts`), so a child has no subagent port, no Agent and no SendMessage; Node has no ListAgents.
const NODE_CHILD_SUBAGENT_TOOLS: &[&str] = &[
    crate::agent_tool::NAME,
    tool_names::SEND_MESSAGE,
    tool_names::LIST_AGENTS,
];

/// Fork (node_desktop): the tools no subagent child of Node's desktop agent has, fork or not: the Cron tools, which
/// Node registers for the main session only, and the subagent tools (a desktop subagent launches no subagents).
fn node_child_lacks(name: &str) -> bool {
    main_session_only(name) || NODE_CHILD_SUBAGENT_TOOLS.contains(&name)
}

/// 后台子代理只能用的工具（含 SendMessage、TaskStop、Monitor）。
const ASYNC_ALLOWED: &[&str] = &[
    tool_names::READ,
    tool_names::WEB_SEARCH,
    tool_names::TODO_WRITE,
    tool_names::GREP,
    tool_names::WEB_FETCH,
    tool_names::GLOB,
    tool_names::BASH,
    tool_names::POWER_SHELL,
    tool_names::EDIT,
    tool_names::WRITE,
    tool_names::NOTEBOOK_EDIT,
    tool_names::SKILL,
    "StructuredOutput",
    tool_names::TOOL_SEARCH,
    tool_names::ENTER_WORKTREE,
    tool_names::EXIT_WORKTREE,
    tool_names::SEND_MESSAGE,
    tool_names::TASK_STOP,
    // 工作线 F83：后台子代理的白名单里有 Monitor（tools-more.md §19.1）。
    tool_names::MONITOR,
];

/// 能派生子代理的最大深度（固定值，没有环境变量能改）。
const MAX_SPAWN_DEPTH: u32 = 3;

/// 一个子代理的过滤规则。
#[derive(Debug, Clone)]
pub(crate) struct ToolRule {
    allow: Option<Vec<String>>,
    deny: Vec<String>,
    background: bool,
    /// 这个子代理的深度（主线程派生的是 1）。
    depth: u32,
    /// Fork (node_desktop): a foreground subagent may ask the user (AskUserQuestion), delegated to
    /// the parent's ask (Node `filterSubagentChildToolNames` only removes the plan tools).
    questions: bool,
    /// Fork (node_desktop): a child of Node's desktop agent ([`node_child_lacks`]).
    node_child: bool,
    /// Fork (rule 17): the child has a `skills` list, so it is offered the Skill tool.
    skill_grants: bool,
    /// Fork (rule 16, `mcpServers`): the parent servers the child is scoped to; None (or empty) means all of them.
    mcp_servers: Option<Vec<String>>,
}

impl ToolRule {
    pub(crate) fn new(definition: &AgentDefinition, background: bool, depth: u32) -> Self {
        Self {
            allow: definition
                .tools
                .clone()
                .filter(|tools| !tools.iter().any(|tool| tool == "*")),
            deny: definition.disallowed_tools.clone(),
            background,
            depth,
            questions: false,
            node_child: false,
            skill_grants: definition
                .skills
                .as_ref()
                .is_some_and(|skills| !skills.is_empty()),
            mcp_servers: definition
                .mcp_servers
                .clone()
                .filter(|servers| !servers.is_empty()),
        }
    }

    /// Fork (node_desktop): see [`ToolRule::questions`].
    #[must_use]
    pub(crate) fn with_questions(mut self, questions: bool) -> Self {
        self.questions = questions;
        self
    }

    /// Fork (node_desktop): see [`node_child_lacks`].
    #[must_use]
    pub(crate) fn node_child(mut self, node_child: bool) -> Self {
        self.node_child = node_child;
        self
    }

    pub(crate) fn allows(&self, name: &str) -> bool {
        // Node gives every child the coordinator port (`includeRespondToCoordinator`), so the child's `tools`
        // allowlist does not remove it; only `disallowedTools` does.
        if name == crate::respond::NAME {
            return !self.deny.iter().any(|tool| tool == name);
        }
        let mcp = rust_cli_kernel_api::mcp_name::is_mcp(name);
        let asks = self.questions && name == tool_names::ASK_USER_QUESTION;
        if !mcp && !asks && ALL_AGENT_DISALLOWED.contains(&name) {
            return false;
        }
        if self.node_child && node_child_lacks(name) {
            return false;
        }
        // Agent 只看深度，不受异步白名单限制（先判 Agent；后台的 general-purpose 有它）。
        // 以前后台子代理一律没有 Agent，子代理里派生的又总在前台，嵌套的后台子代理无从出现。
        let depth_allows = name != crate::agent_tool::NAME || self.depth < MAX_SPAWN_DEPTH;
        if !depth_allows {
            return false;
        }
        if !mcp
            && self.background
            && name != crate::agent_tool::NAME
            && !ASYNC_ALLOWED.contains(&name)
        {
            return false;
        }
        if self.deny.iter().any(|tool| tool == name) {
            return false;
        }
        // Fork (rule 17): a child with a `skills` list has the Skill tool whatever its `tools` list says.
        if self.skill_grants && name == tool_names::SKILL {
            return true;
        }
        self.allow
            .as_ref()
            .is_none_or(|allow| allow.iter().any(|tool| tool == name))
    }
}

/// 子代理看到的工具：主注册表按 [`ToolRule`] 过滤。
///
/// 定义点名了工具清单时（修复线 F16，agents.md §4.2 第 4 条）：按清单的顺序排，发给模型时
/// 保持这个顺序（`keeps_order`）；清单点名 Glob / Grep、解析出的工具里又没有 Bash 时，从主注册表的 `withheld`
/// 补回它们，排在最后。修 bug：以前只从主注册表过滤，被 Bash 藏起来的 Grep 子代理拿不到，顺序也按名字。
pub(crate) struct FilteredTools {
    pub(crate) inner: Arc<dyn ToolRegistry>,
    pub(crate) rule: ToolRule,
    /// Tools only a subagent child has (RespondToCoordinator). They are not in `inner`, so the main thread never sees
    /// them; they pass the rule like the others, except that the `tools` allowlist does not remove them.
    pub(crate) child_tools: Vec<Arc<dyn Tool>>,
}

impl FilteredTools {
    /// The child-only tools that the rule keeps, in the order they were given.
    fn child_pool(&self) -> Vec<Arc<dyn Tool>> {
        self.child_tools
            .iter()
            .filter(|tool| self.rule.allows(tool.name()))
            .cloned()
            .collect()
    }
}

impl FilteredTools {
    /// Fork (rule 16): the parent's live MCP view, when the child is scoped to `mcpServers` (the owner of each MCP
    /// tool is read from it).
    fn live_view(&self) -> Option<McpView> {
        self.rule
            .mcp_servers
            .as_ref()
            .and_then(|_| self.inner.mcp())
            .map(|mcp| mcp.view())
    }

    /// Fork (rule 16, Node `servers_for_tool`): an MCP tool is the child's when its owner, the longest server-name
    /// prefix in the live view, is one of the scoped servers. A tool with no known owner is out of scope.
    fn mcp_in_scope(&self, view: Option<&McpView>, name: &str) -> bool {
        let Some(scope) = self.rule.mcp_servers.as_deref() else {
            return true;
        };
        view.is_some_and(|view| {
            rust_cli_kernel_api::mcp_state::servers_for_tool(view, name)
                .iter()
                .any(|owner| scope.contains(&owner.name))
        })
    }

    /// The rule's verdict for `name`, plus the `mcpServers` scope for an MCP tool.
    fn allowed(&self, view: Option<&McpView>, name: &str) -> bool {
        self.rule.allows(name)
            && (!rust_cli_kernel_api::mcp_name::is_mcp(name) || self.mcp_in_scope(view, name))
    }

    /// Fork (rule 16): the parent's connections narrowed to the child's `mcpServers`; unchanged without a scope.
    fn scoped_connections(&self, inner: Arc<dyn McpConnections>) -> Arc<dyn McpConnections> {
        match &self.rule.mcp_servers {
            None => inner,
            Some(servers) => Arc::new(ScopedMcp {
                inner,
                servers: servers.clone(),
            }),
        }
    }

    /// Fork (rule 16): a parent MCP view narrowed to the child's `mcpServers`.
    fn scope_view(&self, view: McpView) -> McpView {
        scope_mcp_view(view, self.rule.mcp_servers.as_deref())
    }

    /// 补回的搜索工具（按清单里出现的顺序，kernel-api `tool_search::search_fallback`）；没有点名清单、或解析出的
    /// 工具里有 Bash 时为空。
    fn restored(&self, resolved: &[Arc<dyn Tool>]) -> Vec<Arc<dyn Tool>> {
        let Some(allow) = &self.rule.allow else {
            return Vec::new();
        };
        let view = self.live_view();
        let wanted = allow
            .iter()
            .map(String::as_str)
            .filter(|name| self.allowed(view.as_ref(), name));
        search_fallback(resolved, wanted, |name| self.inner.withheld(name))
    }
}

impl FilteredTools {
    /// 主注册表的工具（`tools()` 或快照里的）按规则过滤、按清单排序。
    fn resolve(&self, tools: Vec<Arc<dyn Tool>>) -> Vec<Arc<dyn Tool>> {
        let view = self.live_view();
        let mut pool: Vec<Arc<dyn Tool>> = tools
            .into_iter()
            .filter(|tool| self.allowed(view.as_ref(), tool.name()))
            .collect();
        pool.extend(self.child_pool());
        let Some(allow) = &self.rule.allow else {
            return pool;
        };
        // 按清单的顺序（`allows` 已保证池里的每个工具都在清单里），重复的名字只算一次。
        let mut resolved: Vec<Arc<dyn Tool>> = Vec::with_capacity(pool.len());
        for name in allow {
            if let Some(tool) = pool.iter().find(|tool| tool.name() == name)
                && !resolved.iter().any(|seen| Arc::ptr_eq(seen, tool))
            {
                resolved.push(tool.clone());
            }
        }
        let restored = self.restored(&resolved);
        resolved.extend(restored);
        // Fork (rule 17): the Skill tool a `skills` list adds, even when the `tools` list does not name it.
        if self.rule.skill_grants
            && !resolved.iter().any(|tool| tool.name() == tool_names::SKILL)
            && let Some(tool) = pool.iter().find(|tool| tool.name() == tool_names::SKILL)
        {
            resolved.push(tool.clone());
        }
        // The child-only tools are not named in the allowlist, but they are always in the child's set. They come after
        // the restored search tools: Node's child lists RespondToCoordinator last (`coordinator-response` tool order).
        for tool in self.child_pool() {
            if !resolved.iter().any(|seen| Arc::ptr_eq(seen, &tool)) {
                resolved.push(tool);
            }
        }
        resolved
    }
}

impl ToolRegistry for FilteredTools {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.resolve(self.inner.tools())
    }

    /// 主注册表的快照按同一规则过滤（MCP 状态不变，query.md §1.3）。
    fn snapshot(&self, session: &SessionId) -> ToolSnapshot {
        let snapshot = self.inner.snapshot(session);
        ToolSnapshot {
            tools: self.resolve(snapshot.tools),
            mcp: snapshot.mcp.map(|view| self.scope_view(view)),
        }
    }

    fn mcp(&self) -> Option<Arc<dyn McpConnections>> {
        self.inner.mcp().map(|inner| self.scoped_connections(inner))
    }

    /// Fork (specs/fork-rust-workspace-plugins-mcp.md): forward the session's workspace group.
    fn mcp_for(
        &self,
        session: &rust_cli_kernel_api::ids::SessionId,
    ) -> Option<Arc<dyn McpConnections>> {
        self.inner
            .mcp_for(session)
            .map(|inner| self.scoped_connections(inner))
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        let view = self.live_view();
        if let Some(tool) = self
            .inner
            .find(name)
            .filter(|tool| self.allowed(view.as_ref(), tool.name()))
        {
            return Some(tool);
        }
        if let Some(tool) = self
            .child_pool()
            .into_iter()
            .find(|tool| tool.name() == name)
        {
            return Some(tool);
        }
        if !SEARCH_TOOLS.contains(&name) {
            return None;
        }
        self.tools().into_iter().find(|tool| tool.name() == name)
    }

    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        let view = self.live_view();
        if let Some(tool) = self
            .inner
            .find_for(session, name)
            .filter(|tool| self.allowed(view.as_ref(), tool.name()))
        {
            return Some(tool);
        }
        if let Some(tool) = self
            .child_pool()
            .into_iter()
            .find(|tool| tool.name() == name)
        {
            return Some(tool);
        }
        if !SEARCH_TOOLS.contains(&name) {
            return None;
        }
        self.tools().into_iter().find(|tool| tool.name() == name)
    }

    fn keeps_order(&self) -> bool {
        self.rule.allow.is_some()
    }

    /// 子代理的清单已经补回了点名的搜索工具（`resolve`），没有再扣下的。子代理的注册表不再被包一层：嵌套的子代理用
    /// 主线程的注册表（工作线 F134 把以前的缺省写明）。
    fn withheld(&self, _name: &str) -> Option<Arc<dyn Tool>> {
        None
    }

    /// 同上：没有叠在它上面的工具（以前的缺省）。
    fn hides(&self, _name: &str) -> bool {
        false
    }
}

/// Fork (rule 16): Node's `Required MCP server is not connected` for a definition whose `mcpServers` name a server that
/// the parent's view does not show as connected. None when no server is listed or every listed one is connected.
pub(crate) fn mcp_refusal(definition: &AgentDefinition, view: Option<&McpView>) -> Option<String> {
    let servers = definition
        .mcp_servers
        .as_ref()
        .filter(|servers| !servers.is_empty())?;
    let missing: Vec<&str> = servers
        .iter()
        .map(String::as_str)
        .filter(|name| {
            !view.is_some_and(|view| {
                view.servers
                    .iter()
                    .any(|server| server.name == *name && server.state == McpServerState::Connected)
            })
        })
        .collect();
    (!missing.is_empty()).then(|| {
        format!(
            "Required MCP server is not connected: {}",
            missing.join(", ")
        )
    })
}

/// Fork (rule 16, Node `resolveSubagentMcpAccess` awaiting `mcpStartupPromise`): when a listed server is still
/// connecting, waits for the parent's first connections (bounded by the connect wait), then refuses as
/// [`mcp_refusal`] does.
pub(crate) async fn mcp_refusal_settled(
    definition: &AgentDefinition,
    mcp: Option<Arc<dyn McpConnections>>,
) -> Option<String> {
    let listed = definition
        .mcp_servers
        .as_ref()
        .filter(|servers| !servers.is_empty())?;
    let connecting = mcp.as_ref().is_some_and(|mcp| {
        mcp.view()
            .servers
            .iter()
            .any(|server| server.state == McpServerState::Pending && listed.contains(&server.name))
    });
    if connecting && let Some(mcp) = &mcp {
        mcp.wait_for_first_connections().await;
    }
    let view = mcp.as_ref().map(|mcp| mcp.view());
    mcp_refusal(definition, view.as_ref())
}

/// Fork (rule 16): a parent's MCP view narrowed to the servers named in `servers` (None: all of them). The server
/// statuses and their instructions are narrowed alike, so the child's listings never name an out-of-scope server.
fn scope_mcp_view(view: McpView, servers: Option<&[String]>) -> McpView {
    let Some(servers) = servers else {
        return view;
    };
    let keep = |name: &str| servers.iter().any(|server| server == name);
    McpView {
        servers: view
            .servers
            .into_iter()
            .filter(|server| keep(&server.name))
            .collect(),
        instructions: view
            .instructions
            .into_iter()
            .filter(|entry| keep(&entry.name))
            .collect(),
    }
}

/// Fork (rule 16): the parent's connections, narrowed to the child's `mcpServers`. The child never owns the connection
/// lifecycle, so only the view and the wait are narrowed; the calls and the waits go to the parent.
struct ScopedMcp {
    inner: Arc<dyn McpConnections>,
    servers: Vec<String>,
}

#[async_trait::async_trait]
impl McpConnections for ScopedMcp {
    fn view(&self) -> McpView {
        scope_mcp_view(self.inner.view(), Some(&self.servers))
    }

    async fn wait(
        &self,
        wait_ms: u64,
        done: &(dyn for<'v> Fn(&'v McpView) -> bool + Send + Sync),
    ) -> McpView {
        let scoped = |view: &McpView| done(&scope_mcp_view(view.clone(), Some(&self.servers)));
        scope_mcp_view(self.inner.wait(wait_ms, &scoped).await, Some(&self.servers))
    }

    fn declare_wait_tool(&self, session: &rust_cli_kernel_api::ids::SessionId) {
        self.inner.declare_wait_tool(session);
    }

    fn tool_wait_ms(&self) -> u64 {
        self.inner.tool_wait_ms()
    }

    async fn wait_for_first_connections(&self) -> bool {
        self.inner.wait_for_first_connections().await
    }
}

/// Fork: a fork child keeps the main thread's registry but loses the tools Node registers for the main session only:
/// `LSP` always (a subagent runtime has no LSP service), and under the desktop agent the tools no child of Node's
/// desktop agent has, fork or not ([`node_child_lacks`]).
pub(crate) struct ForkChildTools {
    pub(crate) inner: Arc<dyn ToolRegistry>,
    /// node_desktop: see [`node_child_lacks`].
    pub(crate) node_child: bool,
    /// The child-only tools (RespondToCoordinator); a fork child has no tools allowlist, so they are always kept.
    pub(crate) child_tools: Vec<Arc<dyn Tool>>,
}

impl ForkChildTools {
    fn keeps(&self, tool: &Arc<dyn Tool>) -> bool {
        let name = tool.name();
        name != tool_names::LSP && !(self.node_child && node_child_lacks(name))
    }
}

impl ToolRegistry for ForkChildTools {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        let mut tools: Vec<Arc<dyn Tool>> = self
            .inner
            .tools()
            .into_iter()
            .filter(|tool| self.keeps(tool))
            .collect();
        tools.extend(self.child_tools.iter().cloned());
        tools
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner
            .find(name)
            .filter(|tool| self.keeps(tool))
            .or_else(|| {
                self.child_tools
                    .iter()
                    .find(|tool| tool.name() == name)
                    .cloned()
            })
    }

    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner
            .find_for(session, name)
            .filter(|tool| self.keeps(tool))
            .or_else(|| {
                self.child_tools
                    .iter()
                    .find(|tool| tool.name() == name)
                    .cloned()
            })
    }

    fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner.withheld(name).filter(|tool| self.keeps(tool))
    }

    fn hides(&self, name: &str) -> bool {
        self.inner.hides(name)
    }

    fn keeps_order(&self) -> bool {
        self.inner.keeps_order()
    }

    fn snapshot(&self, session: &SessionId) -> ToolSnapshot {
        let snapshot = self.inner.snapshot(session);
        ToolSnapshot {
            tools: snapshot
                .tools
                .into_iter()
                .filter(|tool| self.keeps(tool))
                .chain(self.child_tools.iter().cloned())
                .collect(),
            mcp: snapshot.mcp,
        }
    }

    fn mcp(&self) -> Option<Arc<dyn McpConnections>> {
        self.inner.mcp()
    }
}

#[cfg(test)]
#[path = "toolset_tests.rs"]
mod tests;
