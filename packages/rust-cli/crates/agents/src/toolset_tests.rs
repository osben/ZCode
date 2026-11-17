//! 工具集的过滤（agents.md §4.2）。

use std::sync::Arc;

use rust_cli_kernel_api::orchestration::ToolRegistry;
use rust_cli_kernel_api::testing::{FakeTool, ListTools};
use rust_cli_kernel_api::tool::Tool;

use super::{FilteredTools, ToolRule};
use crate::definitions::{EXPLORE, GENERAL_PURPOSE, builtins};

/// 主线程的工具（内联与延迟加载合在一起）。
const MAIN: &[&str] = &[
    "Agent",
    "Bash",
    "Edit",
    "ListAgents",
    "Read",
    "ReportFindings",
    "ScheduleWakeup",
    "Skill",
    "ToolSearch",
    "Workflow",
    "Write",
    "CronCreate",
    "EnterWorktree",
    // 工作线 F83：前台与后台子代理都有 Monitor（agents.md §4.2）。
    "Monitor",
    "NotebookEdit",
    "SendMessage",
    "TaskStop",
    "WebFetch",
    "mcp__docs__search",
];

fn registry() -> Arc<dyn ToolRegistry> {
    let tools: Vec<Arc<dyn Tool>> = MAIN
        .iter()
        .map(|name| Arc::new(FakeTool::new(name, true, "")) as Arc<dyn Tool>)
        .collect();
    Arc::new(ListTools(tools))
}

fn names(agent: &str, background: bool) -> Vec<String> {
    let definition = builtins()
        .into_iter()
        .find(|definition| definition.agent_type == agent)
        .unwrap();
    let filtered = FilteredTools {
        inner: registry(),
        rule: ToolRule::new(&definition, background, 1),
        child_tools: Vec::new(),
    };
    filtered
        .tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect()
}

#[test]
fn general_purpose_drops_only_the_main_thread_tools() {
    assert_eq!(
        names(GENERAL_PURPOSE, false),
        [
            "Agent",
            "Bash",
            "Edit",
            "ListAgents",
            "Read",
            "ReportFindings",
            "Skill",
            "ToolSearch",
            "Write",
            "CronCreate",
            "EnterWorktree",
            "Monitor",
            "NotebookEdit",
            "SendMessage",
            "TaskStop",
            "WebFetch",
            "mcp__docs__search"
        ]
    );
}

#[test]
fn explore_is_read_only_and_background_keeps_the_async_set() {
    assert_eq!(
        names(EXPLORE, false),
        [
            "Bash",
            "ListAgents",
            "Read",
            "ReportFindings",
            "Skill",
            "ToolSearch",
            "CronCreate",
            "EnterWorktree",
            "Monitor",
            "SendMessage",
            "TaskStop",
            "WebFetch",
            "mcp__docs__search"
        ]
    );
    // A2：后台 Explore 只有 Bash、Read、Skill、ToolSearch 与延迟的 EnterWorktree、SendMessage、
    // TaskStop、WebFetch；F83 起另有 Monitor（后台白名单里有它）。
    assert_eq!(
        names(EXPLORE, true),
        [
            "Bash",
            "Read",
            "Skill",
            "ToolSearch",
            "EnterWorktree",
            "Monitor",
            "SendMessage",
            "TaskStop",
            "WebFetch",
            "mcp__docs__search"
        ]
    );
}

#[test]
fn find_respects_the_rule() {
    let definition = builtins().remove(1);
    let filtered = FilteredTools {
        inner: registry(),
        rule: ToolRule::new(&definition, false, 1),
        child_tools: Vec::new(),
    };
    assert!(filtered.find("Read").is_some());
    assert!(filtered.find("Edit").is_none());
    assert!(filtered.find("Workflow").is_none());
}

