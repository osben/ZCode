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
    }
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
    let fork = super::NodeChild { inner: registry() };
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
    let fork = super::NodeChild {
        inner: Arc::new(Withholding(tools)),
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
