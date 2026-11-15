//! `/permissions` 的 DTO 往返（spec §6 规则 8，tui-manage.md §1.3）。
use super::*;
use crate::env::{EnvPath, WorkspaceRef};
use crate::ids::{EnvironmentId, SessionId};

fn round_trip<T>(value: &T) -> serde_json::Value
where
    T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug,
{
    let json = serde_json::to_value(value).unwrap();
    assert_eq!(&serde_json::from_value::<T>(json.clone()).unwrap(), value);
    json
}

#[test]
fn rule_changes_round_trip() {
    let add = RuleChange::Add {
        behavior: RuleBehavior::Ask,
        rules: vec!["Bash(rm *)".to_owned()],
    };
    assert_eq!(round_trip(&add)["type"], "add");
    let remove = RuleChange::Remove {
        rule: SourcedRule {
            source: RuleSource::LocalSettings,
            behavior: RuleBehavior::Allow,
            rule: PermissionRule {
                tool: "Read".to_owned(),
                content: None,
            },
        },
    };
    assert_eq!(round_trip(&remove)["rule"]["source"], "localSettings");
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/Users/dev/project"),
    };
    let query = PermissionRulesQuery {
        workspace: workspace.clone(),
        session: None,
    };
    assert!(round_trip(&query).get("session").is_none());
    round_trip(&PermissionRulesChange {
        workspace,
        session: Some(SessionId::new("ses_1")),
        change: add,
    });
    round_trip(&crate::store::ProjectRulesChange {
        behavior: RuleBehavior::Deny,
        add: vec![PermissionRule {
            tool: "WebFetch".to_owned(),
            content: None,
        }],
        remove: Vec::new(),
    });
}

/// 修复线 F20：执行状态是权限模式 × plan 开关（shell-permissions.md §4.6）。
#[test]
fn the_execution_state_keeps_the_mode_and_the_plan_switch_apart() {
    let guarded = ExecutionState::from(PermissionMode::Guarded);
    assert_eq!(guarded.effective(), PermissionMode::Guarded);
    // 打开 plan：判决用的模式是 plan，权限模式不变；关掉后回到原来的权限模式。
    let planning = guarded.with_plan(true);
    assert_eq!(planning.mode, PermissionMode::Guarded);
    assert_eq!(planning.effective(), PermissionMode::Plan);
    assert_eq!(planning.with_plan(false), guarded);
    // 改权限模式不动 plan。
    let bypass = planning.with_mode(PermissionMode::BypassPermissions);
    assert!(bypass.plan);
    assert_eq!(bypass.mode, PermissionMode::BypassPermissions);
    // 旧的单值写法：Plan 是“plan 开、模式不变”（没有当前值时是 default）。
    assert_eq!(
        guarded.with_mode(PermissionMode::Plan),
        ExecutionState {
            mode: PermissionMode::Guarded,
            plan: true
        }
    );
    assert_eq!(
        ExecutionState::from(PermissionMode::Plan),
        ExecutionState {
            mode: PermissionMode::Default,
            plan: true
        }
    );
    assert_eq!(
        ExecutionState::from_parts(PermissionMode::Guarded, true),
        planning
    );
    assert!(ExecutionState::from_parts(PermissionMode::Plan, false).plan);
    // serde：guarded 的名字与 Node 相同；plan 缺省为 false。
    assert_eq!(
        serde_json::to_value(PermissionMode::Guarded).unwrap(),
        "guarded"
    );
    assert_eq!(
        round_trip(&planning),
        serde_json::json!({"mode": "guarded", "plan": true})
    );
    assert_eq!(
        serde_json::from_value::<ExecutionState>(serde_json::json!({"mode": "acceptEdits"}))
            .unwrap(),
        ExecutionState::from(PermissionMode::AcceptEdits)
    );
}

