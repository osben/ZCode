//! Fork: specs/fork-rust-node-helper.md F3, `helper/authorizeAppTool`.

use std::sync::Arc;

use rust_cli_kernel_api::ids::{SessionId, ToolUseId};
use rust_cli_kernel_api::orchestration::{InteractionRequest, PermissionAnswer};
use rust_cli_kernel_api::permission::PermissionRule;
use rust_cli_kernel_api::session_api::{Command, KernelEvent, SessionHandle};
use rust_cli_kernel_api::store::Fact;
use rust_cli_kernel_api::testing::ScriptedModel;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::test_support::{Setup, envelope, until};

const TOOL: &str = "mcp__plugin_viewer_view__search";

fn permission(tool_use: &str) -> InteractionRequest {
    InteractionRequest::Permission {
        origin: None,
        machine: Default::default(),
        tool_use: ToolUseId::new(tool_use),
        tool: TOOL.to_owned(),
        input: json!({"query": "q"}),
        message: "search?".to_owned(),
        suggestions: Vec::new(),
        rule_seed: None,
        asked_by: None,
        once: false,
        independent: false,
    }
}

fn asked(event: &KernelEvent) -> bool {
    matches!(event, KernelEvent::InteractionAsked { .. })
}

#[tokio::test]
async fn an_app_call_context_is_the_sessions_and_its_prompt_is_a_session_ask() {
    let built = Setup::new(Arc::new(ScriptedModel::new(Vec::new())))
        .build()
        .await;
    let session = Arc::new(built.session);
    let mut events = session.subscribe(Some(0));
    let context = session
        .app_tool_context(ToolUseId::new("tu_app"), CancellationToken::new())
        .await
        .expect("open session");
    assert_eq!(context.session, *session.id());
    assert_eq!(context.tool_use, ToolUseId::new("tu_app"));
    assert_eq!(context.workspace.root.as_str(), "/work");
    let view = context.session_ops.view().await.expect("a snapshot");
    assert!(view.selection.is_some(), "hooks read the session's model");
    // The prompt reaches the session like a background subagent's; "always allow" commits its rule.
    let asking = {
        let interactions = context.interactions.clone();
        tokio::spawn(async move { interactions.ask(permission("tu_app")).await })
    };
    let seen = until(&mut events, asked).await;
    let Some(KernelEvent::InteractionAsked { interaction, .. }) = seen.last() else {
        unreachable!()
    };
    let rule = PermissionRule {
        tool: TOOL.to_owned(),
        content: None,
    };
    let answer = PermissionAnswer::Allow {
        remember: vec![rule.clone()],
    };
    session
        .send(envelope(
            "c1",
            Command::ResolveInteraction {
                interaction: interaction.clone(),
                answer: answer.clone().into(),
            },
        ))
        .await;
    let answered = asking.await.unwrap().expect("answered");
    assert_eq!(answered.answer, answer.into());
    let facts = built.store.facts(&SessionId::new("sess_1"));
    assert!(
        facts.iter().any(|fact| matches!(
            fact,
            Fact::PermissionRulesAdded { rules, .. } if rules == &vec![rule.clone()]
        )),
        "{facts:?}"
    );
    // A withdrawn prompt ends without an answer.
    let asking = {
        let interactions = context.interactions.clone();
        tokio::spawn(async move { interactions.ask(permission("tu_app_2")).await })
    };
    until(&mut events, asked).await;
    context
        .interactions
        .cancel_ask(&ToolUseId::new("tu_app_2"))
        .await;
    assert!(asking.await.unwrap().is_err());
    assert!(session.view().await.unwrap().pending.is_empty());
}
