//! Fork: an App input's quotes travel in its input intent (specs/fork-agent-runtime-selection.md, Conversation
//! quotes in Rust mode): the UserPromptSubmit hook sees the typed text only, the quote block joins the input after
//! that, the committed message carries the intent, and a queue edit keeps the quotes.

use std::sync::Arc;

use rust_cli_kernel_api::hooks::{HookEventName, HookOutcome};
use rust_cli_kernel_api::input_intent::InputIntent;
use rust_cli_kernel_api::message::{ContentBlock, Message};
use rust_cli_kernel_api::session_api::{QueuedKind, SessionHandle};
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};
use serde_json::json;

use super::*;
use crate::test_support::{ScriptedHooks, Setup, finished, until};

const BLOCK: &str = "<conversation_quote>\n[{\"text\":\"quoted line\"}]\n</conversation_quote>";

fn intent(text: &str) -> Box<InputIntent> {
    Box::new(
        serde_json::from_value(json!({
            "conversationQuotes": [{"text": "quoted line"}],
            "sourceCommandId": "c",
            "text": text,
        }))
        .unwrap(),
    )
}

fn quoted(id: &str, text: &str) -> CommandEnvelope {
    CommandEnvelope {
        id: CommandId::new(id),
        command: Command::SubmitWith {
            kind: QueuedKind::Text,
            text: text.to_owned(),
            content: Vec::new(),
            delivery: Delivery::Queue,
            execution: None,
            behind_held: false,
            intent: Some(intent(text)),
        },
    }
}

fn user_texts(messages: &[Message]) -> Vec<(String, Option<InputIntent>)> {
    messages
        .iter()
        .filter_map(|message| match message {
            Message::User(user) => match user.content.first() {
                Some(ContentBlock::Text { text }) => {
                    Some((text.clone(), user.intent.as_deref().cloned()))
                }
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// Node composes the quotes into `expandedInput` (`turn.ts`): the hook's prompt is the typed text, the model and
/// the stored message read the text with the block, and the message keeps the intent.
#[tokio::test]
async fn the_prompt_hook_sees_the_typed_text_and_the_model_the_quotes() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["ok"])]));
    let hooks = Arc::new(ScriptedHooks::with(
        HookEventName::UserPromptSubmit,
        HookOutcome::default(),
    ));
    let mut setup = Setup::new(model.clone());
    setup.hooks = hooks.clone();
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(quoted("c1", "explain this")).await;
    until(&mut events, finished).await;
    let prompts: Vec<_> = hooks
        .seen()
        .into_iter()
        .filter(|event| event.name == HookEventName::UserPromptSubmit)
        .map(|event| event.payload["prompt"].clone())
        .collect();
    assert_eq!(prompts, [json!("explain this")]);
    let composed = format!("explain this\n\n{BLOCK}");
    assert!(format!("{:?}", model.requests()[0].messages).contains(&format!("{composed:?}")));
    let messages = built.session.view().await.unwrap().messages;
    assert_eq!(
        user_texts(&messages),
        [(composed, Some(*intent("explain this")))]
    );
}

/// Node `editPendingInputById`: an edit replaces the typed text and the intent's `text`; the quotes stay and reach
/// the model with the new text.
#[tokio::test]
async fn a_queue_edit_keeps_the_quotes() {
    let scope = TaskScope::root("test", |_| {});
    let (_store, model, session) = asking_session(&scope).await;
    let mut events = session.subscribe(Some(0));
    session.send(submit("c1", "ask me")).await;
    let interaction = asked(&mut events).await;
    session.send(quoted("c2", "first")).await;
    session
        .send(CommandEnvelope {
            id: CommandId::new("c3"),
            command: Command::EditQueued {
                command: CommandId::new("c2"),
                text: "CHANGED".to_owned(),
            },
        })
        .await;
    let queue = session.view().await.unwrap().queue;
    assert_eq!(queue[0].text, "CHANGED");
    assert_eq!(queue[0].intent.as_deref(), Some(&*intent("CHANGED")));
    session.send(answer("c4", interaction)).await;
    until_finished(&mut events, 2).await;
    let composed = format!("CHANGED\n\n{BLOCK}");
    let sent = format!("{:?}", model.requests().last().unwrap().messages);
    assert!(sent.contains(&format!("{composed:?}")), "{sent}");
}
