//! Fork: content rules on a tool with no permission subject, such as an MCP tool (Node `ruleSubjects` /
//! `matchesRuleContent`, specs/fork-rust-agent-parity.md, "Content rules on MCP tools").

use super::*;

const SEARCH: &str = "mcp__docs__search";

async fn decide(entries: &[(RuleBehavior, &str)], input: Value) -> PermissionDecision {
    let gate = PolicyGate::new(rules(entries));
    let tool = Named(SEARCH, PermissionDecision::Passthrough);
    gate.decide(&tool, &input, &context(PermissionMode::Default))
        .await
}

fn allowed(decision: &PermissionDecision) -> bool {
    matches!(decision, PermissionDecision::Allow { .. })
}

#[tokio::test]
async fn an_allow_rule_matches_the_path_it_names_and_no_other() {
    let rule = [(RuleBehavior::Allow, "mcp__docs__search(/a)")];
    assert!(allowed(&decide(&rule, json!({"path": "/a"})).await));
    assert!(matches!(
        decide(&rule, json!({"path": "/b"})).await,
        PermissionDecision::Ask { .. }
    ));
    // No subject field: a content rule never matches.
    assert!(matches!(
        decide(&rule, json!({"query": "/a"})).await,
        PermissionDecision::Ask { .. }
    ));
}

#[tokio::test]
async fn the_subject_is_the_first_string_field_in_nodes_order() {
    let rule = [(RuleBehavior::Allow, "mcp__docs__search(git status)")];
    let input = json!({"path": "/a", "command": "git status"});
    assert!(allowed(&decide(&rule, input).await));
    let patch = [(RuleBehavior::Allow, "mcp__docs__search(*** Begin Patch*)")];
    assert!(allowed(
        &decide(&patch, json!({"patch_text": "*** Begin Patch x"})).await
    ));
    let text = [(RuleBehavior::Allow, "mcp__docs__search(hello)")];
    assert!(allowed(&decide(&text, json!("hello")).await));
}

#[tokio::test]
async fn prefix_and_wildcard_contents_match_like_node() {
    let prefix = [(RuleBehavior::Allow, "mcp__docs__search(npm run:*)")];
    assert!(allowed(
        &decide(&prefix, json!({"command": "npm run"})).await
    ));
    assert!(allowed(
        &decide(&prefix, json!({"command": "npm run build"})).await
    ));
    assert!(!allowed(
        &decide(&prefix, json!({"command": "npm runner"})).await
    ));
    // Node's `.*` has no `s` flag: a `*` never spans a line terminator.
    for multiline in [
        "*** Begin Patch\nx",
        "*** Begin Patch\rx",
        "*** Begin Patch\u{2028}x",
    ] {
        let patch = [(RuleBehavior::Allow, "mcp__docs__search(*** Begin Patch*)")];
        assert!(!allowed(
            &decide(&patch, json!({"patch_text": multiline})).await
        ));
    }
    let middle = [(RuleBehavior::Allow, "mcp__docs__search(a*b*c)")];
    assert!(allowed(&decide(&middle, json!({"command": "a1b2c"})).await));
    assert!(!allowed(
        &decide(&middle, json!({"command": "a\nb2c"})).await
    ));
    assert!(!allowed(
        &decide(&middle, json!({"command": "a1b\u{2029}c"})).await
    ));
    // `x:*` is `startsWith`, which does cross lines.
    let prefix = [(RuleBehavior::Allow, "mcp__docs__search(git:*)")];
    assert!(allowed(
        &decide(&prefix, json!({"command": "git a\nb"})).await
    ));
    let wildcard = [(RuleBehavior::Allow, "mcp__docs__search(/docs/*.md)")];
    assert!(allowed(
        &decide(&wildcard, json!({"path": "/docs/a/b.md"})).await
    ));
    assert!(!allowed(
        &decide(&wildcard, json!({"path": "/docs/a.txt"})).await
    ));
}

#[tokio::test]
async fn a_content_deny_beats_a_whole_tool_allow_and_a_content_ask_asks() {
    let deny = [
        (RuleBehavior::Allow, SEARCH),
        (RuleBehavior::Deny, "mcp__docs__search(/secret)"),
    ];
    assert!(matches!(
        decide(&deny, json!({"path": "/secret"})).await,
        PermissionDecision::Deny { .. }
    ));
    assert!(allowed(&decide(&deny, json!({"path": "/open"})).await));
    let ask = [
        (RuleBehavior::Allow, SEARCH),
        (RuleBehavior::Ask, "mcp__docs__search(/careful)"),
    ];
    assert!(matches!(
        decide(&ask, json!({"path": "/careful"})).await,
        PermissionDecision::Ask { .. }
    ));
}
