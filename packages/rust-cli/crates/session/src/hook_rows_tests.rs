//! Fork: under `SessionDeps::hook_rows` a UserPromptSubmit dispatch reports its hook runs, and a blocked prompt is
//! shown and completes as a success (specs/fork-rust-agent-parity.md HK-UP-01).
use std::sync::Arc;

use rust_cli_kernel_api::hooks::{
    HookEventName, HookOutcome, HookRunOutcome, HookRunRecord, HookSourceKind,
};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserOrigin};
use rust_cli_kernel_api::session_api::{KernelEvent, SessionHandle, TurnOutcome};
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};

use crate::test_support::{ScriptedHooks, Setup, finished, submit, until};

fn run(outcome: HookRunOutcome) -> HookRunRecord {
    HookRunRecord {
        run: "run_1".into(),
        index: 0,
        outcome,
        block_reason: (outcome == HookRunOutcome::Blocked).then(|| "hooks_prompt_block".into()),
        error_message: None,
        stderr_preview: None,
        stdout_preview: None,
        started_at_ms: 10,
        duration_ms: 5,
        source_kind: HookSourceKind::User,
        plugin_name: None,
        display: "node block.js".into(),
    }
}

fn blocking() -> HookOutcome {
    HookOutcome {
        blocking_error: Some("no".into()),
        notices: vec!["UserPromptSubmit operation blocked by hook:\nno".into()],
        invocation: Some("inv_1".into()),
        runs: vec![run(HookRunOutcome::Blocked)],
        ..HookOutcome::default()
    }
}

/// The kinds of the events this change adds or orders, in log order.
fn kinds(seen: &[KernelEvent]) -> Vec<String> {
    seen.iter()
        .map(|event| {
            serde_json::to_value(event).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .filter(|kind| {
            [
                "turn_started",
                "prompt_blocked",
                "hook_invocation",
                "message_done",
                "turn_finished",
            ]
            .contains(&kind.as_str())
        })
        .collect()
}

fn setup(model: Arc<ScriptedModel>, outcome: HookOutcome, hook_rows: bool) -> Setup {
    let mut setup = Setup::new(model);
    setup.hooks = Arc::new(ScriptedHooks::with(
        HookEventName::UserPromptSubmit,
        outcome,
    ));
    setup.one_input_per_turn = true;
    setup.error_holds_queue = true;
    setup.hook_rows = hook_rows;
    setup
}

#[tokio::test]
async fn a_blocked_prompt_is_shown_with_its_hook_runs_and_completes() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["unused"])]));
    let built = setup(model.clone(), blocking(), true).build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "blocked text")).await;
    let seen = until(&mut events, finished).await;
    assert_eq!(
        kinds(&seen),
        [
            "turn_started",
            "prompt_blocked",
            "hook_invocation",
            "turn_finished"
        ]
    );
    let shown = seen.iter().find_map(|event| match event {
        KernelEvent::PromptBlocked {
            message: Message::User(user),
            ..
        } => Some(user),
        _ => None,
    });
    let shown = shown.expect("the blocked input");
    assert_eq!(shown.origin, UserOrigin::Human);
    assert_eq!(
        shown.content,
        [ContentBlock::Text {
            text: "blocked text".into()
        }]
    );
    let invocation = seen.iter().find_map(|event| match event {
        KernelEvent::HookInvocation { invocation, .. } => Some(invocation),
        _ => None,
    });
    let invocation = invocation.expect("the hook runs");
    assert_eq!(invocation.id, "inv_1");
    assert_eq!(invocation.hook_event, HookEventName::UserPromptSubmit);
    assert_eq!(invocation.runs, [run(HookRunOutcome::Blocked)]);
    assert!(matches!(
        seen.last(),
        Some(KernelEvent::TurnFinished {
            outcome: TurnOutcome::Success,
            ..
        })
    ));
    assert!(built.session.view().await.unwrap().messages.is_empty());
    assert!(model.requests().is_empty());
}

/// Node drains its queue after a blocked prompt (the turn completed), so a held queue does not stop at it.
#[tokio::test]
async fn a_blocked_prompt_does_not_hold_the_queue() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let built = setup(model, blocking(), true).build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "first")).await;
    built.session.send(submit("c2", "second")).await;
    let first = until(&mut events, finished).await;
    let second = until(&mut events, finished).await;
    for seen in [first, second] {
        assert!(matches!(
            seen.last(),
            Some(KernelEvent::TurnFinished {
                outcome: TurnOutcome::Success,
                ..
            })
        ));
    }
}

#[tokio::test]
async fn an_allowed_prompt_reports_its_hook_runs_after_its_input() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["ok"])]));
    let outcome = HookOutcome {
        invocation: Some("inv_1".into()),
        runs: vec![run(HookRunOutcome::Success)],
        ..HookOutcome::default()
    };
    let built = setup(model, outcome, true).build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "hello")).await;
    let seen = until(&mut events, finished).await;
    let kinds = kinds(&seen);
    assert_eq!(
        kinds[..3],
        ["turn_started", "message_done", "hook_invocation"]
    );
    assert!(!kinds.contains(&"prompt_blocked".to_owned()));
}

/// The TUI and `-p`: a blocked prompt fails the turn as before and nothing new is reported.
#[tokio::test]
async fn without_the_switch_a_blocked_prompt_fails_as_before() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let built = setup(model, blocking(), false).build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "blocked text")).await;
    let seen = until(&mut events, finished).await;
    assert_eq!(kinds(&seen), ["turn_started", "turn_finished"]);
    assert!(matches!(
        seen.last(),
        Some(KernelEvent::TurnFinished {
            outcome: TurnOutcome::Failed { .. },
            ..
        })
    ));
}
