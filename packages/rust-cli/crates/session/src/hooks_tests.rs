use std::sync::Arc;

use rust_cli_kernel_api::hooks::{HookEventName, HookOutcome};
use rust_cli_kernel_api::message::{ContentBlock, Message, UserMessage, UserOrigin};
use rust_cli_kernel_api::session_api::{
    Command, EndReason, KernelEvent, SessionHandle, StartSource, TurnOutcome,
};
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};
use tokio::sync::Notify;

use crate::test_support::{ScriptedHooks, Setup, envelope, finished, submit, until};

fn meta_message(id: &str, text: &str) -> Message {
    Message::User(UserMessage {
        stall_execution: None,
        intent: None,
        id: rust_cli_kernel_api::ids::MessageId::new(id),
        content: vec![ContentBlock::Text { text: text.into() }],
        origin: UserOrigin::Meta {
            source: "hook_additional_context".into(),
        },
    })
}

fn texts(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .filter_map(|message| match message {
            Message::User(user) => match user.content.first() {
                Some(ContentBlock::Text { text }) => Some(text.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// 阻塞：不提交输入、不调模型，回合以 hook 的说明失败。
#[tokio::test]
async fn a_blocking_prompt_hook_keeps_the_input_out() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["unused"])]));
    let hooks = ScriptedHooks::with(
        HookEventName::UserPromptSubmit,
        HookOutcome {
            blocking_error: Some("no".into()),
            notices: vec!["UserPromptSubmit operation blocked by hook:\nno".into()],
            ..HookOutcome::default()
        },
    );
    let mut setup = Setup::new(model.clone());
    setup.hooks = Arc::new(hooks);
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "secret")).await;
    let seen = until(&mut events, finished).await;
    assert!(matches!(
        seen.last(),
        Some(KernelEvent::TurnFinished { outcome: TurnOutcome::Failed { message, .. }, .. })
            if message.starts_with("UserPromptSubmit operation blocked by hook:")
    ));
    assert!(built.session.view().await.unwrap().messages.is_empty());
    assert!(model.requests().is_empty());
}

fn titles(seen: &[KernelEvent]) -> Vec<(String, rust_cli_kernel_api::title::Source)> {
    seen.iter()
        .filter_map(|event| match event {
            KernelEvent::TitleChanged { title, source } => Some((title.clone(), *source)),
            _ => None,
        })
        .collect()
}

/// Fork: the admission's stored title reaches the actor before the input (Node `SessionTitleUpdated` at the
/// persistence). A hook that blocks the input leaves it, and the next committed input keeps it, as the store's
/// compare-and-set on `default` does.
#[tokio::test]
async fn the_admitted_title_stays_through_a_blocked_input_and_the_next_commit() {
    use rust_cli_kernel_api::title::Source;
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["ok"])]));
    let hooks = Arc::new(ScriptedHooks::with(
        HookEventName::UserPromptSubmit,
        HookOutcome {
            blocking_error: Some("no".into()),
            ..HookOutcome::default()
        },
    ));
    let mut setup = Setup::new(model);
    setup.hooks = hooks.clone();
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built
        .session
        .send(envelope(
            "c1#title",
            Command::AdoptTitle {
                title: "fix a.ts now".into(),
            },
        ))
        .await;
    built
        .session
        .send(submit("c1", "fix [a.ts](./src/a.ts) now"))
        .await;
    let seen = until(&mut events, finished).await;
    assert_eq!(
        titles(&seen),
        vec![("fix a.ts now".to_owned(), Source::FirstInput)]
    );
    hooks.set(HookEventName::UserPromptSubmit, HookOutcome::default());
    built.session.send(submit("c2", "something else")).await;
    let seen = until(&mut events, finished).await;
    assert!(titles(&seen).is_empty(), "{seen:?}");
    let view = built.session.view().await.unwrap();
    assert_eq!(view.meta.title, "fix a.ts now");
    assert_eq!(view.title_source, Some(Source::FirstInput));
}

/// Fork: a rename that reached the actor before the admission's title wins.
#[tokio::test]
async fn an_admitted_title_does_not_replace_a_rename() {
    let model = Arc::new(ScriptedModel::new(vec![]));
    let built = Setup::new(model).build().await;
    built
        .session
        .send(envelope(
            "r1",
            Command::Rename {
                title: "Mine".into(),
            },
        ))
        .await;
    built
        .session
        .send(envelope(
            "c1#title",
            Command::AdoptTitle { title: "hi".into() },
        ))
        .await;
    let view = built.session.view().await.unwrap();
    assert_eq!(view.meta.title, "Mine");
    assert_eq!(
        view.title_source,
        Some(rust_cli_kernel_api::title::Source::Custom)
    );
}

