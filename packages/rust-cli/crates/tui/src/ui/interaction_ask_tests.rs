//! Fork: the ask's Always allow（specs/fork-rust-agent-parity.md "Always allow without suggestions"）：选项按询问的
//! 类别给（`once` 与独立确认不给，与 Host 的 `Offered` 一致），没有建议时记住 Node `defaultPermissionUpdates`
//! 的缺省规则；建议与 Bash 的前缀种子仍然优先。

use rust_cli_kernel_api::ids::{InteractionId, ToolUseId};
use rust_cli_kernel_api::interaction::PermissionAnswer;

use rust_cli_kernel_api::orchestration::{Answer, InteractionRequest};
use rust_cli_kernel_api::permission::{PermissionMode, PermissionRule};
use rust_cli_kernel_api::testing::selection;
use serde_json::{Value, json};

use super::{ALLOW_ALWAYS, ALLOW_ONCE, ask_of, option_answer};
use crate::view::Transcript;

const TOOL: &str = "mcp__plugin_e2e-mcp-mention_mention__mention_search";

fn ask(
    input: Value,
    suggestions: Vec<PermissionRule>,
    once: bool,
    independent: bool,
) -> InteractionRequest {
    InteractionRequest::Permission {
        tool_use: ToolUseId::new("toolu_1"),
        tool: TOOL.to_owned(),
        input,
        message: "ask".to_owned(),
        suggestions,
        rule_seed: None,
        asked_by: None,
        machine: Default::default(),
        once,
        independent,
        session_allow: false,
        display: None,
        origin: None,
    }
}

fn view() -> Transcript {
    Transcript::new(
        selection(),
        PermissionMode::Default,
        crate::view::test_workspace(),
    )
}

/// The option ids of a permission ask, in order.
fn options(request: &InteractionRequest) -> Vec<String> {
    match &ask_of(&view(), &InteractionId::new("in_1"), request, None).body {
        rust_cli_tui_kit::app::widgets::asks::data::AskBody::Permission { options, .. } => {
            options.iter().map(|option| option.id.clone()).collect()
        }
        _ => panic!("not a permission ask"),
    }
}

fn remembered(request: &InteractionRequest) -> Vec<PermissionRule> {
    match option_answer(request, ALLOW_ALWAYS, None, None) {
        Some(Answer::Permission(PermissionAnswer::Allow { remember })) => remember,
        other => panic!("{other:?}"),
    }
}

/// Fork: an ask without suggestions still offers always-allow, and `allowAlways` remembers Node's default rule
/// (the tool, with a subject field as content) instead of nothing (specs/fork-rust-agent-parity.md).
#[test]
fn an_ask_without_suggestions_still_offers_always_allow() {
    let request = ask(json!({"query": "a"}), Vec::new(), false, false);
    assert_eq!(
        options(&request),
        vec![
            ALLOW_ONCE.to_owned(),
            ALLOW_ALWAYS.to_owned(),
            "fullAccess".to_owned(),
            "deny".to_owned()
        ]
    );
    assert_eq!(
        remembered(&request),
        vec![PermissionRule {
            tool: TOOL.to_owned(),
            content: None,
        }]
    );
    let with_path = ask(json!({"path": "/w/a.md"}), Vec::new(), false, false);
    assert_eq!(
        remembered(&with_path),
        vec![PermissionRule {
            tool: TOOL.to_owned(),
            content: Some("/w/a.md".to_owned()),
        }]
    );
}

/// Fork: a `once` or `independent` ask never offers always-allow, with suggestions or without (the Host's `Offered`).
#[test]
fn once_and_independent_asks_offer_no_always_allow() {
    let suggestions = vec![PermissionRule {
        tool: TOOL.to_owned(),
        content: Some("a".to_owned()),
    }];
    for (once, independent) in [(true, false), (false, true)] {
        let request = ask(
            json!({"query": "a"}),
            suggestions.clone(),
            once,
            independent,
        );
        assert_eq!(
            options(&request),
            vec![
                ALLOW_ONCE.to_owned(),
                "fullAccess".to_owned(),
                "deny".to_owned()
            ],
            "once={once} independent={independent}"
        );
    }
}

/// Suggestions win over the default rule, and a Bash seed (the edited prefix) wins over both.
#[test]
fn suggestions_and_seed_win_over_the_default_rule() {
    let suggestions = vec![
        PermissionRule {
            tool: TOOL.to_owned(),
            content: None,
        },
        PermissionRule {
            tool: TOOL.to_owned(),
            content: Some("a".to_owned()),
        },
    ];
    let request = ask(json!({"query": "a"}), suggestions.clone(), false, false);
    assert_eq!(options(&request).len(), 4);
    assert_eq!(remembered(&request), suggestions);
    let seeded = ask(json!({"command": "cargo test"}), Vec::new(), false, false);
    match option_answer(&seeded, ALLOW_ALWAYS, None, Some("cargo")).expect("answered") {
        Answer::Permission(PermissionAnswer::Allow { remember }) => assert_eq!(
            remember,
            vec![PermissionRule {
                tool: "Bash".to_owned(),
                content: Some("cargo".to_owned()),
            }]
        ),
        other => panic!("{other:?}"),
    }
}
