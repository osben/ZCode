use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use rust_cli_kernel_api::agents::{ChildLive, ChildLiveFeed};
use rust_cli_kernel_api::ids::MessageId;
use rust_cli_kernel_api::message::{AssistantMessage, ContentBlock, Message};
use rust_cli_kernel_api::model::BlockDelta;
use rust_cli_kernel_api::orchestration::QueryEvent;
use rust_cli_kernel_api::session_api::{
    Ack, Command, Delivery, KernelEvent, SessionHandle, TurnOutcome,
};
use rust_cli_kernel_api::store::SessionStore;
use rust_cli_kernel_api::testing::ScriptedModel;
use tokio::sync::mpsc;

use crate::test_support::{Setup, envelope};

fn started() -> ChildLive {
    ChildLive::Started {
        run: 1,
        selection: rust_cli_kernel_api::model::ModelSelection {
            provider: "p".to_owned(),
            model: "m".to_owned(),
            reasoning: None,
            connection: None,
        },
    }
}

fn delta(text: &str) -> ChildLive {
    ChildLive::Event(QueryEvent::Delta {
        message: 0,
        index: 0,
        delta: BlockDelta::Text(text.to_owned()),
    })
}

fn assistant(id: &str) -> Message {
    Message::Assistant(AssistantMessage {
        id: MessageId::new(id),
        content: vec![ContentBlock::Text {
            text: id.to_owned(),
        }],
        model: "m".to_owned(),
        stop_reason: None,
        usage: None,
    })
}

async fn next(
    events: &mut futures_util::stream::BoxStream<
        'static,
        rust_cli_kernel_api::session_api::SequencedEvent,
    >,
) -> KernelEvent {
    tokio::time::timeout(Duration::from_secs(5), events.next())
        .await
        .expect("an event")
        .expect("the stream is open")
        .event
}

/// A side tab opened after the child run streamed part of its reply sees that part, then the rest, then the stored
/// message and the turn end, all after the view it read; a submit meanwhile is refused.
#[tokio::test]
async fn a_late_view_streams_the_child_run_so_far_and_then_live() {
    let (live, receiver) = mpsc::unbounded_channel();
    let mut setup = Setup::new(Arc::new(ScriptedModel::new(Vec::new())));
    setup.child_live = Some(ChildLiveFeed {
        replay: vec![started(), delta("E2E_SIDE_TAB_CHILD_1_")],
        live: tokio_stream_from(receiver),
    });
    let built = setup.build().await;
    let session = &built.session;

    let view = session.view().await.unwrap();
    assert!(view.messages.is_empty());
    let mut events = session.subscribe(Some(view.last_seq));
    let mirrored = match next(&mut events).await {
        KernelEvent::TurnStarted { turn, .. } => turn,
        other => panic!("expected the mirrored turn, got {other:?}"),
    };
    match next(&mut events).await {
        KernelEvent::StreamDelta { delta, .. } => {
            assert_eq!(delta, BlockDelta::Text("E2E_SIDE_TAB_CHILD_1_".to_owned()));
        }
        other => panic!("expected the partial text, got {other:?}"),
    }
    let running = session.view().await.unwrap();
    assert!(running.running);
    // A projection rebuilt from this view keys the running turn like the mirrored events.
    assert_eq!(running.running_turn, Some(mirrored));
    let ack = session
        .send(envelope(
            "c1",
            Command::Submit {
                text: "hi".to_owned(),
                attachments: Vec::new(),
                delivery: Delivery::Queue,
            },
        ))
        .await;
    assert!(matches!(ack, Ack::Rejected { .. }), "{ack:?}");

    live.send(delta("DONE")).unwrap();
    live.send(ChildLive::Committed(assistant("a1"))).unwrap();
    live.send(ChildLive::Finished(TurnOutcome::Success))
        .unwrap();
    assert!(matches!(
        next(&mut events).await,
        KernelEvent::StreamDelta { .. }
    ));
    match next(&mut events).await {
        KernelEvent::MessageDone { message } => assert_eq!(message.id().as_str(), "a1"),
        other => panic!("expected the stored message, got {other:?}"),
    }
    assert!(matches!(
        next(&mut events).await,
        KernelEvent::TurnFinished {
            outcome: TurnOutcome::Success,
            ..
        }
    ));
    let view = session.view().await.unwrap();
    assert!(!view.running);
    assert_eq!(view.running_turn, None);
    assert_eq!(view.messages.len(), 1);
    // Mirrored, not stored again: the child run stored it.
    assert!(
        built
            .store
            .load(&view.meta.id)
            .await
            .unwrap()
            .messages
            .is_empty()
    );
}

/// A child session opened while its run is live ends on the run's unanswered input: that is the running run, not an
/// interruption, so no resume sentinel (`No response requested.`) is added next to the streamed reply.
#[tokio::test]
async fn a_cold_load_during_the_child_run_adds_no_resume_sentinel() {
    let (_live, receiver) = mpsc::unbounded_channel();
    let mut setup = Setup::new(Arc::new(ScriptedModel::new(Vec::new())));
    setup.opened = crate::Opened::Loaded;
    setup.messages = vec![Message::User(rust_cli_kernel_api::message::UserMessage {
        stall_execution: None,
        intent: None,
        id: MessageId::new("u1"),
        content: vec![ContentBlock::Text {
            text: "E2E_SIDE_TAB_CHILD_1: read the file".to_owned(),
        }],
        origin: rust_cli_kernel_api::message::UserOrigin::Human,
    })];
    setup.child_live = Some(ChildLiveFeed {
        replay: vec![started(), delta("E2E_SIDE_TAB_CHILD_1_")],
        live: tokio_stream_from(receiver),
    });
    let built = setup.build().await;
    let view = built.session.view().await.unwrap();
    assert_eq!(
        view.messages
            .iter()
            .map(|m| m.id().as_str().to_owned())
            .collect::<Vec<_>>(),
        ["u1"]
    );
    // The feed is attached after the first view.
    assert!(built.session.view().await.unwrap().running);
}

fn tokio_stream_from(
    receiver: mpsc::UnboundedReceiver<ChildLive>,
) -> futures_util::stream::BoxStream<'static, ChildLive> {
    futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|event| (event, receiver))
    })
    .boxed()
}