/// prevent：提交输入与 hook 消息，不调模型；正常：hook 消息跟在输入后面一起发给模型。
#[tokio::test]
async fn prompt_hook_messages_follow_the_input() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["ok"])]));
    let hooks = Arc::new(ScriptedHooks::with(
        HookEventName::UserPromptSubmit,
        HookOutcome {
            prevent_continuation: true,
            messages: vec![meta_message("msg_h1", "Operation stopped by hook")],
            ..HookOutcome::default()
        },
    ));
    let mut setup = Setup::new(model.clone());
    setup.hooks = hooks.clone();
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "first")).await;
    let seen = until(&mut events, finished).await;
    assert!(matches!(
        seen.last(),
        Some(KernelEvent::TurnFinished {
            outcome: TurnOutcome::Success,
            ..
        })
    ));
    assert!(model.requests().is_empty());
    hooks.set(
        HookEventName::UserPromptSubmit,
        HookOutcome {
            messages: vec![meta_message("msg_h2", "extra context")],
            session_title: Some("Named".into()),
            ..HookOutcome::default()
        },
    );
    built.session.send(submit("c2", "second")).await;
    let seen = until(&mut events, finished).await;
    assert!(
        seen.iter()
            .any(|e| matches!(e, KernelEvent::TitleChanged { title, .. } if title == "Named"))
    );
    let view = built.session.view().await.unwrap();
    assert_eq!(
        texts(&view.messages),
        [
            "first",
            "Operation stopped by hook",
            "second",
            "extra context"
        ]
    );
    let request = &model.requests()[0];
    assert_eq!(request.messages.len(), 1, "user turn merged for the API");
    let payload = &hooks.seen()[1].payload;
    assert_eq!(payload["prompt"], "second");
    assert_eq!(hooks.seen()[1].context.mode, Some(view.mode));
}

/// hook 跑很久时 actor 照常响应：view 可用；中断后输入照常落库，接着是中断标记，不调模型（修复线 F37：以前输入
/// 不落库，用户刚发的消息没了；处理输入之后不看中止，early_interrupt_tests.rs）。
#[tokio::test]
async fn an_interrupt_during_the_prompt_hook_keeps_the_input() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["unused"])]));
    let gate = Arc::new(Notify::new());
    let hooks = ScriptedHooks {
        gate: Some(gate),
        ..ScriptedHooks::default()
    };
    hooks.set(HookEventName::UserPromptSubmit, HookOutcome::default());
    let mut setup = Setup::new(model.clone());
    setup.hooks = Arc::new(hooks);
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "slow")).await;
    until(&mut events, |e| {
        matches!(e, KernelEvent::TurnStarted { .. })
    })
    .await;
    let view = built.session.view().await.unwrap();
    assert!(view.running && view.messages.is_empty());
    built.session.send(envelope("c2", Command::Interrupt)).await;
    let seen = until(&mut events, finished).await;
    assert!(matches!(
        seen.last(),
        Some(KernelEvent::TurnFinished {
            outcome: TurnOutcome::Interrupted,
            ..
        })
    ));
    assert_eq!(
        texts(&built.session.view().await.unwrap().messages),
        ["slow", "[Request interrupted by user]"]
    );
    assert!(model.requests().is_empty());
}

/// SessionStart：hook 消息排在第一条输入之前，`initial_user_message` 作为第一条输入；启动期间的
/// 输入排在它后面。
#[tokio::test]
async fn session_start_messages_come_before_the_first_input() {
    let model = Arc::new(ScriptedModel::new(vec![
        text_response(&["one"]),
        text_response(&["two"]),
    ]));
    let hooks = Arc::new(ScriptedHooks::with(
        HookEventName::SessionStart,
        HookOutcome {
            messages: vec![meta_message("msg_s1", "start context")],
            initial_user_message: Some("from hook".into()),
            ..HookOutcome::default()
        },
    ));
    let mut setup = Setup::new(model.clone());
    setup.hooks = hooks.clone();
    setup.start = StartSource::Clear;
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "typed")).await;
    until(&mut events, finished).await;
    until(&mut events, finished).await;
    let view = built.session.view().await.unwrap();
    assert_eq!(
        texts(&view.messages),
        ["start context", "from hook", "typed"]
    );
    let start = &hooks.seen()[0];
    assert_eq!(start.name, HookEventName::SessionStart);
    assert_eq!(start.payload["source"], "clear");
    assert_eq!(start.payload["model"], "scripted");
    assert_eq!(model.requests().len(), 2);
}