/// Agent 只看深度：后台 general-purpose 在深度 1、2 有它，深度 3 没有；前台同样。
#[test]
fn the_agent_tool_depends_on_the_depth_only() {
    let definition = builtins()
        .into_iter()
        .find(|definition| definition.agent_type == "general-purpose")
        .unwrap();
    let has_agent = |background, depth| {
        FilteredTools {
            inner: registry(),
            rule: ToolRule::new(&definition, background, depth),
            child_tools: Vec::new(),
        }
        .find("Agent")
        .is_some()
    };
    assert!(has_agent(true, 1) && has_agent(true, 2) && has_agent(false, 2));
    assert!(!has_agent(true, 3) && !has_agent(false, 3));
}

/// 主注册表：有 Bash，Glob / Grep 被它藏起来（`tools()` 里没有，`withheld` 能取回）。
struct HidingSearch(Vec<Arc<dyn Tool>>);

impl rust_cli_kernel_api::testing::RegistryOverride for HidingSearch {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.0
            .iter()
            .filter(|tool| !matches!(tool.name(), "Glob" | "Grep"))
            .cloned()
            .collect()
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        ToolRegistry::tools(self)
            .into_iter()
            .find(|tool| tool.name() == name)
    }

    fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.0
            .iter()
            .find(|tool| tool.name() == name && matches!(name, "Glob" | "Grep"))
            .cloned()
    }
}

fn custom(tools: &[&str], disallowed: &[&str]) -> FilteredTools {
    let mut definition = builtins().remove(0);
    definition.tools = Some(tools.iter().map(|name| (*name).to_owned()).collect());
    definition.disallowed_tools = disallowed.iter().map(|name| (*name).to_owned()).collect();
    let all: Vec<Arc<dyn Tool>> = ["Agent", "Bash", "Glob", "Grep", "Read", "Write"]
        .iter()
        .map(|name| Arc::new(FakeTool::new(name, true, "")) as Arc<dyn Tool>)
        .collect();
    FilteredTools {
        inner: Arc::new(HidingSearch(all)),
        rule: ToolRule::new(&definition, false, 1),
        child_tools: Vec::new(),
    }
}

fn respond_tool() -> Arc<dyn Tool> {
    Arc::new(FakeTool::new("RespondToCoordinator", true, ""))
}

/// Node gives every subagent child the coordinator port, so RespondToCoordinator is in every child's tool set,
/// whatever its `tools` allowlist says. The main thread never gets it: its registry does not hold it.
#[test]
fn every_child_gets_respond_to_coordinator_whatever_its_allowlist_says() {
    let mut foreground = custom(&["Read"], &[]);
    foreground.child_tools = vec![respond_tool()];
    assert_eq!(listed(&foreground), ["Read", "RespondToCoordinator"]);

    let definition = builtins()
        .into_iter()
        .find(|definition| definition.agent_type == EXPLORE)
        .unwrap();
    let background = FilteredTools {
        inner: registry(),
        rule: ToolRule::new(&definition, true, 1),
        child_tools: vec![respond_tool()],
    };
    assert!(
        background
            .tools()
            .iter()
            .any(|tool| tool.name() == "RespondToCoordinator")
    );
    assert!(background.find("RespondToCoordinator").is_some());
    assert!(!names(GENERAL_PURPOSE, false).contains(&"RespondToCoordinator".to_owned()));
}

#[test]
fn a_disallowed_respond_to_coordinator_is_removed() {
    let mut filtered = custom(&["Read"], &["RespondToCoordinator"]);
    filtered.child_tools = vec![respond_tool()];
    assert_eq!(listed(&filtered), ["Read"]);
}

fn listed(filtered: &FilteredTools) -> Vec<String> {
    filtered
        .tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect()
}

