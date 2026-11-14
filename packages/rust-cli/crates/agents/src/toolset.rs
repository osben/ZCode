//! 子代理的工具集（docs/specs/rust-cli/agents.md §4.2）。
//!
//! 每次取工具时按规则从主注册表过滤，不复制工具列表：主注册表是唯一来源（MCP 工具变化时子代理
//! 同样看到）。

use std::sync::Arc;

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::mcp_state::McpConnections;
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
];

/// Fork: the desktop Cron tools (Node registers them for the main session only).
const MAIN_SESSION_CRON: &[&str] = &tool_names::CRON_TOOLS;

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
    MAIN_SESSION_CRON.contains(&name) || NODE_CHILD_SUBAGENT_TOOLS.contains(&name)
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
}

impl FilteredTools {
    /// 补回的搜索工具（按清单里出现的顺序，kernel-api `tool_search::search_fallback`）；没有点名清单、或解析出的
    /// 工具里有 Bash 时为空。
    fn restored(&self, resolved: &[Arc<dyn Tool>]) -> Vec<Arc<dyn Tool>> {
        let Some(allow) = &self.rule.allow else {
            return Vec::new();
        };
        let wanted = allow
            .iter()
            .map(String::as_str)
            .filter(|name| self.rule.allows(name));
        search_fallback(resolved, wanted, |name| self.inner.withheld(name))
    }
}

impl FilteredTools {
    /// 主注册表的工具（`tools()` 或快照里的）按规则过滤、按清单排序。
    fn resolve(&self, tools: Vec<Arc<dyn Tool>>) -> Vec<Arc<dyn Tool>> {
        let pool: Vec<Arc<dyn Tool>> = tools
            .into_iter()
            .filter(|tool| self.rule.allows(tool.name()))
            .collect();
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
            mcp: snapshot.mcp,
        }
    }

    fn mcp(&self) -> Option<Arc<dyn McpConnections>> {
        self.inner.mcp()
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        if let Some(tool) = self
            .inner
            .find(name)
            .filter(|tool| self.rule.allows(tool.name()))
        {
            return Some(tool);
        }
        if !SEARCH_TOOLS.contains(&name) {
            return None;
        }
        self.tools().into_iter().find(|tool| tool.name() == name)
    }

    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        if let Some(tool) = self
            .inner
            .find_for(session, name)
            .filter(|tool| self.rule.allows(tool.name()))
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

/// Fork (node_desktop): a fork child keeps the main thread's registry without the tools no child of Node's desktop
/// agent has ([`node_child_lacks`]).
pub(crate) struct NodeChild {
    pub(crate) inner: Arc<dyn ToolRegistry>,
}

fn kept(tool: &Arc<dyn Tool>) -> bool {
    !node_child_lacks(tool.name())
}

impl ToolRegistry for NodeChild {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.inner.tools().into_iter().filter(kept).collect()
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner.find(name).filter(kept)
    }

    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner.find_for(session, name).filter(kept)
    }

    fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner.withheld(name).filter(kept)
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
            tools: snapshot.tools.into_iter().filter(kept).collect(),
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
