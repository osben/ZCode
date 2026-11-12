//! Fork: Node's plan gate for MCP tools (`checkPlanMode`, specs/fork-rust-agent-parity.md, "MCP tools in plan mode").

use super::*;
use rust_cli_kernel_api::mcp::McpToolInfo;

const LOOKUP: &str = "mcp__plan__lookup";

/// An MCP tool with the given annotations; its own check has no opinion (like the real MCP tool).
struct Mcp {
    info: McpToolInfo,
    read_only: bool,
    destructive: bool,
}

fn mcp(read_only: bool, destructive: bool) -> Mcp {
    Mcp {
        info: McpToolInfo {
            server: "plan".to_owned(),
            tool: "lookup".to_owned(),
            always_load: false,
        },
        read_only,
        destructive,
    }
}

#[async_trait]
impl Tool for Mcp {
    fn name(&self) -> &str {
        LOOKUP
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn description(&self, _context: &rust_cli_kernel_api::tool::PromptContext) -> String {
        String::new()
    }
    fn is_read_only(&self, _input: &Value) -> bool {
        self.read_only
    }
    fn is_destructive(&self, _input: &Value) -> bool {
        self.destructive
    }
    fn mcp_info(&self) -> Option<&McpToolInfo> {
        Some(&self.info)
    }
    async fn call(
        &self,
        _input: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        Err(ToolError::Unsupported {
            what: "test".to_owned(),
        })
    }
}

async fn plan(gate: &PolicyGate, tool: &Mcp) -> PermissionDecision {
    gate.decide(tool, &json!({}), &context(PermissionMode::Plan))
        .await
}

fn node_plan(rule: Option<RuleBehavior>) -> PolicyGate {
    match rule {
        Some(behavior) => PolicyGate::new(rules(&[(behavior, LOOKUP)])),
        None => PolicyGate::default(),
    }
    .with_node_plan_mode(true)
}

/// (`once`, `independent`, suggestion count) of an ask.
fn asked(decision: &PermissionDecision) -> (bool, bool, usize) {
    match decision {
        PermissionDecision::Ask {
            once,
            independent,
            suggestions,
            ..
        } => (*once, *independent, suggestions.len()),
        other => panic!("not ask: {other:?}"),
    }
}

#[tokio::test]
/// The ask is independent (allow once and deny only), not `once`: Node sets no `approvalMode: "user-once"` on it, so
/// PermissionRequest hooks still run.
async fn a_tool_that_is_not_read_only_asks_even_with_an_allow_rule() {
    for gate in [node_plan(None), node_plan(Some(RuleBehavior::Allow))] {
        assert_eq!(
            asked(&plan(&gate, &mcp(false, false)).await),
            (false, true, 0)
        );
    }
}

/// B3: the plan gate's ask is an independent confirmation (Node `optionsPolicy: "no-always-allow"`), so the App offers
/// no permission mode switch for it; an ask from a whole-tool ask rule is not one.
#[tokio::test]
async fn the_plan_gate_ask_is_an_independent_confirmation() {
    let independent = |decision: &PermissionDecision| match decision {
        PermissionDecision::Ask { independent, .. } => *independent,
        other => panic!("not ask: {other:?}"),
    };
    assert!(independent(
        &plan(&node_plan(None), &mcp(false, false)).await
    ));
    let rule = node_plan(Some(RuleBehavior::Ask));
    assert!(!independent(&plan(&rule, &mcp(false, false)).await));
}

#[tokio::test]
async fn a_destructive_tool_is_denied_with_the_node_reason_even_with_an_allow_rule() {
    for gate in [node_plan(None), node_plan(Some(RuleBehavior::Allow))] {
        for read_only in [false, true] {
            assert_eq!(
                plan(&gate, &mcp(read_only, true)).await,
                deny(texts::PLAN_MODE_READ_ONLY)
            );
        }
    }
}

#[tokio::test]
async fn rules_come_before_the_plan_gate() {
    assert_eq!(
        plan(&node_plan(Some(RuleBehavior::Deny)), &mcp(false, false)).await,
        deny(texts::tool_denied(LOOKUP))
    );
    // A whole-tool ask rule asks with the normal options, even for a destructive tool (Node `rule.project.ask`).
    let gate = node_plan(Some(RuleBehavior::Ask));
    for tool in [mcp(false, false), mcp(false, true)] {
        let (once, independent, _) = asked(&plan(&gate, &tool).await);
        assert!(!once && !independent);
    }
}

#[tokio::test]
async fn a_read_only_tool_follows_the_allow_rules_and_otherwise_asks_normally() {
    assert_eq!(
        plan(&node_plan(Some(RuleBehavior::Allow)), &mcp(true, false)).await,
        allow()
    );
    let (once, independent, _) = asked(&plan(&node_plan(None), &mcp(true, false)).await);
    assert!(!once && !independent);
}

#[tokio::test]
async fn with_no_one_to_answer_the_plan_ask_is_denied() {
    let base = rust_cli_kernel_api::permission::PermissionRules {
        avoid_prompts: true,
        ..Default::default()
    };
    let gate = PolicyGate::new(base).with_node_plan_mode(true);
    assert!(matches!(
        plan(&gate, &mcp(false, false)).await,
        PermissionDecision::Deny { .. }
    ));
}

#[tokio::test]
async fn other_tools_keep_the_node_plan_denial_and_other_modes_are_unchanged() {
    let gate = node_plan(None);
    assert_eq!(
        bash(&gate, PermissionMode::Plan, "touch plan.txt").await,
        deny(texts::PLAN_MODE_READ_ONLY)
    );
    // Outside plan mode a destructive MCP tool asks as before.
    let decision = gate
        .decide(
            &mcp(false, true),
            &json!({}),
            &context(PermissionMode::Default),
        )
        .await;
    assert_eq!(asked(&decision), (false, false, 0));
}

/// Plan over the given base mode (Node `context.mode` with `planEnabled`).
async fn plan_over(gate: &PolicyGate, tool: &Mcp, base: PermissionMode) -> PermissionDecision {
    let context = ToolUseContext {
        base_mode: base,
        ..context(PermissionMode::Plan)
    };
    gate.decide(tool, &json!({}), &context).await
}

const BYPASS_BASES: [PermissionMode; 2] =
    [PermissionMode::BypassPermissions, PermissionMode::Guarded];

/// Node `checkPlanMode`: over a yolo or guarded base, a non-destructive MCP tool passes the gate and `mode.yolo`
/// allows it, read-only or not.
#[tokio::test]
async fn plan_over_a_bypass_base_allows_a_non_destructive_tool() {
    for base in BYPASS_BASES {
        for read_only in [false, true] {
            assert_eq!(
                plan_over(&node_plan(None), &mcp(read_only, false), base).await,
                allow(),
                "{base:?} read_only={read_only}"
            );
        }
    }
}

/// Deny and ask rules come before the gate, and a destructive tool is still denied, over any base.
#[tokio::test]
async fn plan_over_a_bypass_base_keeps_rules_and_the_destructive_denial() {
    for base in BYPASS_BASES {
        assert_eq!(
            plan_over(
                &node_plan(Some(RuleBehavior::Deny)),
                &mcp(false, false),
                base
            )
            .await,
            deny(texts::tool_denied(LOOKUP))
        );
        let (once, independent, _) = asked(
            &plan_over(
                &node_plan(Some(RuleBehavior::Ask)),
                &mcp(false, false),
                base,
            )
            .await,
        );
        assert!(!once && !independent, "{base:?}");
        for gate in [node_plan(None), node_plan(Some(RuleBehavior::Allow))] {
            assert_eq!(
                plan_over(&gate, &mcp(false, true), base).await,
                deny(texts::PLAN_MODE_READ_ONLY)
            );
        }
    }
}

/// Plan over a default or accept-edits base keeps the plan gate's independent ask.
#[tokio::test]
async fn plan_over_another_base_still_asks() {
    for base in [PermissionMode::Default, PermissionMode::AcceptEdits] {
        assert_eq!(
            asked(&plan_over(&node_plan(None), &mcp(false, false), base).await),
            (false, true, 0)
        );
    }
}

/// A built-in read-only tool: its own check gives `own`, its subject comes from the test helper.
struct ReadOnly(&'static str, PermissionDecision);

#[async_trait]
impl Tool for ReadOnly {
    fn name(&self) -> &str {
        self.0
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn description(&self, _context: &rust_cli_kernel_api::tool::PromptContext) -> String {
        String::new()
    }
    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }
    fn permission_subject(
        &self,
        input: &Value,
    ) -> Option<rust_cli_kernel_api::permission::PermissionSubject> {
        crate::test_support::subject_of(self.0, input)
    }
    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        self.1.clone()
    }
    async fn call(
        &self,
        _input: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        Err(ToolError::Unsupported {
            what: "test".to_owned(),
        })
    }
}

/// WebFetch to a URL no rule names (passthrough) and WebSearch (its own check asks, like the real tool).
fn web_tools() -> [(ReadOnly, Value); 2] {
    [
        (
            ReadOnly("WebFetch", PermissionDecision::Passthrough),
            json!({"url": "https://example.org/a"}),
        ),
        (
            ReadOnly("WebSearch", PermissionDecision::ask("Search?", Vec::new())),
            json!({"query": "q"}),
        ),
    ]
}

async fn read_only_over(
    gate: &PolicyGate,
    tool: &ReadOnly,
    input: &Value,
    base: PermissionMode,
) -> PermissionDecision {
    let context = ToolUseContext {
        base_mode: base,
        ..context(PermissionMode::Plan)
    };
    gate.decide(tool, input, &context).await
}

/// Node `checkPlanMode`: a read-only, non-destructive built-in tool passes the gate and the yolo or guarded base allows
/// it; an ask rule still asks the user with the normal options.
#[tokio::test]
async fn plan_over_a_bypass_base_allows_built_in_read_only_tools() {
    for base in BYPASS_BASES {
        for (tool, input) in web_tools() {
            assert_eq!(
                read_only_over(
                    &PolicyGate::default().with_node_plan_mode(true),
                    &tool,
                    &input,
                    base
                )
                .await,
                allow(),
                "{} over {base:?}",
                tool.0
            );
            let gate =
                PolicyGate::new(rules(&[(RuleBehavior::Ask, tool.0)])).with_node_plan_mode(true);
            let (once, independent, _) = asked(&read_only_over(&gate, &tool, &input, base).await);
            assert!(!once && !independent, "{} over {base:?}", tool.0);
            let gate =
                PolicyGate::new(rules(&[(RuleBehavior::Deny, tool.0)])).with_node_plan_mode(true);
            assert_eq!(
                read_only_over(&gate, &tool, &input, base).await,
                deny(texts::tool_denied(tool.0))
            );
        }
    }
}

/// Node `checkPlanMode` passes a read-only, non-destructive tool over any base, and `checkBuildMode` then asks when it
/// needs approval (`mode.build.sideEffect`): over a default or accept-edits base the plan gate no longer denies it.
/// WebSearch is allowed in Node (`needsApproval: false`) but asks in Rust in any mode (known gap, see the spec).
#[tokio::test]
async fn plan_over_a_default_base_asks_for_built_in_read_only_tools() {
    for base in [PermissionMode::Default, PermissionMode::AcceptEdits] {
        for (tool, input) in web_tools() {
            let gate = PolicyGate::default().with_node_plan_mode(true);
            let (once, independent, _) = asked(&read_only_over(&gate, &tool, &input, base).await);
            assert!(!once && !independent, "{} over {base:?}", tool.0);
            let gate =
                PolicyGate::new(rules(&[(RuleBehavior::Deny, tool.0)])).with_node_plan_mode(true);
            assert_eq!(
                read_only_over(&gate, &tool, &input, base).await,
                deny(texts::tool_denied(tool.0))
            );
            let gate =
                PolicyGate::new(rules(&[(RuleBehavior::Allow, tool.0)])).with_node_plan_mode(true);
            assert_eq!(read_only_over(&gate, &tool, &input, base).await, allow());
        }
    }
    // A view whose base is plan itself (a subagent, the fallback view) keeps the plan gate's denial.
    for (tool, input) in web_tools() {
        let gate = PolicyGate::default().with_node_plan_mode(true);
        assert_eq!(
            read_only_over(&gate, &tool, &input, PermissionMode::Plan).await,
            deny(texts::PLAN_MODE_READ_ONLY),
            "{}",
            tool.0
        );
    }
}

/// Node checks no file path before the plan gate, and yolo or guarded then allows: a Read outside the workspace (a
/// secret included) under plan over a bypass base is allowed, as without plan. Over a default base it asks.
#[tokio::test]
async fn plan_over_a_bypass_base_reads_any_path() {
    let gate = PolicyGate::default().with_node_plan_mode(true);
    let read = ReadOnly("Read", PermissionDecision::Passthrough);
    for path in ["/home/u/.ssh/id_rsa", "/w/.env", "/etc/hosts"] {
        let input = json!({"file_path": path});
        for base in BYPASS_BASES {
            assert_eq!(
                read_only_over(&gate, &read, &input, base).await,
                allow(),
                "{path} over {base:?}"
            );
        }
    }
    let (once, independent, _) = asked(
        &read_only_over(
            &gate,
            &read,
            &json!({"file_path": "/home/u/.ssh/id_rsa"}),
            PermissionMode::Default,
        )
        .await,
    );
    assert!(!once && !independent);
}

/// Read-only Bash, Read and Grep that plan already allows keep their result over any base.
#[tokio::test]
async fn plan_over_a_bypass_base_keeps_read_only_shell_and_file_tools() {
    let gate = PolicyGate::default().with_node_plan_mode(true);
    let calls = [
        ("Bash", json!({"command": "ls"})),
        ("Read", json!({"file_path": "/w/a.txt"})),
        ("Grep", json!({"pattern": "x", "path": "/w"})),
    ];
    for (name, input) in calls {
        let tool = ReadOnly(name, PermissionDecision::Passthrough);
        let plain = read_only_over(&gate, &tool, &input, PermissionMode::Plan).await;
        assert_eq!(plain, allow(), "{name} under plan");
        for base in BYPASS_BASES
            .into_iter()
            .chain([PermissionMode::Default, PermissionMode::AcceptEdits])
        {
            assert_eq!(
                read_only_over(&gate, &tool, &input, base).await,
                plain,
                "{name} over {base:?}"
            );
        }
    }
}