/// 自定义 agent 点名工具清单（agents.md §4.2 第 4 条）：
/// 子代理的工具按清单的顺序；清单点名 Glob / Grep、解析出的工具里没有 Bash 时，补回被 Bash 藏起来的它们，排在
/// 清单其余工具之后。旧代码从主注册表过滤：没有 Grep，顺序跟主注册表。
#[test]
fn a_named_tool_list_keeps_its_order_and_gets_the_hidden_search_tools_back() {
    let reviewer = custom(&["Read", "Grep"], &[]);
    assert_eq!(listed(&reviewer), ["Read", "Grep"]);
    assert!(reviewer.keeps_order());
    assert!(reviewer.find("Grep").is_some());
    assert!(reviewer.find("Glob").is_none());
    // 补回的排在清单其余工具之后（解析完清单后才补）。
    assert_eq!(
        listed(&custom(&["Grep", "Write", "Read"], &[])),
        ["Write", "Read", "Grep"]
    );
    // 清单里有 Bash：搜索交给 Bash，不补。
    let with_bash = custom(&["Grep", "Bash", "Read"], &[]);
    assert_eq!(listed(&with_bash), ["Bash", "Read"]);
    assert!(with_bash.find("Grep").is_none());
    // disallowedTools 去掉的不补。
    assert_eq!(
        listed(&custom(&["Read", "Grep", "Glob"], &["Grep"])),
        ["Read", "Glob"]
    );
}

/// 没有点名清单（`*` 或缺省）：仍是主注册表的过滤，发给模型时按名字排序。
#[test]
fn a_wildcard_tool_list_is_sorted_by_name_and_gets_nothing_back() {
    let all = custom(&["*"], &[]);
    assert!(!all.keeps_order());
    assert!(all.find("Grep").is_none());
}

/// Fork (node_desktop): a foreground subagent may ask the user; a background one and the TUI may not.
#[test]
fn a_desktop_foreground_subagent_may_ask_the_user() {
    let definition = builtins()
        .into_iter()
        .find(|definition| definition.agent_type == "general-purpose")
        .unwrap();
    let asks = |background, questions| {
        ToolRule::new(&definition, background, 1)
            .with_questions(questions)
            .allows("AskUserQuestion")
    };
    assert!(asks(false, true));
    assert!(!asks(false, false) && !asks(true, true));
}

/// Fork (node_desktop, specs/fork-rust-automations.md): Node registers the Cron tools for the main session only.
#[test]
fn a_desktop_subagent_gets_no_cron_tool() {
    let definition = builtins()
        .into_iter()
        .find(|definition| definition.agent_type == "general-purpose")
        .unwrap();
    let desktop = ToolRule::new(&definition, false, 1).node_child(true);
    for name in [
        "CronCreate",
        "CronList",
        "CronUpdate",
        "CronDelete",
        "CronPauseSelf",
    ] {
        assert!(!desktop.allows(name), "{name}");
        assert!(ToolRule::new(&definition, false, 1).allows(name), "{name}");
    }
    assert!(desktop.allows("Read"));
}

#[test]
fn a_desktop_fork_keeps_the_main_registry_without_the_cron_and_subagent_tools() {
    let fork = super::ForkChildTools {
        inner: registry(),
        node_child: true,
        child_tools: Vec::new(),
    };
    let listed: Vec<String> = fork
        .tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    let expected: Vec<&str> = MAIN
        .iter()
        .copied()
        .filter(|name| !["CronCreate", "Agent", "ListAgents", "SendMessage"].contains(name))
        .collect();
    assert_eq!(listed, expected);
    assert!(fork.find("CronCreate").is_none());
    // Node's child runtimes have no subagent port (`subagents.enabled: false`): a fork child launches no subagents.
    for name in ["Agent", "ListAgents", "SendMessage"] {
        assert!(fork.find(name).is_none(), "{name}");
    }
    let session = rust_cli_kernel_api::ids::SessionId::new("s");
    assert!(fork.find_for(&session, "CronCreate").is_none());
    assert!(
        fork.snapshot(&session)
            .tools
            .iter()
            .all(|tool| tool.name() != "CronCreate")
    );
    // The fork still sees the main thread's other tools, Workflow and ScheduleWakeup included.
    assert!(fork.find("Workflow").is_some());
}