/// 修复线 F20 的新命令、事件与事实（spec §6 规则 8 的序列化往返）。
#[test]
fn plan_switch_messages_round_trip() {
    use crate::session_api::{Command, KernelEvent};
    use crate::store::Fact;
    round_trip(&Command::SetPlan { enabled: true });
    round_trip(&KernelEvent::PlanChanged { enabled: false });
    round_trip(&Fact::ExecutionChanged {
        state: ExecutionState::from_parts(PermissionMode::Guarded, true),
    });
    // 旧的序列化结果（没有 plan 字段）照常能读。
    let created: crate::session_api::CreateSession = serde_json::from_value(serde_json::json!({
        "workspace": {"environment": "local", "root": "/w"},
        "selection": {"provider": "p", "model": "m"},
        "mode": "plan",
    }))
    .unwrap();
    assert!(!created.plan);
    assert_eq!(created.mode, PermissionMode::Plan);
}

/// Fork: `PermissionRule::node_default` pins Node `defaultPermissionUpdates`' content choice (PR #474
/// review): a non-blank top-level string input is the content verbatim (untrimmed); otherwise the first
/// non-blank string field in Node's order wins — blank and non-string fields fall through to the next;
/// nothing found leaves the rule whole-tool.
#[test]
fn node_default_pins_the_node_field_priority() {
    let rule = |input: serde_json::Value| PermissionRule::node_default("mcp__server__tool", &input);
    // A non-blank top-level string is the content verbatim, untrimmed.
    let top_level = rule(serde_json::json!("  ls -la  "));
    assert_eq!(top_level.tool, "mcp__server__tool");
    assert_eq!(top_level.content.as_deref(), Some("  ls -la  "));
    // A blank top-level string, and a top-level non-string, are no content (neither is an object).
    assert_eq!(rule(serde_json::json!("  ")).content, None);
    assert_eq!(rule(serde_json::json!(17)).content, None);
    // Node's order: the first non-blank field among command, url, file_path, path, pattern wins;
    // every earlier field blank (or non-string) falls through to the next one.
    const FIELDS: [&str; 5] = ["command", "url", "file_path", "path", "pattern"];
    for (blank, expected) in FIELDS.iter().enumerate() {
        let mut object = serde_json::Map::new();
        for (index, field) in FIELDS.iter().enumerate() {
            let value = if index < blank { "  " } else { *field };
            object.insert((*field).to_owned(), serde_json::json!(value));
        }
        assert_eq!(
            rule(serde_json::Value::Object(object)).content.as_deref(),
            Some(*expected),
            "the first non-blank field is {expected}"
        );
    }
    // A non-string field value is no candidate either.
    assert_eq!(
        rule(serde_json::json!({"command": 42, "url": "https://mcp.example.com"}))
            .content
            .as_deref(),
        Some("https://mcp.example.com")
    );
    // No non-blank field anywhere: the rule stays whole-tool.
    assert_eq!(rule(serde_json::json!({})).content, None);
    assert_eq!(rule(serde_json::json!({"path": " \t "})).content, None);
}

/// 模式的名字表（F58）：命令行名与 serde 的写法相同；Node 名能读回（dontAsk 记 build，读回是 default）；命令行收的名字认
/// `manual`、不认 guarded。
#[test]
fn mode_names_round_trip() {
    use PermissionMode::*;
    for mode in [
        Default,
        AcceptEdits,
        Plan,
        BypassPermissions,
        DontAsk,
        Auto,
        Guarded,
    ] {
        assert_eq!(
            serde_json::to_value(mode).unwrap(),
            serde_json::Value::String(mode.cli_name().to_owned())
        );
        let back = PermissionMode::from_node_name(mode.node_name()).unwrap();
        assert_eq!(back, if mode == DontAsk { Default } else { mode });
    }
    assert_eq!(PermissionMode::from_cli_choice("manual"), Some(Default));
    assert_eq!(PermissionMode::from_cli_choice("guarded"), None);
    assert_eq!(PermissionMode::from_node_name("default"), None);
}
