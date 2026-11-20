//! Node `checkAlwaysAsk` (core `permission/service.ts`): a tool that declares always-ask is asked in every mode and under
//! allow rules; only a session allow rule skips the ask, and a deny rule still denies. Tested through the chain
//! ([`PolicyGate::decide`]), not the raw decision.

use super::*;
use rust_cli_kernel_api::permission::syntax::parse_rule;
use rust_cli_kernel_api::permission::{RuleSource, SourcedRule};

const TOOL: &str = "AlwaysAskTool";

/// A tool whose own check asks, always-ask.
fn always_ask_tool(independent: bool) -> Named {
    Named(
        TOOL,
        PermissionDecision::always_ask("Confirm the always-ask tool", Vec::new(), independent),
    )
}

/// An ordinary ask from the tool's own check (not always-ask).
fn ordinary_tool() -> Named {
    Named(
        TOOL,
        PermissionDecision::ask("Confirm the ordinary tool", Vec::new()),
    )
}

/// Rules with one entry of the given source.
fn one_rule(source: RuleSource, behavior: RuleBehavior, text: &str) -> PermissionRules {
    PermissionRules {
        version: 1,
        rules: vec![SourcedRule {
            source,
            behavior,
            rule: parse_rule(text),
        }],
        ..PermissionRules::default()
    }
}

async fn decide_in(gate: &PolicyGate, tool: &Named, mode: PermissionMode) -> PermissionDecision {
    gate.decide(tool, &json!({}), &context(mode)).await
}

/// Node's always-ask ask: an ask that the tool declared and no mode or allow rule overrides.
fn is_always_ask(decision: &PermissionDecision) -> bool {
    matches!(
        decision,
        PermissionDecision::Ask {
            always_ask: true,
            ..
        }
    )
}

/// The modes that the chain decides in its own ways (bypass, guarded, plan, accept-edits, default, don't-ask).
const MODES: [PermissionMode; 6] = [
    PermissionMode::Default,
    PermissionMode::AcceptEdits,
    PermissionMode::Plan,
    PermissionMode::Guarded,
    PermissionMode::BypassPermissions,
    PermissionMode::DontAsk,
];