/// Every Cron tool name (`tool_names::CRON_TOOLS`), not only the one the main fixture lists, is gone from every lookup of
/// a desktop fork, the withheld (deferred) lookup included; other withheld tools stay reachable.
#[test]
fn a_desktop_fork_withholds_none_of_the_five_cron_tools() {
    struct Withholding(Vec<Arc<dyn Tool>>);
    impl rust_cli_kernel_api::testing::RegistryOverride for Withholding {
        fn tools(&self) -> Vec<Arc<dyn Tool>> {
            self.0.clone()
        }
        fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
            self.0.iter().find(|tool| tool.name() == name).cloned()
        }
        fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
            rust_cli_kernel_api::testing::RegistryOverride::find(self, name)
        }
    }
    let cron = rust_cli_kernel_api::tool_names::CRON_TOOLS;
    let names: Vec<&str> = cron
        .iter()
        .copied()
        .chain(["Read", "ScheduleWakeup"])
        .collect();
    let tools = names
        .iter()
        .map(|name| Arc::new(FakeTool::new(name, true, "")) as Arc<dyn Tool>)
        .collect();
    let fork = super::ForkChildTools {
        inner: Arc::new(Withholding(tools)),
        node_child: true,
        child_tools: Vec::new(),
    };
    let session = rust_cli_kernel_api::ids::SessionId::new("s");
    for name in cron {
        assert!(fork.find(name).is_none(), "{name}");
        assert!(fork.find_for(&session, name).is_none(), "{name}");
        assert!(fork.withheld(name).is_none(), "{name}");
    }
    let listed: Vec<String> = fork
        .snapshot(&session)
        .tools
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert_eq!(listed, ["Read", "ScheduleWakeup"]);
    assert!(fork.withheld("Read").is_some());
}

/// specs/fork-rust-lsp.md "Tool (D2)": no subagent has `LSP`, even one whose definition names it.
#[test]
fn no_subagent_gets_the_lsp_tool() {
    for definition in builtins() {
        assert!(
            !ToolRule::new(&definition, false, 1).allows("LSP"),
            "{}",
            definition.agent_type
        );
    }
    let mut named = builtins()
        .into_iter()
        .find(|definition| definition.agent_type == GENERAL_PURPOSE)
        .unwrap();
    named.tools = Some(vec!["LSP".to_owned(), "Read".to_owned()]);
    let rule = ToolRule::new(&named, false, 1);
    assert!(!rule.allows("LSP"));
    assert!(rule.allows("Read"));
}

/// A fork child shares the main registry, whose `LSP` is offered per session: the child never sees it, and outside the
/// desktop it keeps the Cron tools.
#[test]
fn a_fork_child_never_sees_the_lsp_tool() {
    let tools: Vec<Arc<dyn Tool>> = ["Read", "LSP", "CronCreate"]
        .iter()
        .map(|name| Arc::new(FakeTool::new(name, true, "")) as Arc<dyn Tool>)
        .collect();
    let fork = super::ForkChildTools {
        inner: Arc::new(ListTools(tools)),
        node_child: false,
        child_tools: Vec::new(),
    };
    let session = rust_cli_kernel_api::ids::SessionId::new("s");
    let listed: Vec<String> = fork
        .snapshot(&session)
        .tools
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect();
    assert_eq!(listed, ["Read", "CronCreate"]);
    assert!(fork.find_for(&session, "LSP").is_none());
    assert!(fork.find("LSP").is_none());
    assert!(fork.withheld("LSP").is_none());
    assert!(fork.tools().iter().all(|tool| tool.name() != "LSP"));
}

