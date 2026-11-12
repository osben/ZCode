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