/// SessionEnd 在调用方的任务里跑，返回失败的 hook 的提示。
#[tokio::test]
async fn closing_runs_session_end_with_the_reason() {
    let model = Arc::new(ScriptedModel::new(Vec::new()));
    let hooks = Arc::new(ScriptedHooks::with(
        HookEventName::SessionEnd,
        HookOutcome {
            notices: vec!["SessionEnd hook [x] failed: boom".into()],
            ..HookOutcome::default()
        },
    ));
    let mut setup = Setup::new(model);
    setup.hooks = hooks.clone();
    let built = setup.build().await;
    let notices = built.session.close(EndReason::PromptInputExit).await;
    assert_eq!(notices, ["SessionEnd hook [x] failed: boom"]);
    assert_eq!(hooks.seen()[0].payload["reason"], "prompt_input_exit");
}

/// 输入在回合任务里提交（UserPromptSubmit 之后）：提交失败以 `TurnFinished(Failed)` 报告，
/// 输入不进历史。
#[tokio::test]
async fn a_failed_commit_fails_the_turn_without_the_input() {
    let mut setup = Setup::new(Arc::new(ScriptedModel::new(Vec::new())));
    setup.stored = false;
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    assert!(matches!(
        built.session.send(submit("c1", "hello")).await,
        rust_cli_kernel_api::session_api::Ack::Accepted { .. }
    ));
    let seen = until(&mut events, finished).await;
    assert!(matches!(
        seen.last(),
        Some(KernelEvent::TurnFinished {
            outcome: TurnOutcome::Failed { .. },
            ..
        })
    ));
    assert!(built.session.view().await.unwrap().messages.is_empty());
}

/// 当步的 attachment 是 `turn`，每一步的上下文宣布是 `date`。
struct Phased;

#[async_trait::async_trait]
impl rust_cli_kernel_api::orchestration::ContextBuilder for Phased {
    async fn build(
        &self,
        _request: rust_cli_kernel_api::orchestration::ContextRequest,
        _history: &[Message],
    ) -> Result<
        rust_cli_kernel_api::orchestration::BuiltContext,
        rust_cli_kernel_api::orchestration::OrchestrationError,
    > {
        Ok(rust_cli_kernel_api::orchestration::BuiltContext {
            system: Vec::new(),
            attachments: vec![attachment("msg_date", "date")],
        })
    }

    async fn turn_attachments(
        &self,
        _request: rust_cli_kernel_api::orchestration::ContextRequest,
        _history: &[Message],
    ) -> Result<
        Vec<rust_cli_kernel_api::message::AttachmentMessage>,
        rust_cli_kernel_api::orchestration::OrchestrationError,
    > {
        Ok(vec![attachment("msg_turn", "total_tokens_reminder")])
    }
}

fn attachment(id: &str, source: &str) -> rust_cli_kernel_api::message::AttachmentMessage {
    rust_cli_kernel_api::message::AttachmentMessage {
        id: rust_cli_kernel_api::ids::MessageId::new(id),
        source: source.into(),
        text: format!("<system-reminder>\n{id}\n</system-reminder>"),
        data: serde_json::Value::Null,
    }
}

/// F10（hooks.md §7）：UserPromptSubmit 的附加上下文交给主循环，排在输入那一步的当步 attachment
/// 之后、上下文宣布之前（先产生输入的 attachment、再跑 UPS）。旧代码在提交输入时就提交 hook
/// 消息，排在当步 attachment 之前。
#[tokio::test]
async fn prompt_hook_context_follows_the_turn_attachments_of_the_input() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["ok"])]));
    let hooks = Arc::new(ScriptedHooks::with(
        HookEventName::UserPromptSubmit,
        HookOutcome {
            messages: vec![Message::Attachment(attachment(
                "msg_ups",
                "hook_additional_context",
            ))],
            ..HookOutcome::default()
        },
    ));
    let mut setup = Setup::new(model.clone());
    setup.hooks = hooks;
    setup.context = Some(Arc::new(Phased));
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "hello")).await;
    until(&mut events, finished).await;
    let view = built.session.view().await.unwrap();
    let ids: Vec<&str> = view
        .messages
        .iter()
        .map(|message| message.id().as_str())
        .collect();
    assert_eq!(ids[1..4], ["msg_turn", "msg_ups", "msg_date"], "{ids:?}");
}

/// A SessionStart additional-context attachment as the hook fold writes it (`hooks` `texts::additional_context`).
fn start_context(id: &str, text: &str) -> Message {
    Message::Attachment(rust_cli_kernel_api::message::AttachmentMessage {
        id: rust_cli_kernel_api::ids::MessageId::new(id),
        source: "hook_additional_context".into(),
        text: format!(
            "<system-reminder>\nSessionStart hook additional context: {text}\n</system-reminder>"
        ),
        data: serde_json::json!({
            "hookName": "SessionStart",
            "hookEvent": "SessionStart",
            "content": [text],
        }),
    })
}