/// Fork (node_desktop, specs/fork-rust-agent-parity.md "Subagents launch no subagents"): Node runs every child runtime
/// with `subagents.enabled: false`, so no desktop subagent has Agent, SendMessage or ListAgents, whatever its agent type,
/// background flag or `tools` list; TaskStop stays. The TUI keeps Agent and SendMessage above the depth limit.
#[test]
fn a_desktop_subagent_launches_no_subagents() {
    let gone = ["Agent", "SendMessage", "ListAgents"];
    for agent in [GENERAL_PURPOSE, EXPLORE] {
        let definition = builtins()
            .into_iter()
            .find(|definition| definition.agent_type == agent)
            .unwrap();
        for background in [false, true] {
            let desktop = FilteredTools {
                inner: registry(),
                rule: ToolRule::new(&definition, background, 1).node_child(true),
                child_tools: Vec::new(),
            };
            let listed = listed(&desktop);
            for name in gone {
                assert!(
                    !listed.iter().any(|tool| tool == name),
                    "{agent} {background} {name}"
                );
                assert!(desktop.find(name).is_none(), "{agent} {background} {name}");
            }
        }
    }
    // A `tools` list that names them does not bring them back.
    let mut named = builtins().remove(0);
    named.tools = Some(
        ["Agent", "SendMessage", "ListAgents", "TaskStop", "Read"]
            .iter()
            .map(|name| (*name).to_owned())
            .collect(),
    );
    let desktop = FilteredTools {
        inner: registry(),
        rule: ToolRule::new(&named, false, 1).node_child(true),
        child_tools: Vec::new(),
    };
    assert_eq!(listed(&desktop), ["TaskStop", "Read"]);
    // The TUI: a general-purpose subagent below the depth limit still has them.
    let general = builtins()
        .into_iter()
        .find(|definition| definition.agent_type == GENERAL_PURPOSE)
        .unwrap();
    let tui = ToolRule::new(&general, false, 1);
    assert!(tui.allows("Agent") && tui.allows("SendMessage"));
    assert!(ToolRule::new(&named, false, 1).allows("Agent"));
}

// Fork (rule 16, specs/fork-rust-subagent-runtime-config.md): `mcpServers` scopes the child to the named parent servers.

/// A parent registry with the Read tool and two MCP servers (`docs`, `other`), exposed through its MCP view.
struct ScopedRegistry {
    inner: Arc<dyn ToolRegistry>,
    mcp: Arc<StaticMcp>,
}

/// A fixed MCP view: the servers given, no instructions.
struct StaticMcp(rust_cli_kernel_api::mcp_state::McpView);

#[async_trait::async_trait]
impl rust_cli_kernel_api::mcp_state::McpConnections for StaticMcp {
    fn view(&self) -> rust_cli_kernel_api::mcp_state::McpView {
        self.0.clone()
    }

    async fn wait(
        &self,
        _wait_ms: u64,
        _done: &(dyn for<'v> Fn(&'v rust_cli_kernel_api::mcp_state::McpView) -> bool + Send + Sync),
    ) -> rust_cli_kernel_api::mcp_state::McpView {
        self.0.clone()
    }

    fn declare_wait_tool(&self, _session: &rust_cli_kernel_api::ids::SessionId) {}

    fn tool_wait_ms(&self) -> u64 {
        0
    }
}

impl ToolRegistry for ScopedRegistry {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.inner.tools()
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner.find(name)
    }

    fn find_for(
        &self,
        session: &rust_cli_kernel_api::ids::SessionId,
        name: &str,
    ) -> Option<Arc<dyn Tool>> {
        self.inner.find_for(session, name)
    }

    fn snapshot(
        &self,
        session: &rust_cli_kernel_api::ids::SessionId,
    ) -> rust_cli_kernel_api::orchestration::ToolSnapshot {
        self.inner.snapshot(session)
    }

    fn withheld(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.inner.withheld(name)
    }

    fn hides(&self, name: &str) -> bool {
        self.inner.hides(name)
    }

    fn keeps_order(&self) -> bool {
        self.inner.keeps_order()
    }

    fn mcp(&self) -> Option<Arc<dyn rust_cli_kernel_api::mcp_state::McpConnections>> {
        Some(self.mcp.clone())
    }
}

fn scoped_registry() -> Arc<dyn ToolRegistry> {
    let tools: Vec<Arc<dyn Tool>> = ["Read", "mcp__docs__search", "mcp__other__lookup"]
        .iter()
        .map(|name| Arc::new(FakeTool::new(name, true, "")) as Arc<dyn Tool>)
        .collect();
    let server = |name: &str| rust_cli_kernel_api::mcp_state::McpServerView {
        name: name.to_owned(),
        state: rust_cli_kernel_api::manage::McpServerState::Connected,
        reconnecting: false,
    };
    Arc::new(ScopedRegistry {
        inner: Arc::new(ListTools(tools)),
        mcp: Arc::new(StaticMcp(rust_cli_kernel_api::mcp_state::McpView {
            servers: vec![server("docs"), server("other")],
            instructions: Vec::new(),
        })),
    })
}

