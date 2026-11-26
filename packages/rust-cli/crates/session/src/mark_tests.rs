//! `Command::MarkMessage` (specs/fork-rust-feedback-and-pins.md): the real actor and main loop, one scripted turn, the
//! in-memory store keeping the committed facts.
use std::sync::Arc;

use rust_cli_kernel_api::ids::{MessageId, SessionId};
use rust_cli_kernel_api::message::Message;
use rust_cli_kernel_api::message_mark::{Feedback, MARK_STALE, Mark, MarkRequest};
use rust_cli_kernel_api::session_api::{Ack, Command, KernelEvent, SessionHandle};
use rust_cli_kernel_api::store::Fact;
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};

use crate::test_support::{Built, Setup, envelope, finished, submit, until};

/// One finished turn: the typed input and the assistant reply, their ids.
async fn after_one_turn() -> (Built, MessageId, MessageId) {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&["Done."])]));
    let built = Setup::new(model).build().await;
    let mut events = built.session.subscribe(None);
    built.session.send(submit("c1", "Hello")).await;
    until(&mut events, finished).await;
    let messages = built.session.view().await.unwrap().messages;
    let user = messages
        .iter()
        .find_map(|message| matches!(message, Message::User(_)).then(|| message.id().clone()))
        .unwrap();
    let assistant = messages
        .iter()
        .find_map(|message| matches!(message, Message::Assistant(_)).then(|| message.id().clone()))
        .unwrap();
    (built, user, assistant)
}

fn marked(built: &Built) -> Vec<Mark> {
    built
        .store
        .facts(&SessionId::new("sess_1"))
        .iter()
        .filter_map(|fact| match fact {
            Fact::MessageMarked { mark, .. } => Some(*mark),
            _ => None,
        })
        .collect()
}

async fn send(built: &Built, id: &str, message: &MessageId, request: MarkRequest) -> Ack {
    built
        .session
        .send(envelope(
            id,
            Command::MarkMessage {
                message: message.clone(),
                request,
            },
        ))
        .await
}

fn accepted(ack: &Ack) -> bool {
    matches!(ack, Ack::Accepted { .. })
}

#[tokio::test]
async fn feedback_is_set_changed_and_cleared() {
    let (built, _user, assistant) = after_one_turn().await;
    let mut events = built.session.subscribe(None);
    for (id, feedback) in [
        ("f1", Some(Feedback::Like)),
        ("f2", Some(Feedback::Dislike)),
        ("f3", None),
    ] {
        let ack = send(&built, id, &assistant, MarkRequest::Feedback(feedback)).await;
        assert!(accepted(&ack), "{ack:?}");
    }
    assert_eq!(
        marked(&built),
        [
            Mark::Feedback(Some(Feedback::Like)),
            Mark::Feedback(Some(Feedback::Dislike)),
            Mark::Feedback(None),
        ]
    );
    // The kernel event follows each commit, in order.
    let seen = std::cell::RefCell::new(Vec::new());
    until(&mut events, |event| {
        if let KernelEvent::MessageMarked { message, mark } = event {
            assert_eq!(message, &assistant);
            seen.borrow_mut().push(*mark);
        }
        seen.borrow().len() == 3
    })
    .await;
    let seen = seen.into_inner();
    assert_eq!(seen, marked(&built));
    // The same value again writes nothing.
    send(&built, "f4", &assistant, MarkRequest::Feedback(None)).await;
    assert_eq!(marked(&built).len(), 3);
}

#[tokio::test]
async fn the_view_keeps_the_marks_for_a_rebuild() {
    let (built, user, assistant) = after_one_turn().await;
    send(
        &built,
        "f1",
        &assistant,
        MarkRequest::Feedback(Some(Feedback::Like)),
    )
    .await;
    send(&built, "p1", &user, MarkRequest::Pin(true)).await;
    let marks = built.session.view().await.unwrap().marks;
    assert_eq!(marks[&assistant].feedback, Some(Feedback::Like));
    assert_eq!(marks[&user].pinned_at, Some(1_000));
    send(&built, "f2", &assistant, MarkRequest::Feedback(None)).await;
    send(&built, "p2", &user, MarkRequest::Pin(false)).await;
    assert!(built.session.view().await.unwrap().marks.is_empty());
}

#[tokio::test]
async fn a_pin_is_idempotent_and_stamped_by_the_clock() {
    let (built, _user, assistant) = after_one_turn().await;
    // Unpinning what is not pinned is a no-op.
    let ack = send(&built, "p0", &assistant, MarkRequest::Pin(false)).await;
    assert!(accepted(&ack), "{ack:?}");
    assert!(marked(&built).is_empty());
    let ack = send(&built, "p1", &assistant, MarkRequest::Pin(true)).await;
    assert!(accepted(&ack), "{ack:?}");
    // A repeat pin keeps the first time and writes nothing.
    let ack = send(&built, "p2", &assistant, MarkRequest::Pin(true)).await;
    assert!(accepted(&ack), "{ack:?}");
    assert_eq!(marked(&built), [Mark::Pinned(Some(1_000))]);
    let ack = send(&built, "p3", &assistant, MarkRequest::Pin(false)).await;
    assert!(accepted(&ack), "{ack:?}");
    assert_eq!(
        marked(&built),
        [Mark::Pinned(Some(1_000)), Mark::Pinned(None)]
    );
}

#[tokio::test]
async fn an_unknown_message_or_a_wrong_role_is_stale() {
    let (built, user, _assistant) = after_one_turn().await;
    let stale = Ack::Rejected {
        reason: MARK_STALE.to_owned(),
    };
    let gone = MessageId::new("gone");
    assert_eq!(
        send(&built, "s1", &gone, MarkRequest::Pin(true)).await,
        stale
    );
    assert_eq!(
        send(
            &built,
            "s2",
            &gone,
            MarkRequest::Feedback(Some(Feedback::Like))
        )
        .await,
        stale
    );
    // Feedback needs an assistant reply.
    assert_eq!(
        send(
            &built,
            "s3",
            &user,
            MarkRequest::Feedback(Some(Feedback::Like))
        )
        .await,
        stale
    );
    assert!(marked(&built).is_empty());
}