fn start_outcome(messages: Vec<Message>, title: Option<&str>) -> HookOutcome {
    HookOutcome {
        messages,
        session_title: title.map(str::to_owned),
        ..HookOutcome::default()
    }
}

/// The additional-context attachments in order, as their full text.
fn context_texts(messages: &[Message]) -> Vec<String> {
    messages
        .iter()
        .filter_map(|message| match message {
            Message::Attachment(attachment) if attachment.source == "hook_additional_context" => {
                Some(attachment.text.clone())
            }
            _ => None,
        })
        .collect()
}

/// The startup title is set after the SessionStart result is kept, so seeing it means the result is held.
async fn wait_for_startup_title(session: &crate::Session, title: &str) {
    for _ in 0..500 {
        if session.view().await.unwrap().meta.title == title {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the startup title was never set");
}

/// Node keeps the SessionStart result in a pending slot until the first turn writes it
/// (`commitPendingSessionStartContext`): a prewarm has no conversation before its first input, so the desktop's
/// first send can adopt it. Before, the result was appended at creation and the adoption was refused.
#[tokio::test]
async fn a_session_start_result_is_held_until_the_first_input() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["one"])]));
    let mut setup = Setup::new(model.clone());
    setup.hooks = Arc::new(ScriptedHooks::with(
        HookEventName::SessionStart,
        start_outcome(
            vec![start_context("msg_s1", "start context")],
            Some("startup title"),
        ),
    ));
    let built = setup.build().await;
    wait_for_startup_title(&built.session, "startup title").await;
    let view = built.session.view().await.unwrap();
    assert!(view.messages.is_empty(), "{} stored", view.messages.len());
    assert!(model.requests().is_empty());
}

/// The first turn writes the held context before its input: the model request and the stored history both have
/// the context first.
#[tokio::test]
async fn the_first_turn_writes_the_held_context_before_its_input() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["one"])]));
    let mut setup = Setup::new(model.clone());
    setup.hooks = Arc::new(ScriptedHooks::with(
        HookEventName::SessionStart,
        start_outcome(vec![start_context("msg_s1", "start context")], None),
    ));
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "typed")).await;
    until(&mut events, finished).await;

    let request = serde_json::to_string(&model.requests()[0].messages).unwrap();
    let (context, input) = (request.find("start context"), request.find("typed"));
    assert!(
        matches!((context, input), (Some(c), Some(i)) if c < i),
        "{request}"
    );

    let messages = built.session.view().await.unwrap().messages;
    let position = |predicate: &dyn Fn(&Message) -> bool| messages.iter().position(predicate);
    let context = position(
        &|message| matches!(message, Message::Attachment(a) if a.text.contains("start context")),
    );
    let input = position(
        &|message| matches!(message, Message::User(user) if texts(std::slice::from_ref(message)) == ["typed"]),
    );
    assert!(
        matches!((context, input), (Some(c), Some(i)) if c < i),
        "{context:?} {input:?}"
    );
}

/// Node skips a SessionStart context equal to the latest one already in the history
/// (`commitPendingSessionStartContext`): a reopen whose hook output did not change adds nothing.
#[tokio::test]
async fn an_unchanged_session_start_context_is_not_written_again() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["one"])]));
    let mut setup = Setup::new(model.clone());
    setup.messages = vec![start_context("msg_old", "start context")];
    setup.start = StartSource::Resume;
    setup.hooks = Arc::new(ScriptedHooks::with(
        HookEventName::SessionStart,
        start_outcome(vec![start_context("msg_new", "start context")], None),
    ));
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "typed")).await;
    until(&mut events, finished).await;
    let contexts = context_texts(&built.session.view().await.unwrap().messages);
    assert_eq!(contexts.len(), 1, "{contexts:?}");
    assert!(contexts[0].contains("start context"));
}

/// A changed context is written after the earlier one: the dedup compares with the latest context only.
#[tokio::test]
async fn a_changed_session_start_context_is_written_after_the_earlier_one() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["one"])]));
    let mut setup = Setup::new(model.clone());
    setup.messages = vec![start_context("msg_old", "start context")];
    setup.start = StartSource::Resume;
    setup.hooks = Arc::new(ScriptedHooks::with(
        HookEventName::SessionStart,
        start_outcome(vec![start_context("msg_new", "newer context")], None),
    ));
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "typed")).await;
    until(&mut events, finished).await;
    let contexts = context_texts(&built.session.view().await.unwrap().messages);
    assert_eq!(contexts.len(), 2, "{contexts:?}");
    assert!(contexts[0].contains("start context") && contexts[1].contains("newer context"));
}
