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

/// Fork: the dispatch is kept for the cold projection (`SessionView::hook_invocations`, HK-UP-01 Design 4): anchored
/// to the stored user message of its turn, like goal verification's `anchor_message`.
#[tokio::test]
async fn an_allowed_prompt_records_its_dispatch_for_the_view() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["ok"])]));
    let outcome = HookOutcome {
        invocation: Some("inv_1".into()),
        runs: vec![run(HookRunOutcome::Success)],
        ..HookOutcome::default()
    };
    let built = setup(model, outcome, true).build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "hello")).await;
    until(&mut events, finished).await;
    let view = built.session.view().await.unwrap();
    let prompt = view.messages[0].id().clone();
    assert_eq!(view.hook_invocations.len(), 1);
    let record = &view.hook_invocations[0];
    assert_eq!(record.anchor_message.as_ref(), Some(&prompt));
    assert_eq!(record.invocation.id, "inv_1");
    assert_eq!(
        record.invocation.hook_event,
        HookEventName::UserPromptSubmit
    );
    assert_eq!(record.invocation.runs, [run(HookRunOutcome::Success)]);
}

/// A blocked prompt's input is never stored, so its record has no anchor left and the view drops it (a cold reopen
/// loses the turn with it, as the design accepts).
#[tokio::test]
async fn a_blocked_prompt_leaves_no_record_the_view_can_anchor() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let built = setup(model, blocking(), true).build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "blocked text")).await;
    until(&mut events, finished).await;
    let view = built.session.view().await.unwrap();
    assert!(view.messages.is_empty());
    assert!(view.hook_invocations.is_empty());
}

/// A rewind that cuts its turn's messages clears the record with them.
#[tokio::test]
async fn a_rewind_of_its_turn_drops_the_recorded_dispatch() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["ok"])]));
    let outcome = HookOutcome {
        invocation: Some("inv_1".into()),
        runs: vec![run(HookRunOutcome::Success)],
        ..HookOutcome::default()
    };
    let built = setup(model, outcome, true).build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "hello")).await;
    until(&mut events, finished).await;
    let prompt = built.session.view().await.unwrap().messages[0].id().clone();
    assert_eq!(
        built.session.view().await.unwrap().hook_invocations.len(),
        1
    );
    let ack = built
        .session
        .send(crate::test_support::envelope(
            "r1",
            rust_cli_kernel_api::session_api::Command::Rewind {
                target: prompt,
                scope: rust_cli_kernel_api::session_api::RewindScope::Conversation,
            },
        ))
        .await;
    assert!(matches!(
        ack,
        rust_cli_kernel_api::session_api::Ack::Accepted { .. }
    ));
    assert!(
        built
            .session
            .view()
            .await
            .unwrap()
            .hook_invocations
            .is_empty()
    );
}

/// Fork: a SessionStart dispatch has no turn, so it waits for the session's next human turn (Node's pending
/// SessionStart rows, HK-UP-01): its row is reported when that turn starts — after its header, before its input —
/// and the view anchors the record to that turn's stored prompt. The startup title is only the test's wait for the
/// result to be held (`wait_for_startup_title` in hooks_tests).
async fn wait_for_title(session: &crate::Session, title: &str) {
    for _ in 0..500 {
        if session.view().await.unwrap().meta.title == title {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the startup title was never set");
}

async fn startup_setup(hook_rows: bool) -> crate::test_support::Built {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["ok"])]));
    let mut setup = Setup::new(model);
    setup.hooks = Arc::new(ScriptedHooks::with(
        HookEventName::SessionStart,
        HookOutcome {
            session_title: Some("startup title".into()),
            invocation: Some("inv_start".into()),
            runs: vec![run(HookRunOutcome::Success)],
            ..HookOutcome::default()
        },
    ));
    setup.hook_rows = hook_rows;
    setup.build().await
}

#[tokio::test]
async fn a_session_start_dispatch_waits_for_the_next_human_turn() {
    let built = startup_setup(true).await;
    wait_for_title(&built.session, "startup title").await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "hello")).await;
    let seen = until(&mut events, finished).await;
    assert_eq!(
        kinds(&seen)[..3],
        ["turn_started", "hook_invocation", "message_done"]
    );
    let invocation = seen
        .iter()
        .find_map(|event| match event {
            KernelEvent::HookInvocation { invocation, .. } => Some(invocation),
            _ => None,
        })
        .expect("the waiting dispatch");
    assert_eq!(invocation.id, "inv_start");
    assert_eq!(invocation.hook_event, HookEventName::SessionStart);
    assert_eq!(invocation.runs, [run(HookRunOutcome::Success)]);
    let view = built.session.view().await.unwrap();
    let [record] = view.hook_invocations.as_slice() else {
        panic!("the anchored record: {:?}", view.hook_invocations);
    };
    let prompt = view.messages[0].id().clone();
    assert_eq!(record.anchor_message.as_ref(), Some(&prompt));
}

/// The TUI and `-p` see none of it: no waiting row and no kept record.
#[tokio::test]
async fn without_the_switch_a_session_start_dispatch_reports_nothing() {
    let built = startup_setup(false).await;
    wait_for_title(&built.session, "startup title").await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "hello")).await;
    let seen = until(&mut events, finished).await;
    let kinds = kinds(&seen);
    assert!(!kinds.contains(&"hook_invocation".to_owned()), "{kinds:?}");
    assert!(
        built
            .session
            .view()
            .await
            .unwrap()
            .hook_invocations
            .is_empty()
    );
}
