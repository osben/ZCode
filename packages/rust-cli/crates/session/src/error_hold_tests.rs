//! Fork: a failed main-loop turn holds the queued inputs on the desktop (Node core `queueAutoDrain = false` on a
//! turn error, specs/fork-rust-agent-parity.md "A failed turn pauses the queue"); releasing the hold starts the head.

use std::sync::Arc;

use rust_cli_kernel_api::model::ModelError;
use rust_cli_kernel_api::session_api::{Ack, Command, KernelEvent, SessionHandle};
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};
use tokio::sync::Notify;

use crate::test_support::{Setup, envelope, finished, submit, until};

/// The first request waits for the gate and then fails; the next one answers.
fn failing_first(gate: Arc<Notify>) -> Arc<ScriptedModel> {
    Arc::new(
        ScriptedModel::new(vec![
            vec![Err(ModelError::Protocol {
                message: "upstream 500".to_owned(),
            })],
            text_response(&["after"]),
        ])
        .gated_at(0, gate),
    )
}

fn sent(model: &ScriptedModel, text: &str) -> bool {
    model
        .requests()
        .iter()
        .any(|request| format!("{:?}", request.messages).contains(text))
}

fn started(event: &KernelEvent) -> bool {
    matches!(event, KernelEvent::TurnStarted { .. })
}

fn failed(event: &KernelEvent) -> bool {
    matches!(
        event,
        KernelEvent::TurnFinished {
            outcome: rust_cli_kernel_api::session_api::TurnOutcome::Failed { .. },
            ..
        }
    )
}

#[tokio::test]
async fn a_failed_desktop_turn_holds_the_queue_until_it_is_released() {
    let gate = Arc::new(Notify::new());
    let model = failing_first(gate.clone());
    let mut setup = Setup::new(model.clone());
    setup.error_holds_queue = true;
    let built = setup.build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "first")).await;
    until(&mut events, started).await;
    built.session.send(submit("c2", "queued after error")).await;
    gate.notify_one();
    until(&mut events, failed).await;
    // The failed turn did not start the queued input: it waits, the session is idle, the model saw one request.
    let view = built.session.view().await.unwrap();
    assert_eq!(
        view.queue
            .iter()
            .map(|q| q.text.as_str())
            .collect::<Vec<_>>(),
        ["queued after error"]
    );
    assert!(!view.running);
    assert_eq!(model.requests().len(), 1);
    // Continue (`setAutoDrain(true)` → `HoldQueue { held: false }`) starts the head.
    let ack = built
        .session
        .send(envelope("c3", Command::HoldQueue { held: false }))
        .await;
    assert!(matches!(ack, Ack::Accepted { .. }), "{ack:?}");
    until(&mut events, finished).await;
    assert!(sent(&model, "queued after error"));
    assert!(built.session.view().await.unwrap().queue.is_empty());
}

#[tokio::test]
async fn without_the_desktop_flag_a_failed_turn_drains_the_queue() {
    let gate = Arc::new(Notify::new());
    let model = failing_first(gate.clone());
    let built = Setup::new(model.clone()).build().await;
    let mut events = built.session.subscribe(Some(0));
    built.session.send(submit("c1", "first")).await;
    until(&mut events, started).await;
    built.session.send(submit("c2", "queued after error")).await;
    gate.notify_one();
    until(&mut events, failed).await;
    until(&mut events, finished).await;
    assert!(sent(&model, "queued after error"));
}