fn mcp_scoped_child(servers: Option<&[&str]>, tools: Option<&[&str]>) -> FilteredTools {
    let mut definition = builtins().remove(0);
    definition.tools = tools.map(|tools| tools.iter().map(|name| (*name).to_owned()).collect());
    definition.mcp_servers =
        servers.map(|servers| servers.iter().map(|name| (*name).to_owned()).collect());
    FilteredTools {
        inner: scoped_registry(),
        rule: ToolRule::new(&definition, false, 1),
        child_tools: Vec::new(),
    }
}

fn tool_names_of(filtered: &FilteredTools) -> Vec<String> {
    filtered
        .tools()
        .iter()
        .map(|tool| tool.name().to_owned())
        .collect()
}

#[test]
fn a_scoped_child_sees_only_the_tools_of_its_servers() {
    let names = tool_names_of(&mcp_scoped_child(Some(&["docs"]), None));
    assert!(names.contains(&"mcp__docs__search".to_owned()), "{names:?}");
    assert!(names.contains(&"Read".to_owned()), "{names:?}");
    assert!(
        !names.contains(&"mcp__other__lookup".to_owned()),
        "{names:?}"
    );
}

#[test]
fn a_scoped_child_with_a_tool_list_keeps_the_list_inside_its_servers() {
    let names = tool_names_of(&mcp_scoped_child(
        Some(&["docs"]),
        Some(&["mcp__other__lookup", "mcp__docs__search"]),
    ));
    assert_eq!(names, vec!["mcp__docs__search".to_owned()]);
}

#[test]
fn an_unscoped_child_sees_every_server() {
    let names = tool_names_of(&mcp_scoped_child(None, None));
    assert!(
        names.contains(&"mcp__other__lookup".to_owned()),
        "{names:?}"
    );
    assert!(names.contains(&"mcp__docs__search".to_owned()), "{names:?}");
}

#[test]
fn an_empty_server_list_is_not_a_scope() {
    let names = tool_names_of(&mcp_scoped_child(Some(&[]), None));
    assert!(
        names.contains(&"mcp__other__lookup".to_owned()),
        "{names:?}"
    );
}

#[test]
fn a_scoped_child_mcp_view_lists_only_its_servers() {
    let filtered = mcp_scoped_child(Some(&["docs"]), None);
    let view = filtered.mcp().expect("the parent's MCP connections").view();
    let names: Vec<&str> = view
        .servers
        .iter()
        .map(|server| server.name.as_str())
        .collect();
    assert_eq!(names, vec!["docs"]);
}

#[test]
fn a_listed_server_that_is_not_connected_refuses_the_start() {
    let mut definition = builtins().remove(0);
    definition.mcp_servers = Some(vec!["docs".to_owned(), "gone".to_owned()]);
    let view = scoped_registry().mcp().expect("connections").view();
    assert_eq!(
        super::mcp_refusal(&definition, Some(&view)),
        Some("Required MCP server is not connected: gone".to_owned())
    );
    definition.mcp_servers = Some(vec!["docs".to_owned()]);
    assert_eq!(super::mcp_refusal(&definition, Some(&view)), None);
    definition.mcp_servers = None;
    assert_eq!(super::mcp_refusal(&definition, None), None);
}

// Fork (rule 17): a child with a `skills` list gets the Skill tool, even when its `tools` list omits it.
#[test]
fn a_child_with_a_skills_list_is_offered_the_skill_tool() {
    let mut definition = builtins().remove(0);
    definition.tools = Some(vec!["Read".to_owned()]);
    definition.skills = Some(vec!["review".to_owned()]);
    let filtered = FilteredTools {
        inner: registry(),
        rule: ToolRule::new(&definition, false, 1),
        child_tools: Vec::new(),
    };
    let names = tool_names_of(&filtered);
    assert_eq!(names, vec!["Read".to_owned(), "Skill".to_owned()]);
    definition.skills = None;
    let filtered = FilteredTools {
        inner: registry(),
        rule: ToolRule::new(&definition, false, 1),
        child_tools: Vec::new(),
    };
    assert_eq!(tool_names_of(&filtered), vec!["Read".to_owned()]);
}