#[tokio::test]
async fn always_ask_asks_in_every_mode_with_no_rule() {
    // Under don't-ask the ask is turned into a denial by the outer layer (Node `dontAsk`), so only that mode differs.
    let gate = PolicyGate::default();
    let mut wrong = Vec::new();
    for mode in MODES {
        let decision = decide_in(&gate, &always_ask_tool(false), mode).await;
        let expected = if mode == PermissionMode::DontAsk {
            matches!(decision, PermissionDecision::Deny { .. })
        } else {
            is_always_ask(&decision)
        };
        if !expected {
            wrong.push(format!("{mode:?}: {decision:?}"));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

#[tokio::test]
async fn always_ask_asks_under_allow_rules_from_every_persistent_source() {
    for source in [
        RuleSource::UserSettings,
        RuleSource::ProjectSettings,
        RuleSource::LocalSettings,
        RuleSource::CliArg,
    ] {
        let gate = PolicyGate::new(one_rule(source, RuleBehavior::Allow, TOOL));
        let mut wrong = Vec::new();
        for mode in MODES {
            let decision = decide_in(&gate, &always_ask_tool(false), mode).await;
            let expected = if mode == PermissionMode::DontAsk {
                matches!(decision, PermissionDecision::Deny { .. })
            } else {
                is_always_ask(&decision)
            };
            if !expected {
                wrong.push(format!("{source:?} {mode:?}: {decision:?}"));
            }
        }
        assert!(wrong.is_empty(), "{wrong:#?}");
    }
}

#[tokio::test]
async fn a_session_allow_rule_skips_the_always_ask() {
    let gate = PolicyGate::new(one_rule(RuleSource::Session, RuleBehavior::Allow, TOOL));
    for mode in MODES {
        let decision = decide_in(&gate, &always_ask_tool(false), mode).await;
        assert!(
            matches!(decision, PermissionDecision::Allow { .. }),
            "{mode:?}: {decision:?}"
        );
    }
}

#[tokio::test]
async fn a_deny_rule_still_denies_an_always_ask_tool() {
    for source in [RuleSource::UserSettings, RuleSource::Session] {
        let gate = PolicyGate::new(one_rule(source, RuleBehavior::Deny, TOOL));
        for mode in MODES {
            let decision = decide_in(&gate, &always_ask_tool(false), mode).await;
            assert!(
                matches!(decision, PermissionDecision::Deny { .. }),
                "{source:?} {mode:?}: {decision:?}"
            );
        }
    }
}

#[tokio::test]
async fn auto_mode_denies_an_always_ask_tool_as_node_does() {
    let gate = PolicyGate::default();
    let decision = decide_in(&gate, &always_ask_tool(false), PermissionMode::Auto).await;
    assert!(
        matches!(decision, PermissionDecision::Deny { .. }),
        "{decision:?}"
    );
}

#[tokio::test]
async fn auto_mode_denies_an_always_ask_even_with_a_session_allow_rule() {
    // Node `checkAlwaysAsk`: auto mode is denied before the session allow is consulted.
    let gate = PolicyGate::new(one_rule(RuleSource::Session, RuleBehavior::Allow, TOOL));
    let decision = decide_in(&gate, &always_ask_tool(false), PermissionMode::Auto).await;
    assert!(
        matches!(decision, PermissionDecision::Deny { .. }),
        "{decision:?}"
    );
}

#[tokio::test]
async fn an_always_ask_keeps_independent_so_no_always_allow_is_offered() {
    let gate = PolicyGate::default();
    let decision = decide_in(&gate, &always_ask_tool(true), PermissionMode::Default).await;
    assert!(
        matches!(
            decision,
            PermissionDecision::Ask {
                independent: true,
                always_ask: true,
                ..
            }
        ),
        "{decision:?}"
    );
}

#[tokio::test]
async fn node_plan_mode_still_asks_an_always_ask_tool() {
    // Node `checkAlwaysAsk` precedes the plan gate: plan mode asks (it does not deny what would ask).
    let gate = PolicyGate::default().with_node_plan_mode(true);
    let decision = decide_in(&gate, &always_ask_tool(false), PermissionMode::Plan).await;
    assert!(is_always_ask(&decision), "{decision:?}");
    // The same mode with an ordinary ask is still the plan gate's denial.
    let decision = decide_in(&gate, &ordinary_tool(), PermissionMode::Plan).await;
    assert!(
        matches!(decision, PermissionDecision::Deny { .. }),
        "{decision:?}"
    );
}

#[tokio::test]
async fn a_content_deny_rule_still_denies_an_always_ask_tool() {
    // The tool has no subject, so the built-in content rules decide, with `command` as the subject.
    let gate = PolicyGate::new(one_rule(
        RuleSource::ProjectSettings,
        RuleBehavior::Deny,
        "AlwaysAskTool(forbidden)",
    ));
    let tool = always_ask_tool(false);
    let input = json!({"command": "forbidden"});
    for mode in MODES {
        let decision = gate.decide(&tool, &input, &context(mode)).await;
        assert!(
            matches!(decision, PermissionDecision::Deny { .. }),
            "{mode:?}: {decision:?}"
        );
    }
    let other = json!({"command": "other"});
    let decision = gate
        .decide(&tool, &other, &context(PermissionMode::BypassPermissions))
        .await;
    assert!(is_always_ask(&decision), "{decision:?}");
}

#[tokio::test]
async fn check_rules_keeps_the_always_ask_and_only_a_session_allow_clears_it() {
    // A PreToolUse allow is checked with `check_rules`: an always-ask comes back as an ask, and a session allow as
    // nothing to ask about.
    let tool = always_ask_tool(false);
    let decision = PolicyGate::default()
        .check_rules(
            &tool,
            &json!({}),
            &context(PermissionMode::BypassPermissions),
        )
        .await;
    assert!(
        matches!(
            decision,
            Some(PermissionDecision::Ask {
                always_ask: true,
                ..
            })
        ),
        "{decision:?}"
    );
    let session = PolicyGate::new(one_rule(RuleSource::Session, RuleBehavior::Allow, TOOL));
    let decision = session
        .check_rules(&tool, &json!({}), &context(PermissionMode::Default))
        .await;
    assert!(decision.is_none(), "{decision:?}");
}

#[tokio::test]
async fn an_ordinary_ask_still_yields_to_allow_rules_and_bypass() {
    let gate = PolicyGate::default();
    let decision = decide_in(&gate, &ordinary_tool(), PermissionMode::Default).await;
    assert!(
        matches!(
            decision,
            PermissionDecision::Ask {
                always_ask: false,
                ..
            }
        ),
        "{decision:?}"
    );
    let allowed = PolicyGate::new(one_rule(
        RuleSource::UserSettings,
        RuleBehavior::Allow,
        TOOL,
    ));
    let decision = decide_in(&allowed, &ordinary_tool(), PermissionMode::Default).await;
    assert!(
        matches!(decision, PermissionDecision::Allow { .. }),
        "{decision:?}"
    );
    let decision = decide_in(&gate, &ordinary_tool(), PermissionMode::BypassPermissions).await;
    assert!(
        matches!(decision, PermissionDecision::Allow { .. }),
        "{decision:?}"
    );
}
