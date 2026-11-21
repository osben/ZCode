//! W9b-2 (9.57, divergence 801): an input admitted behind a running turn stays in the queue when the queue is held
//! before that turn ends. Nothing runs, and the input has not started. A start must count it as busy (Node
//! `hasActiveOrQueuedTurnWork`), so the busy answer covers the queued input.

use std::sync::Arc;
use std::time::Duration;

use rust_cli_kernel_api::session_api::{Ack, Command, SessionHandle};
use rust_cli_kernel_api::testing::{ScriptedModel, text_response};
use tokio::sync::Notify;

use crate::test_support::{Setup, envelope, submit};

#[tokio::test]
async fn an_admitted_turn_held_in_the_queue_is_busy_for_a_start() {
    let gate = Arc::new(Notify::new());
    let model = Arc::new(
        ScriptedModel::new(vec![
            text_response(&["first reply"]),
            text_response(&["queued reply"]),
        ])
        .gated_at(0, gate.clone()),
    );
    let built = Setup::new(model.clone()).build().await;
    let session = &built.session;
    session.send(submit("c1", "first")).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while model.requests().is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the first turn reached the model");

    let ack = session.send(submit("c2", "second")).await;
    assert!(
        matches!(ack, Ack::Accepted { .. }),
        "a submit behind a running turn is accepted"
    );
    session
        .send(envelope("hold", Command::HoldQueue { held: true }))
        .await;
    gate.notify_one();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let view = session.view().await.unwrap();
            if !view.running && view.queue.len() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the first turn ends and the held input stays queued");

    let view = session.view().await.unwrap();
    assert!(!view.running, "no turn runs while the queue is held");
    assert_eq!(view.queue.len(), 1, "the admitted input has not started");
    assert!(
        session.busy().await.unwrap(),
        "an admitted turn that has not started is busy for a start"
    );
    assert_eq!(
        model.requests().len(),
        1,
        "only the first turn reached the model"
    );

    session
        .send(envelope("release", Command::HoldQueue { held: false }))
        .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while session.busy().await.unwrap() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the released turn ends and the session is free");
    assert_eq!(
        model.requests().len(),
        2,
        "the queued turn ran after the release"
    );
}
